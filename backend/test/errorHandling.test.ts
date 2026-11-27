import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

process.env.DB_DSN = "postgresql://user:password@127.0.0.1:5432/test";
process.env.API_SECRET = "a".repeat(32);
process.env.ADMIN_SESSION_SECRET = "b".repeat(32);
process.env.ADMIN_PASSWORD_HASH =
  "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const { createApp } = await import("../src/api");
type AppDeps = Parameters<typeof createApp>[0];
const { SafeDiskCache } = await import("../src/safeCache");
const config = await import("../src/config");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

async function buildAppWithPool(pool: Partial<Pool>): Promise<ReturnType<typeof createApp>> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ymkw-err-test-"));
  const cache = new SafeDiskCache(directory, 1024 * 1024);
  const cfg = await config.loadConfig();
  const deps: AppDeps = {
    config: cfg,
    cache,
    getPool: () => pool as Pool,
    consumeLoginLimits: async () => true,
    verifyAdminPassword: async () => false,
  };
  return createApp(deps);
}

test("未処理例外は500 + error_idのみを返し、内部情報 (例外クラス名) を漏らさない", async () => {
  // queryが必ず失敗するpool → ルート内で未処理例外 → ミドルウェアが500に変換する
  const throwingPool = {
    query: async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'rows')");
    },
  } as unknown as Pool;
  const app = await buildAppWithPool(throwingPool);
  const response = await app.request("/stats/analysis/total", {
    headers: { host: "analytics.ymkw.top" },
  });
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    detail: string;
    error_id?: string;
    error_type?: string;
  };
  assert.equal(body.detail, "Internal Server Error");
  // 相関用のエラーID (8桁hex) が返る
  assert.match(body.error_id ?? "", /^[0-9a-f]{8}$/);
  // 例外クラス名 (TypeError等) は漏らさない
  assert.equal(body.error_type, undefined);
});

test("エラーIDはリクエストごとに異なる (相関できる)", async () => {
  const throwingPool = {
    query: async () => {
      throw new Error("boom");
    },
  } as unknown as Pool;
  const app = await buildAppWithPool(throwingPool);
  const r1 = await app.request("/stats/analysis/total", {
    headers: { host: "analytics.ymkw.top" },
  });
  const r2 = await app.request("/stats/history/total", {
    headers: { host: "analytics.ymkw.top" },
  });
  const b1 = (await r1.json()) as { error_id?: string };
  const b2 = (await r2.json()) as { error_id?: string };
  assert.notEqual(b1.error_id, b2.error_id);
});
