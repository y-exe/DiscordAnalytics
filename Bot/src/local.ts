import { mkdir, readFile, unlink, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { parse } from "dotenv";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".local", "dev");
const lockPath = join(dir, "run.lock");

/** ローカルPGliteでは用意できない拡張を要求するマイグレーションを除外する */
const SKIP_MIGRATIONS = new Set(["002_pg_stat_statements.sql"]);

interface MiniClient {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function applyMigrations(client: MiniClient): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  const done = new Set(rows.map((r) => String(r.filename)));
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(join(root, "..", "db", "migrations")))
    .filter((f) => f.endsWith(".sql") && !SKIP_MIGRATIONS.has(f))
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(root, "..", "db", "migrations", file), "utf8");
    // CONCURRENTLY系はトランザクション内で実行できないため、ローカルではラップしない
    await client.exec(sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    console.info(`マイグレーション適用: ${file}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--stop")) {
    let state: { pid: number; port: number; secret: string };
    try {
      state = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    } catch {
      throw new Error("ローカルBotは起動していません。");
    }
    const response = await fetch(`http://127.0.0.1:${state.port}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("ローカルBotを停止できませんでした。");
    console.info("ローカルBotの停止を受け付けました。");
    return;
  }

  let settings: Record<string, string>;
  try {
    settings = parse(await readFile(join(root, ".env.local"), "utf8"));
  } catch {
    throw new Error(
      ".env.local.exampleを.env.localへコピーし、テストBotのDISCORD_TOKENを設定してください。",
    );
  }
  const token = settings.DISCORD_TOKEN;
  if (!token) throw new Error(".env.localにテストBotのDISCORD_TOKENを設定してください。");

  // トークン先頭部はアプリケーションIDのbase64なので、そこから導出して表示する
  let applicationId = "";
  try {
    applicationId = Buffer.from(token.split(".")[0], "base64").toString("utf8");
  } catch {
    applicationId = "";
  }
  if (!/^\d{17,20}$/.test(applicationId))
    throw new Error("DISCORD_TOKENの形式が正しくありません。");

  await mkdir(dir, { recursive: true });
  try {
    const pid = Number(await readFile(lockPath, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive)
      throw new Error(
        "ローカルBotは起動済みです。停止する場合はbun run local:stopを使ってください。",
      );
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });

  const secret = randomBytes(32).toString("hex");
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      // shutdownが停滞しても停止処理自体は必ず進める
      await Promise.race([
        app?.shutdown().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      await socket?.stop();
      await dbClient?.close().catch(() => {});
      control.close();
      await rm(join(dir, "run.json"), { force: true });
      await rm(lockPath, { force: true });
    })());
  const control = createServer((request, result) => {
    if (
      request.method !== "POST" ||
      request.url !== "/stop" ||
      request.headers.authorization !== `Bearer ${secret}`
    ) {
      result.writeHead(404).end();
      return;
    }
    result.writeHead(202).end("stopping");
    void stop().then(() => process.exit(0));
  });
  const onSignal = (): void => {
    void stop().then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let dbClient: PGlite | undefined;
  let socket: PGLiteSocketServer | undefined;
  let app: { shutdown(): Promise<void> } | undefined;

  try {
    dbClient = await PGlite.create(join(dir, "pglite"), {
      extensions: { pg_trgm },
    });
    socket = new PGLiteSocketServer({
      db: dbClient,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 5,
    });
    await socket.start();
    const dsn = `postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;
    await applyMigrations(dbClient);

    // 環境変数を供給してBotを起動する (.env.localはdotenvに任せないで直接渡す)
    process.env.DISCORD_TOKEN = token;
    process.env.DB_DSN = dsn;
    // ローカルBotでは月間ロール管理を行わない (PGlite単一セッションではトランザクション中に
    // 他クエリが待たされるため、重い集計を含むロール管理がBot全体を凍結させる)
    process.env.DISABLE_MONTHLY_ROLE = "1";
    // ドメイン設定など本番インフラに依存する機能の無効化フラグ (config.tsのIS_LOCAL_BOT)
    process.env.BOT_ENV = "local";
    for (const key of ["GUILD_ID", "OWNER_ID", "SUBDOMAIN_BASE_DOMAIN", "SERVER_PUBLIC_IP"]) {
      if (settings[key] !== undefined) process.env[key] = settings[key];
    }
    const mod = await import("./main.js");
    const started = await (
      mod as { startBot(): Promise<{ shutdown(): Promise<void> }> }
    ).startBot();
    app = { shutdown: () => started.shutdown() };

    await new Promise<void>((done, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", done);
    });
    const address = control.address();
    if (!address || typeof address === "string")
      throw new Error("停止用ポートを開けませんでした。");
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        secret,
        applicationId,
      }),
      { mode: 0o600 },
    );
    console.info(
      `ローカル環境: テストBot ${applicationId} / PGlite .local/dev/pglite / 停止: bun run local:stop`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

const invokedDirectly =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ローカル環境を起動できませんでした。");
    process.exit(1);
  });
}
