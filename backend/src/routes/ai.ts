/**
 * AIチャット (/ai/*)。DeepSeek (OpenAI互換) + ツール (DB読取 / サンドボックスコマンド / Web検索)。
 * ストリーミングはSSEで返す。管理は管理者セッション (またはAI_REQUIRE_ADMIN=false時は公開)。
 * 会話履歴はクライアント (localStorage) が保持するため、サーバーにスレッド保存APIはない。
 */
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Pool } from "pg";
import { createReadOnlyPool } from "../db";
import { ADMIN_COOKIE_NAME, isApiClient, verifyAdminSession } from "../adminAuth";
import { jsonResponse, jsonError, readBodyCapped } from "../http";
import type { AppEnv } from "../types";
import type { RouteHelpers } from "./context";
import { prepareAIChat, runAIChat, type ChatEvent } from "../ai/chatService";

function isAuthorized(c: Context, h: RouteHelpers): boolean {
  const cfg = h.cfg;
  if (!cfg.ai.requireAdmin) return true;
  if (isApiClient(c.req.header("x-api-key"), cfg.apiSecret)) return true;
  return verifyAdminSession(getCookie(c, ADMIN_COOKIE_NAME), cfg.adminSessionSecret);
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

  /** チャットパイプラインへの依存を毎回組み立てる (cache/poolはhelpersから) */
  const chatDeps = () => ({
    cfg,
    pool: deps.getPool() as Pool,
    getReadOnlyPool,
    consumeLimit: (key: string, max: number, windowSec: number) =>
      cache.consumeLimit(key, max, windowSec),
  });

  /** 管理者セッション or Botキー (レート制限を緩める対象) */
  const isPrivileged = (c: Context): boolean =>
    isApiClient(c.req.header("x-api-key"), cfg.apiSecret) ||
    verifyAdminSession(getCookie(c, ADMIN_COOKIE_NAME), cfg.adminSessionSecret);

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

  /** AI機能の稼働/権限チェック (画面の初期状態判定用) */
  app.get("/ai/status", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    return jsonResponse({ ok: true });
  });

  /** メンション用ユーザー情報 (ids=カンマ区切りのuser_id) */
  app.get("/ai/mentions", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild, pool } = guard;
    // 軽量とはいえ無制限のDBアクセスを避けるためIP単位で制限する
    if (!cache.consumeLimit(`ai-mentions:${getPeerIp(c)}`, 120, 600)) {
      return jsonError(429, "リクエストが多すぎます。しばらく待ってから再試行してください。");
    }
    const raw = c.req.query("ids") ?? "";
    const ids = raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => /^\d{1,20}$/.test(v))
      .slice(0, 50);
    if (ids.length === 0) return jsonResponse({ users: [] });
    const { rows } = await pool.query(
      `SELECT gm.user_id, gm.display_name, u.username,
              COALESCE(gm.avatar_url, u.avatar_url) AS avatar_url,
              u.avatar_url AS main_avatar_url, u.avatar_decoration_url,
              u.primary_guild_tag, u.primary_guild_badge_url
       FROM guild_members gm JOIN users u ON u.user_id = gm.user_id
       WHERE gm.guild_id = $1 AND gm.user_id = ANY($2::bigint[])`,
      [guild.guildId, ids],
    );
    const users = rows.map((r) => ({
      user_id: String(r.user_id),
      display_name: (r.display_name as string) || "Unknown",
      username: (r.username as string) || "unknown",
      avatar: (r.avatar_url as string | null) ?? null,
      avatar_fallback: (r.main_avatar_url as string | null) ?? null,
      avatar_decoration: (r.avatar_decoration_url as string | null) ?? null,
      primary_guild_tag: (r.primary_guild_tag as string | null) ?? null,
      primary_guild_badge: (r.primary_guild_badge_url as string | null) ?? null,
    }));
    return jsonResponse({ users }, 200, { "Cache-Control": "public, max-age=300" });
  });

  /** チャット (SSEストリーミング)。パイプライン本体はai/chatServiceに共用実装がある */
  app.post("/ai/chat", async (c) => {
    const guard = await requireAuthAndGuild(c);
    if (guard instanceof Response) return guard;
    const { guild } = guard;

    const clientIp = getPeerIp(c);

    // 履歴を含むため上限は大きめ (sanitizeHistoryでさらに切り詰める)
    const body = await readBodyCapped(c.req.raw, 256_000);
    if (!body) return jsonError(422, "Invalid JSON body");
    let message = "";
    let history: unknown = undefined;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as {
        message?: string;
        history?: unknown;
      };
      message = String(parsed.message ?? "");
      history = parsed.history;
    } catch {
      return jsonError(422, "Invalid JSON body");
    }

    const prepared = await prepareAIChat(chatDeps(), {
      guild,
      clientIp,
      privileged: isPrivileged(c),
      message,
      history,
    });
    if (!prepared.ok) return jsonError(prepared.status, prepared.detail);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (event: ChatEvent) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}

`),
            );
          } catch {
            closed = true;
          }
        };
        await runAIChat(chatDeps(), prepared, { signal: c.req.raw.signal, send });
        if (!closed) {
          closed = true;
          controller.close();
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
