/**
 * AIのツール定義と実行ディスパッチ。
 * - db_query: 分析DBへの読み取り専用SQL (セッションレベルでread-only + statement_timeout)
 * - run_command: agentコンテナ (秘密なし) 内でのシェル実行
 * - web_search: DuckDuckGo検索
 */
import type { Pool } from "pg";
import { runAgentCommand, type AgentConfig } from "./agentClient";
import { webSearch } from "./websearch";
import type { ToolDefinition } from "./deepseek";

export interface ToolContext {
  agent: AgentConfig;
  /** AI専用の読み取り専用プール (未設定ならdb_query無効) */
  readOnlyPool: Pool | null;
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  /** UI表示用の短いラベル */
  summary: string;
}

const MAX_ROWS = 200;
const MAX_CELL_CHARS = 300;
const MAX_OUTPUT_CHARS = 16_000;

/** 書き込み系・危険系ステートメントの拒否 (db_queryは閲覧専用) */
const DENIED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "VACUUM",
  "REINDEX",
  "CALL",
  "DO",
  "LISTEN",
  "NOTIFY",
  "SET",
  "RESET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "LOCK",
  "COMMENT",
  "REASSIGN",
  "IMPORT",
  "pg_read_file",
  "pg_ls_dir",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "set_config",
  "pg_advisory_lock",
  "lo_import",
  "lo_export",
  "dblink",
];

/** 書き込み系・危険系ステートメントの検査。問題なければnull、あればエラーメッセージを返す */
export function validateReadOnlySql(raw: string): string | null {
  const sql = raw.trim().replace(/;+\s*$/, "");
  if (!sql) return "SQL is empty";
  if (sql.includes(";")) return "Multiple statements are not allowed";
  const firstWord = (sql.match(/^[\s(]*(\w+)/) ?? [])[1]?.toUpperCase() ?? "";
  if (!["SELECT", "WITH", "TABLE", "EXPLAIN", "SHOW"].includes(firstWord)) {
    return "Only SELECT/WITH/TABLE/EXPLAIN queries are allowed";
  }
  for (const keyword of DENIED_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    // SELECT ... FOR UPDATE 等も含めて一括拒否 (閲覧専用ツールなので誤検知より安全側)
    if (pattern.test(sql)) return `Keyword "${keyword}" is not allowed (read-only)`;
  }
  return null;
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

function oneLine(text: string, max = 70): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** 指定SQLを実行し、AI向けの結果テキストを組み立てる */
async function executeDbQuery(pool: Pool, sql: string): Promise<ToolResult> {
  const denied = validateReadOnlySql(sql);
  if (denied) return { output: `Error: ${denied}`, summary: "DB (拒否)" };

  try {
    const { rows } = await pool.query(sql);
    if (rows.length === 0) {
      return { output: "0 rows", summary: `DB: ${oneLine(sql)}` };
    }
    const shown = rows.slice(0, MAX_ROWS);
    const headers = Object.keys(shown[0] as Record<string, unknown>);
    const lines = [
      headers.join(" | "),
      "-".repeat(Math.min(120, headers.join(" | ").length)),
      ...shown.map((row) =>
        headers.map((key) => cellValue((row as Record<string, unknown>)[key])).join(" | "),
      ),
    ];
    let output = lines.join("\n");
    if (rows.length > MAX_ROWS) {
      output += `\n…(${rows.length - MAX_ROWS} rows omitted, showing ${MAX_ROWS})`;
    }
    if (output.length > MAX_OUTPUT_CHARS) {
      output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
    }
    return {
      output: `${output}\n(${rows.length} rows)`,
      summary: `DB: ${oneLine(sql)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `SQL error: ${message}`, summary: "DB (エラー)" };
  }
}

async function executeRunCommand(
  ctx: ToolContext,
  command: string,
  timeoutSeconds?: number,
): Promise<ToolResult> {
  if (!command.trim()) return { output: "Error: command is required", summary: "実行 (空)" };
  try {
    const output = await runAgentCommand(ctx.agent, command, {
      timeoutSeconds,
      signal: ctx.signal,
    });
    return { output, summary: `実行: ${oneLine(command, 60)}` };
  } catch (error) {
    return {
      output: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: "実行 (エラー)",
    };
  }
}

async function executeWebSearch(query: string, signal?: AbortSignal): Promise<ToolResult> {
  if (!query.trim()) return { output: "Error: query is required", summary: "検索 (空)" };
  try {
    const results = await webSearch(query, { count: 5, signal });
    if (results.length === 0)
      return { output: `No results found for "${query}".`, summary: `検索: ${oneLine(query)}` };
    return {
      output: results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
        .join("\n\n"),
      summary: `検索: ${oneLine(query)}`,
    };
  } catch (error) {
    return {
      output: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: "検索 (エラー)",
    };
  }
}

export function getToolDefinitions(ctx: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (ctx.readOnlyPool) {
    tools.push({
      type: "function",
      function: {
        name: "db_query",
        description:
          "Query the analytics database (PostgreSQL, READ-ONLY). Only SELECT/WITH/TABLE/EXPLAIN statements, single statement, no semicolons. " +
          "Use this to answer anything about this Discord server: message counts, rankings, trends, channels, members, activity by hour/day, etc. " +
          "Tables: messages (message_id, user_id, channel_id, guild_id, created_at, is_bot, char_count), users (user_id, display_name, username, avatar_url), " +
          "channels (channel_id, name, category_name, category_id, is_active, guild_id), guild_members (guild_id, user_id, display_name...). " +
          "Always add guild_id filter when it matters, LIMIT large result sets, and double-check dates with created_at (timestamptz).",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQL query (SELECT only)" },
          },
          required: ["sql"],
        },
      },
    });
  }

  tools.push({
    type: "function",
    function: {
      name: "run_command",
      description:
        "Execute a shell command inside a sandboxed Linux container (you are an agent). " +
        "Available: sh, curl, git, jq, node, standard coreutils. Network access works. " +
        "Use it freely to fetch pages with curl, inspect/transform data, compute, write files, etc. " +
        "The filesystem is a sandbox (workdir /work is ephemeral); do NOT install packages. " +
        "Output is truncated: prefer head/tail/grep/jq to keep it small.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line (executed with sh -c)" },
          timeout_seconds: {
            type: "integer",
            description: "Optional timeout, default 60, max 300",
          },
        },
        required: ["command"],
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web with DuckDuckGo for current/realtime information. " +
        "Use whenever the question needs up-to-date facts or when unsure about facts. Query can be in any language.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query keywords" },
        },
        required: ["query"],
      },
    },
  });

  return tools;
}

/** ツール名 → 実行 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "db_query": {
      if (!ctx.readOnlyPool)
        return { output: "Error: db_query is disabled in this environment", summary: "DB (無効)" };
      return executeDbQuery(ctx.readOnlyPool, String(args?.sql ?? ""));
    }
    case "run_command":
      return executeRunCommand(
        ctx,
        String(args?.command ?? ""),
        args?.timeout_seconds as number | undefined,
      );
    case "web_search":
      return executeWebSearch(String(args?.query ?? ""), ctx.signal);
    default:
      return { output: `Error: unknown tool "${name}"`, summary: `不明なツール: ${name}` };
  }
}
