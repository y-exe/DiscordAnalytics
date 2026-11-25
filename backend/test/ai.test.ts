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
    GUILD_ID: process.env.GUILD_ID,
  };
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.AI_BASE_URL = "https://ai.test.invalid";
  process.env.AI_RATE_LIMIT_PER_10MIN = "20";
  process.env.AI_DAILY_LIMIT_PER_IP = "100";
  process.env.AI_DAILY_LIMIT_GLOBAL = "1000";
  delete process.env.AI_REQUIRE_ADMIN; // 既定 (一般開放) に揃える
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

/** ギルド解決とai_*テーブル操作に応答するテスト用Poolスタブ */
function stubPool(): Pool {
  return {
    query: async (sql: unknown) => {
      const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? "");
      if (text.includes("FROM guilds ")) return { rows: [fakeGuildRow("987654321")] };
      if (text.includes("FROM guild_domains")) return { rows: [] };
      if (text.includes("FROM information_schema.columns")) return { rows: [] };
      if (text.includes("FROM ai_threads")) return { rows: [] };
      if (text.includes("FROM ai_messages")) return { rows: [] };
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
  assert.notEqual(validateReadOnlySql("COPY messages TO '/tmp/x'"), null);
});

test("AIキー未設定なら/aiは503を返す", async () => {
  const restore = withAiEnv();
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const { app, cleanup } = await buildTestApp();
    try {
      const response = await app.request("/ai/threads");
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
    const response = await app.request("/ai/threads");
    assert.equal(response.status, 403);
    // 有効なセッションなら通る
    const ok = await app.request("/ai/threads", {
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` },
    });
    assert.equal(ok.status, 200);
  } finally {
    await cleanup();
    restore();
  }
});

test("一般開放時はセッションなしでスレッド一覧を取得できる", async () => {
  const restore = withAiEnv();
  const { app, cleanup } = await buildTestApp();
  try {
    const response = await app.request("/ai/threads");
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

test("管理者セッションがあればスレッド一覧を取得できる", async () => {
  const restore = withAiEnv();
  const cfg = await config.loadConfig();
  const token = createAdminSession(cfg.adminSessionSecret, Math.floor(Date.now() / 1000));
  const { app, cleanup } = await buildTestApp();
  try {
    const response = await app.request("/ai/threads", {
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { threads: unknown[] };
    assert.deepEqual(body.threads, []);
  } finally {
    await cleanup();
    restore();
  }
});

/** DeepSeek APIのSSEレスポンスを擬似的に返すfetchスタブ */
function stubDeepSeekFetch(responses: string[]): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  let index = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return original(input, init);
    calls.push(url);
    const body = responses[Math.min(index, responses.length - 1)];
    index++;
    const sse = body
      .split("\n")
      .map((line) => `data: ${line}\n\n`)
      .join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

test("/ai/chatがSSEで応答しメッセージを保存する", async () => {
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
      body: JSON.stringify({ message: "テスト" }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
    const text = await response.text();
    assert.ok(text.includes('"type":"start"'));
    assert.ok(text.includes('"type":"delta"'));
    assert.ok(text.includes("こんにちは"));
    assert.ok(text.includes('"type":"done"'));
    assert.equal(stub.calls.length, 1);
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
