/**
 * AIチャットのパイプライン (SSEルートとWebSocketサーバーの共用)。
 * バリデーション・レート制限・スレッド管理・DeepSeekストリーミング・
 * ツール実行・DB保存をここに集約し、 transport層からはイベント送信コールバックだけを渡す。
 * イベント形式 (start/delta/tool/done/error) はSSE・WS共通。
 */
import type { Pool } from "pg";
import { runChat, type ChatMessage } from "./deepseek";
import { executeTool, getToolDefinitions, type ToolContext } from "./tools";
import type { AppConfig } from "../config";

/** スレッドあたりの最大メッセージ数 (文脈に使い、DBもこの数を保持する) */
export const MAX_HISTORY = 40;

export interface AiMessageRow {
  id: string | number;
  role: string;
  content: string;
  tool_runs: unknown;
  created_at: string | Date;
}

export interface ThreadRow {
  id: string;
  title: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface GuildRef {
  guildId: string;
  name: string;
}

export interface ChatDeps {
  cfg: AppConfig;
  pool: Pool;
  /** AI専用の読み取り専用プール (DB_query用)。無い場合はpoolを使う */
  getReadOnlyPool: () => Pool | null;
  /** レート制限 (cache.consumeLimit) */
  consumeLimit: (key: string, max: number, windowSec: number) => boolean;
}

export interface ChatParams {
  guild: GuildRef;
  clientIp: string;
  privileged: boolean;
  message: string;
  threadId: string;
  editOf: number;
}

export type ChatEvent =
  | { type: "start"; threadId: string; title: string; userMessageId: number }
  | { type: "delta"; text: string }
  | { type: "tool_start" }
  | { type: "tool"; name: string; summary: string; output?: string }
  | { type: "done"; threadId: string; title: string }
  | { type: "error"; message: string };

export interface PrepareOk {
  ok: true;
  threadId: string;
  title: string;
  userMessageId: number;
  chatMessages: ChatMessage[];
  toolDefs: ReturnType<typeof getToolDefinitions>;
  toolCtx: ToolContext;
}

export interface PrepareError {
  ok: false;
  status: number;
  detail: string;
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

export function threadTitle(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 30) || "新しいチャット";
}

export function systemPrompt(guildName: string, guildId: string, schema: string): string {
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
    "- Discordサーバーの分析だけでなく、プログラミング・文章作成・翻訳・計算などの一般的な質問にも普通に答える。コードを書くときは言語名付きのMarkdownコードブロックにする。",
    "",
    "メンションの書き方:",
    "- 特定のメンバーに言及するときは、名前を平文で書かず必ずDiscordメンション形式 <@user_id> で書く (例: <@123456789012345678>)。",
    "- user_id は db_query の結果 (users.user_id, messages.user_id, guild_members.user_id など) から取得する。架空のIDを作らない。",
    "- 同じ人を繰り返し言及するときも毎回 <@user_id> を使って良い (UIがアイコン付きチップに変換して表示する)。",
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

/**
 * チャットの下準備: バリデーション・レート制限・スレッド用意・履歴/スキーマ取得・
 * ユーザーメッセージの保存。エラー時はHTTPステータス付きで返す (transport層が応答する)。
 */
export async function prepareAIChat(
  deps: ChatDeps,
  params: ChatParams,
): Promise<PrepareOk | PrepareError> {
  const { cfg, pool } = deps;
  let message = params.message.trim();
  if (!message) return { ok: false, status: 422, detail: "message is required" };
  if (message.length > 8_000) message = message.slice(0, 8_000);

  // abuse対策 (APIコストが掛かるため通常より厳しめ):
  // ① IPごとの短時間上限 (管理者/Botキーはゆるめ) ② IPごとの1日上限 ③ サイト全体の1日上限
  const { guild, clientIp, privileged } = params;
  if (
    !deps.consumeLimit(
      `ai:${clientIp}`,
      privileged ? cfg.ai.rateLimitPer10Min * 5 : cfg.ai.rateLimitPer10Min,
      600,
    )
  ) {
    return {
      ok: false,
      status: 429,
      detail: "連投制限中です。しばらく待ってから再試行してください。",
    };
  }
  if (!privileged && !deps.consumeLimit(`ai-day:${clientIp}`, cfg.ai.dailyLimitPerIp, 86_400)) {
    return {
      ok: false,
      status: 429,
      detail: "本日のAI利用上限に達しました (1日あたりの上限を超えました)。",
    };
  }
  if (!privileged && !deps.consumeLimit("ai-day:global", cfg.ai.dailyLimitGlobal, 86_400)) {
    return {
      ok: false,
      status: 429,
      detail: "現在AIの利用が集中しています。時間をおいて再試行してください。",
    };
  }

  // スレッドを用意 (既存チェック or 新規作成)
  let threadId = params.threadId;
  let title = threadTitle(message);
  if (threadId) {
    const { rows } = await pool.query<ThreadRow>(
      "SELECT id, title FROM ai_threads WHERE id = $1 AND guild_id = $2",
      [threadId, guild.guildId],
    );
    if (rows.length === 0) return { ok: false, status: 404, detail: "Thread not found" };
    title = rows[0].title;
    // 編集再送信: editOf (ユーザーメッセージのid) 以降を削り直す
    if (Number.isInteger(params.editOf) && params.editOf > 0) {
      const { rows: owned } = await pool.query(
        "SELECT 1 FROM ai_messages WHERE id = $1 AND thread_id = $2 AND role = 'user'",
        [params.editOf, threadId],
      );
      if (owned.length === 0) return { ok: false, status: 404, detail: "Message not found" };
      await pool.query("DELETE FROM ai_messages WHERE thread_id = $1 AND id >= $2", [
        threadId,
        params.editOf,
      ]);
    }
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
    schema = await schemaSummary(deps.getReadOnlyPool() ?? pool);
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

  const { rows: inserted } = await pool.query<{ id: string | number }>(
    "INSERT INTO ai_messages (thread_id, role, content) VALUES ($1, 'user', $2) RETURNING id",
    [threadId, message],
  );
  const userMessageId = Number(inserted[0]?.id ?? 0);

  const toolCtx: ToolContext = {
    agent: { agentSocket: cfg.ai.agentSocket },
    readOnlyPool: deps.getReadOnlyPool(),
  };
  const toolDefs = getToolDefinitions(toolCtx);

  return { ok: true, threadId, title, userMessageId, chatMessages, toolDefs, toolCtx };
}

/**
 * DeepSeekストリーミング+ツールループを実行し、イベントをsendに推送する。
 * 全体で3分の時間切れ (ツールループの暴走対策)。完了後はDBに回答を保存する。
 */
export async function runAIChat(
  deps: ChatDeps,
  prepared: PrepareOk,
  params: { signal: AbortSignal; send: (event: ChatEvent) => void },
): Promise<void> {
  const { pool } = deps;
  const { threadId, title, chatMessages, toolDefs, toolCtx } = prepared;
  const send = params.send;

  send({ type: "start", threadId, title, userMessageId: prepared.userMessageId });

  // 全体で3分の時間切れ (ツールループで暴走してトークンを浪費するのを防ぐ)
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), 180_000);
  const onClientAbort = () => timeoutController.abort();
  params.signal.addEventListener("abort", onClientAbort, { once: true });
  toolCtx.signal = params.signal;

  const toolRuns: Array<{ name: string; summary: string; output?: string }> = [];
  try {
    const result = await runChat(
      deps.cfg.ai,
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
          // 取得データは UIで展開表示できるよう (保存分も含め) 上限付きで保持する
          const output = executed.output.slice(0, 6000);
          toolRuns.push({ name: call.function.name, summary: executed.summary, output });
          send({ type: "tool", name: call.function.name, summary: executed.summary, output });
          return { output: executed.output, summary: executed.summary };
        },
      },
      timeoutController.signal,
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
    const timedOut = timeoutController.signal.aborted && !params.signal.aborted;
    if (!params.signal.aborted) {
      send({
        type: "error",
        message: timedOut
          ? "処理が3分を超えたため中断しました。質問を絞るか、範囲を狭めて試してください。"
          : `AIの応答に失敗しました: ${text.slice(0, 200)}`,
      });
    }
  } finally {
    clearTimeout(timeoutTimer);
    params.signal.removeEventListener("abort", onClientAbort);
  }
}
