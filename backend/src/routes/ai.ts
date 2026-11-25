/**
 * AIチャット (/ai/*)。DeepSeek (OpenAI互換) + ツール (DB読取 / サンドボックスコマンド / Web検索)。
 * ストリーミングはSSEで返す。管理は管理者セッション (またはAI_REQUIRE_ADMIN=false時は公開)。
 */
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Pool } from "pg";
import { createReadOnlyPool } from "../db";
import { ADMIN_COOKIE_NAME, isApiClient, verifyAdminSession } from "../adminAuth";
import { jsonResponse, jsonError, readBodyCapped } from "../http";
import type { AppEnv } from "../types";
import type { RouteHelpers } from "./context";
import { runChat, type ChatMessage } from "../ai/deepseek";
import { executeTool, getToolDefinitions, type ToolContext } from "../ai/tools";

/** スレッドあたりの最大メッセージ数 (文脈に使い、DBもこの数を保持する) */
const MAX_HISTORY = 40;

interface AiMessageRow {
  id: string | number;
  role: string;
  content: string;
  tool_runs: unknown;
  created_at: string | Date;
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/** スキーマ一覧のキャッシュ (10分) */
let schemaCache: { text: string; at: number } | null = null;

async function schemaSummary(pool: Pool): Promise<string> {
  if (schemaCache && Date.now() - schemaCache.at < 600_000) return schemaCache.text;
  const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name NOT LIKE 'ai_%'
       AND table_name NOT LIKE 'pg_%'
       AND table_name NOT LIKE 'backfill%'
     ORDER BY table_name, ordinal_position`,
  );
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    const list = tables.get(row.table_name) ?? [];
    list.push(`${row.column_name} ${row.data_type}`);
    tables.set(row.table_name, list);
  }
  const text = [...tables.entries()]
    .map(([name, cols]) => `- ${name}(${cols.join(", ")})`)
    .join("\n");
  schemaCache = { text, at: Date.now() };
  return text;
}

function isAuthorized(c: Context, h: RouteHelpers): boolean {
  const cfg = h.cfg;
  if (!cfg.ai.requireAdmin) return true;
  if (isApiClient(c.req.header("x-api-key"), cfg.apiSecret)) return true;
  return verifyAdminSession(getCookie(c, ADMIN_COOKIE_NAME), cfg.adminSessionSecret);
}

function systemPrompt(guildName: string, guildId: string, schema: string): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const date = jst.toISOString().replace("T", " ").slice(0, 16);
  return [
    `あなたはDiscordサーバー「${guildName}」のデータ分析アシスタント (ギルドID: ${guildId}) です。`,
    "サイトのダッシュボード (/ai ページ) から利用されています。",
    "",
    "回答の方針:",
    "- 日本語で簡潔・読みやすく回答する (Markdown使用可、コードブロックも可)。",
    "- サーバーの統計に関する質問は必ず db_query で実際のデータを確認してから答える。推測で数値を作らない。",
    "- データが取得できない場合はその旨を正直に伝える。",
    "- 必要に応じて web_search (最新情報) や run_command (サンドボックスでの計算・変換・取得) を使う。",
    "",
    `DBスキーマ (読み取り専用):`,
    schema,
    "",
    "注意事項:",
    "- messages.created_at は timestamptz。日本時間は UTC+9。",
    "- 人間の発言のみ対象にする場合は is_bot = FALSE を使う (Bot発言・Webhookは除外)。",
    "- 削除済みユーザー (username/display_name が 'Deleted User' 系) はランキングから除外するのが望ましい。",
    `- 基本的に guild_id = ${guildId} でフィルタする (channels や messages の guild_id) 。`,
    "- 1クエリの実行時間は8秒で打ち切られる。重い集計は範囲を絞るか分割する。",
    `現在時刻 (JST): ${date}`,
  ].join("\n");
}

function sseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function threadTitle(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 30) || "新しいチャット";
}

/** AIチャットのルート登録 */
export function register(app: Hono<AppEnv>, h: RouteHelpers): void {
  const { cfg, cache, deps, requireGuild, getPeerIp } = h;

  // AI専用の読み取り専用プール (遅延接続)
  let readOnlyPool: Pool | null = null;
  const getReadOnlyPool = (): Pool | null => {
    if (!readOnlyPool) {
      try {
        readOnlyPool = createReadOnlyPool(cfg.dbDsn);
      } catch {
        return null;
      }
    }
    return readOnlyPool;
  };

  const requireAuthAndGuild = async (
    c: Context,
  ): Promise<Response | { guild: { guildId: string; name: string }; pool: Pool }> => {
    if (!cfg.ai.apiKey) return jsonError(503, "AI機能は無効です (DEEPSEEK_API_KEYが未設定)");
    if (!isAuthorized(c, h)) return jsonError(403, "このページは管理者ログインが必要です");
    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const guild = await requireGuild(c);
    if (guild instanceof Response) return guild;
    return { guild, pool };
  };

  /** スレッド一覧 */
  app.get("/ai/threads", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild, pool } = guard;
    const { rows } = await pool.query<ThreadRow>(
      `SELECT id, title, created_at, updated_at FROM ai_threads
       WHERE guild_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [guild.guildId],
    );
    return jsonResponse({ threads: rows });
  });

  /** スレッドのメッセージ取得 */
  app.get("/ai/threads/:id", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild, pool } = guard;
    const threadId = c.req.param("id");
    const { rows: threadRows } = await pool.query<ThreadRow>(
      "SELECT id, title, created_at, updated_at FROM ai_threads WHERE id = $1 AND guild_id = $2",
      [threadId, guild.guildId],
    );
    if (threadRows.length === 0) return jsonError(404, "Thread not found");
    const { rows } = await pool.query<AiMessageRow>(
      "SELECT id, role, content, tool_runs, created_at FROM ai_messages WHERE thread_id = $1 ORDER BY id",
      [threadId],
    );
    return jsonResponse({ thread: threadRows[0], messages: rows });
  });

  /** スレッド削除 */
  app.delete("/ai/threads/:id", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild, pool } = guard;
    const threadId = c.req.param("id");
    const result = await pool.query("DELETE FROM ai_threads WHERE id = $1 AND guild_id = $2", [
      threadId,
      guild.guildId,
    ]);
    if (result.rowCount === 0) return jsonError(404, "Thread not found");
    return jsonResponse({ ok: true });
  });

  /** チャット (SSEストリーミング) */
  app.post("/ai/chat", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild, pool } = guard;

    const clientIp = getPeerIp(c);

    const body = await readBodyCapped(c.req.raw, 64_000);
    if (!body) return jsonError(422, "Invalid JSON body");
    let message = "";
    let threadId = "";
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { message?: string; threadId?: string };
      message = String(parsed.message ?? "");
      threadId = String(parsed.threadId ?? "");
    } catch {
      return jsonError(422, "Invalid JSON body");
    }
    message = message.trim();
    if (!message) return jsonError(422, "message is required");
    if (message.length > 8_000) message = message.slice(0, 8_000);

    // abuse対策 (APIコストが掛かるため通常より厳しめ):
    // ① IPごとの短時間上限 (管理者/Botキーはゆるめ) ② IPごとの1日上限 ③ サイト全体の1日上限
    const privileged =
      isApiClient(c.req.header("x-api-key"), cfg.apiSecret) ||
      verifyAdminSession(getCookie(c, ADMIN_COOKIE_NAME), cfg.adminSessionSecret);
    if (
      !cache.consumeLimit(
        `ai:${clientIp}`,
        privileged ? cfg.ai.rateLimitPer10Min * 5 : cfg.ai.rateLimitPer10Min,
        600,
      )
    ) {
      return jsonError(429, "連投制限中です。しばらく待ってから再試行してください。");
    }
    if (!privileged && !cache.consumeLimit(`ai-day:${clientIp}`, cfg.ai.dailyLimitPerIp, 86_400)) {
      return jsonError(429, "本日のAI利用上限に達しました (1日あたりの上限を超えました)。");
    }
    if (!privileged && !cache.consumeLimit("ai-day:global", cfg.ai.dailyLimitGlobal, 86_400)) {
      return jsonError(429, "現在AIの利用が集中しています。時間をおいて再試行してください。");
    }

    // スレッドを用意 (既存チェック or 新規作成)
    let title = threadTitle(message);
    if (threadId) {
      const { rows } = await pool.query<ThreadRow>(
        "SELECT id, title FROM ai_threads WHERE id = $1 AND guild_id = $2",
        [threadId, guild.guildId],
      );
      if (rows.length === 0) return jsonError(404, "Thread not found");
      title = rows[0].title;
    } else {
      threadId = crypto.randomUUID();
      await pool.query("INSERT INTO ai_threads (id, guild_id, title) VALUES ($1, $2, $3)", [
        threadId,
        guild.guildId,
        title,
      ]);
    }

    // 履歴を文脈に組み立てる
    const { rows: history } = await pool.query<AiMessageRow>(
      `SELECT role, content FROM ai_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT ${MAX_HISTORY}`,
      [threadId],
    );
    history.reverse();

    let schema = "";
    try {
      schema = await schemaSummary(getReadOnlyPool() ?? pool);
    } catch {
      schema =
        "(スキーマ情報の取得に失敗しました。既知のテーブル: messages, users, channels, guilds, guild_members)";
    }
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt(guild.name, guild.guildId, schema) },
      ...history.map((row) => ({
        role: row.role as "user" | "assistant",
        content: row.content,
      })),
      { role: "user", content: message },
    ];

    await pool.query("INSERT INTO ai_messages (thread_id, role, content) VALUES ($1, 'user', $2)", [
      threadId,
      message,
    ]);

    const toolCtx: ToolContext = {
      agent: { agentSocket: cfg.ai.agentSocket },
      readOnlyPool: getReadOnlyPool(),
      signal: c.req.raw.signal,
    };
    const toolDefs = getToolDefinitions(toolCtx);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (payload: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(sseEvent(payload)));
          } catch {
            closed = true;
          }
        };

        send({ type: "start", threadId, title });

        const toolRuns: Array<{ name: string; summary: string }> = [];
        try {
          const result = await runChat(
            cfg.ai,
            chatMessages,
            toolDefs,
            {
              onDelta: (text) => send({ type: "delta", text }),
              onToolCalls: () => send({ type: "tool_start" }),
              onToolExecute: async (call) => {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(call.function.arguments) as Record<string, unknown>;
                } catch {
                  args = {};
                }
                const executed = await executeTool(call.function.name, args, toolCtx);
                toolRuns.push({ name: call.function.name, summary: executed.summary });
                send({ type: "tool", name: call.function.name, summary: executed.summary });
                return { output: executed.output, summary: executed.summary };
              },
            },
            c.req.raw.signal,
          );
          const content = result.content.trim();
          const finalContent = content || "(回答を生成できませんでした)";
          if (!content) send({ type: "error", message: "AIの応答が空でした" });
          await pool.query(
            "INSERT INTO ai_messages (thread_id, role, content, tool_runs) VALUES ($1, 'assistant', $2, $3)",
            [threadId, finalContent, JSON.stringify(toolRuns)],
          );
          await pool.query("UPDATE ai_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
            threadId,
          ]);
          send({ type: "done", threadId, title });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (!c.req.raw.signal.aborted) {
            send({ type: "error", message: `AIの応答に失敗しました: ${text.slice(0, 200)}` });
          }
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      cancel() {
        // クライアント切断時はrequest.signal経由でツール実行・API呼び出しが中断される
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
