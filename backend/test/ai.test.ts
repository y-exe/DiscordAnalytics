/** AI機能 (/ai/*) とツールのテスト */
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

// 既定のenv (他のテストファイルと同じ値)。GUILD_ID等のAI固有値は各テスト内で設定する
process.env.DB_DSN = "postgresql://user:password@127.0.0.1:5432/test";
process.env.API_SECRET = "a".repeat(32);
process.env.ADMIN_SESSION_SECRET = "c".repeat(32);
process.env.ADMIN_PASSWORD_HASH =
  "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.ENABLE_API_DOCS = "false";

const config = await import("../src/config");
const { SafeDiskCache } = await import("../src/safeCache");
const adminAuth = await import("../src/adminAuth");
const { createApp } = await import("../src/api");
const { validateReadOnlySql } = await import("../src/ai/tools");
const { sanitizeHistory, MAX_HISTORY_MESSAGES } = await import("../src/ai/chatService");
const { createAdminSession, ADMIN_COOKIE_NAME } = adminAuth;

type AppDeps = Parameters<typeof createApp>[0];

/** AI機能を有効にしたenvを設定し、復元関数を返す (テスト間のenv漏洩を防ぐ) */
function withAiEnv(): () => void {
  const saved = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_REQUIRE_ADMIN: process.env.AI_REQUIRE_ADMIN,
    AI_RATE_LIMIT_PER_10MIN: process.env.AI_RATE_LIMIT_PER_10MIN,
    AI_DAILY_LIMIT_PER_IP: process.env.AI_DAILY_LIMIT_PER_IP,
    AI_DAILY_LIMIT_GLOBAL: process.env.AI_DAILY_LIMIT_GLOBAL,
    AI_ENABLED: process.env.AI_ENABLED,
    GUILD_ID: process.env.GUILD_ID,
  };
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.AI_BASE_URL = "https://ai.test.invalid";
  process.env.AI_RATE_LIMIT_PER_10MIN = "20";
  process.env.AI_DAILY_LIMIT_PER_IP = "100";
  process.env.AI_DAILY_LIMIT_GLOBAL = "1000";
  delete process.env.AI_REQUIRE_ADMIN; // 既定 (一般開放) に揃える
  delete process.env.AI_ENABLED; // 既定 (有効) に揃える
  process.env.GUILD_ID = "987654321";
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeGuildRow(guildId: string) {
  return {
    guild_id: guildId,
    name: "テストサーバー",
    king_role_id: null,
    excluded_channel_ids: [],
    display_config: {
      whitelistChannelIds: [],
      privateChatCategoryIds: [],
      bottomChannelCategoryIds: [],
    },
    domains: [],
  };
}

/** ギルド解決など最低限のクエリに応答するテスト用Poolスタブ (履歴のDB保存はもう無い) */
function stubPool(): Pool {
  return {
    query: async (sql: unknown) => {
      const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? "");
      if (text.includes("FROM guilds ")) return { rows: [fakeGuildRow("987654321")] };
      if (text.includes("FROM guild_domains")) return { rows: [] };
      if (text.includes("FROM information_schema.columns")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
}

async function buildTestApp(): Promise<{
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}> {
  const { SafeDiskCache: Cache } = await import("../src/safeCache");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-test-"));
  const cache = new Cache(directory, 1024 * 1024);
  const cfg = await config.loadConfig();
  const app = createApp({
    config: cfg,
    cache,
    getPool: () => stubPool(),
    consumeLoginLimits: async () => true,
    verifyAdminPassword: async () => false,
  });
  return {
    app,
    cleanup: async () => {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("db_queryは読み取り専用クエリのみ許可する", () => {
  assert.equal(validateReadOnlySql("SELECT count(*) FROM messages"), null);
  assert.equal(validateReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t"), null);
  assert.notEqual(validateReadOnlySql("DELETE FROM messages"), null);
  assert.notEqual(validateReadOnlySql("INSERT INTO messages VALUES (1)"), null);
  assert.notEqual(validateReadOnlySql("UPDATE messages SET char_count = 0"), null);
  assert.notEqual(validateReadOnlySql("SELECT 1; DROP TABLE messages"), null);
  assert.notEqual(validateReadOnlySql("SELECT 1; SELECT 2"), null); // 複数ステートメント禁止
  assert.equal(validateReadOnlySql("SELECT 1;"), null);
  assert.notEqual(validateReadOnlySql("SELECT pg_read_file('/etc/passwd')"), null);
  assert.notEqual(
    validateReadOnlySql("SELECT set_config('default_transaction_read_only','off',false)"),
    null,
  );
  assert.notEqual(validateReadOnlySql("COPY messages TO '/tmp/x'"), null);
});

test("履歴は件数・文字数上限で切り詰められる", () => {
  // 正常系: user/assistantの交互履歴がそのまま通る
  const history = sanitizeHistory([
    { role: "user", content: "こんにちは" },
    { role: "assistant", content: "どうも" },
  ]);
  assert.ok(Array.isArray(history));
  assert.equal(history.length, 2);
  // 不正な型はエラー文字列
  assert.equal(sanitizeHistory("hello"), "history must be an array");
  assert.equal(sanitizeHistory([{ role: "system", content: "x" }]).length, 0);
  assert.equal(sanitizeHistory([{ role: "user", content: 123 }]).length, 0);
  // 件数上限: 新しいものを残す
  const many = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));
  const trimmed = sanitizeHistory(many) as { content: string }[];
  assert.equal(trimmed.length, MAX_HISTORY_MESSAGES);
  assert.equal(trimmed[trimmed.length - 1].content, `m${many.length - 1}`);
  // 1件あたりの文字数上限
  const long = sanitizeHistory([{ role: "user", content: "あ".repeat(9999) }]) as {
    content: string;
  }[];
  assert.ok(long[0].content.length <= 4000);
});

test("AI機能を無効化 (AI_ENABLED=false) すると/aiは503を返す", async () => {
  const restore = withAiEnv();
  process.env.AI_ENABLED = "false";
  try {
    const { app, cleanup } = await buildTestApp();
    try {
      const response = await app.request("/ai/status");
      assert.equal(response.status, 503);
    } finally {
      await cleanup();
    }
  } finally {
    restore();
  }
});

test("AI_REQUIRE_ADMIN=trueなら管理者セッションなしの/aiは403を返す", async () => {
  const restore = withAiEnv();
  process.env.AI_REQUIRE_ADMIN = "true";
  const cfg = await config.loadConfig();
  const token = createAdminSession(cfg.adminSessionSecret, Math.floor(Date.now() / 1000));
  const { app, cleanup } = await buildTestApp();
  try {
    const response = await app.request("/ai/status");
    assert.equal(response.status, 403);
    // 有効なセッションなら通る
    const ok = await app.request("/ai/status", {
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` },
    });
    assert.equal(ok.status, 200);
  } finally {
    await cleanup();
    restore();
  }
});

test("一般開放時はセッションなしで/ai/statusが200を返す", async () => {
  const restore = withAiEnv();
  const { app, cleanup } = await buildTestApp();
  try {
    const response = await app.request("/ai/status");
    assert.equal(response.status, 200);
  } finally {
    await cleanup();
    restore();
  }
});

test("連投は短時間上限で429になる", async () => {
  const restore = withAiEnv();
  const cfg = await config.loadConfig();
  assert.equal(cfg.ai.rateLimitPer10Min, 20);
  const { app, cleanup } = await buildTestApp();
  const stub = stubDeepSeekFetch([
    JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
    "data: [DONE]",
  ]);
  try {
    let lastStatus = 0;
    for (let i = 0; i <= cfg.ai.rateLimitPer10Min; i++) {
      const response = await app.request("/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `テスト${i}` }),
      });
      lastStatus = response.status;
      if (i < cfg.ai.rateLimitPer10Min) {
        assert.equal(response.status, 200);
        await response.text();
      }
    }
    assert.equal(lastStatus, 429);
  } finally {
    stub.restore();
    await cleanup();
    restore();
  }
});

/** DeepSeek APIのSSEレスポンスを擬似的に返すfetchスタブ */
function stubDeepSeekFetch(responses: string[]): {
  restore: () => void;
  calls: string[];
  bodies: string[];
} {
  const original = globalThis.fetch;
  let index = 0;
  const calls: string[] = [];
  const bodies: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return original(input, init);
    calls.push(url);
    if (init?.body) bodies.push(String(init.body));
    const body = responses[Math.min(index, responses.length - 1)];
    index++;
    const sse = body
      .split("\n")
      .map((line) => `data: ${line}\n\n`)
      .join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls, bodies };
}

test("/ai/chatがSSEで応答し、クライアント送信の履歴を文脈に使う", async () => {
  const restore = withAiEnv();
  const cfg = await config.loadConfig();
  const token = createAdminSession(cfg.adminSessionSecret, Math.floor(Date.now() / 1000));
  const { app, cleanup } = await buildTestApp();
  const stub = stubDeepSeekFetch([
    '{"choices":[{"delta":{"content":"こんにちは"}}]}',
    "data: [DONE]",
  ]);
  try {
    const response = await app.request("/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${ADMIN_COOKIE_NAME}=${token}`,
      },
      body: JSON.stringify({
        message: "続きを教えて",
        history: [
          { role: "user", content: "最初の質問" },
          { role: "assistant", content: "最初の回答" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
    const text = await response.text();
    assert.ok(text.includes('"type":"start"'));
    assert.ok(text.includes('"type":"delta"'));
    assert.ok(text.includes("こんにちは"));
    assert.ok(text.includes('"type":"done"'));
    assert.equal(stub.calls.length, 1);
    // DeepSeekに送るmessagesにクライアント履歴が含まれていること
    const sent = JSON.parse(stub.bodies[0] ?? "{}") as { messages?: { role: string }[] };
    const roles = (sent.messages ?? []).map((m) => m.role);
    assert.ok(roles.filter((r) => r === "user").length === 2); // 履歴+今回分
    assert.ok(roles.includes("assistant"));
  } finally {
    stub.restore();
    await cleanup();
    restore();
  }
});

test("/ai/chatがツール呼び出しを1ラウンド実行して回答する", async () => {
  const restore = withAiEnv();
  const cfg = await config.loadConfig();
  const token = createAdminSession(cfg.adminSessionSecret, Math.floor(Date.now() / 1000));
  const { app, cleanup } = await buildTestApp();
  const toolCall = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call1",
              function: { name: "db_query", arguments: '{"sql":"SELECT count(*) FROM messages"}' },
            },
          ],
        },
      },
    ],
  });
  const final = JSON.stringify({ choices: [{ delta: { content: "合計は0件です" } }] });
  const stub = stubDeepSeekFetch([toolCall, final, "data: [DONE]"]);
  try {
    const response = await app.request("/ai/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${ADMIN_COOKIE_NAME}=${token}`,
      },
      body: JSON.stringify({ message: "発言数は?" }),
    });
    const text = await response.text();
    // db_queryの実行がSSEに現れ、その後の最終回答まで進むこと (2回目のAPI呼び出し)
    assert.ok(text.includes('"type":"tool"'));
    assert.ok(text.includes("db_query"));
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
    await cleanup();
    restore();
  }
});

test("historyの型が不正な場合は422になる", async () => {
  const restore = withAiEnv();
  const cfg = await config.loadConfig();
  const token = createAdminSession(cfg.adminSessionSecret, Math.floor(Date.now() / 1000));
  const { app, cleanup } = await buildTestApp();
  try {
    const response = await app.request("/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${ADMIN_COOKIE_NAME}=${token}` },
      body: JSON.stringify({ message: "テスト", history: "履歴ではなく文字列" }),
    });
    assert.equal(response.status, 422);
  } finally {
    await cleanup();
    restore();
  }
});
