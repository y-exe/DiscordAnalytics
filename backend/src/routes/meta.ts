import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW,
  adminClientKey,
  adminOriginAllowed,
  adminSessionCookie,
  adminSessionCookieDeletion,
  createAdminSession,
  isApiClient,
  verifyAdminSession,
} from "../adminAuth";
import {
  DELETED_USER_FILTER,
  LIVE_TOTAL_CACHE_TTL,
  TOTAL_CACHE_WARM_INTERVAL_MS,
  addChannelScopeFilter,
  computeUserIdsKey,
  escapeLike,
  formatRankingResponse,
  formatUserRankResponse,
  jsonResponse,
  jsonError,
  monthBounds,
  noContent,
  parseEndDate,
  pathInt,
  plainTextResponse,
  readBodyCapped,
} from "../http";
import { dashboardBaseUrl, normalizeHost } from "../guilds";
import type { AppEnv } from "../types";
import type { RouteHelpers } from "./context";

/** メタ情報 (/guild-context, /internal/caddy-ask) */
export function register(app: Hono<AppEnv>, h: RouteHelpers): void {
  const {
    cfg,
    cache,
    deps,
    getPeerIp,
    requireGuild,
    getChannelScopeIds,
    requireMonthAccess,
    monthCacheControl,
  } = h;

  app.get("/guild-context", async (c) => {
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    return jsonResponse(
      {
        guildId: guild.guildId,
        name: guild.name,
        iconUrl: guild.iconUrl,
        isDefault: guild.guildId === cfg.guildId,
        domain: dashboardBaseUrl(guild),
        domains: guild.domains,
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  });

  app.get("/internal/caddy-ask", async (c) => {
    // CaddyのaskリクエストはTraefikを経由するためXFFでは判定できない。
    // 共有トークン (CADDY_ASK_TOKEN / Caddyfileのask URLに ?token= で埋め込む) か、
    // 内部リクエスト (XFFが全て信頼ホップ) のどちらかで許可する。
    // 一般公開されているとドメイン列挙 (200/404) が可能になるため。
    const env = c.env as { peerIp?: string; trustedPeer?: boolean } | undefined;
    const token = c.req.query("token") ?? "";
    const expected = cfg.caddyAskToken;
    const tokenOk =
      expected.length > 0 &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!tokenOk && (!env?.trustedPeer || env.peerIp !== "unknown")) {
      return plainTextResponse("Not Found", { "Cache-Control": "no-store" }, 404);
    }
    const rawDomain = c.req.query("domain") ?? "";
    const domain = normalizeHost(rawDomain);
    if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) {
      return plainTextResponse("Not Found", { "Cache-Control": "no-store" }, 404);
    }
    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const { rows } = await pool.query(
      "SELECT 1 FROM guild_domains WHERE domain = $1 AND is_active LIMIT 1",
      [domain],
    );
    if (rows.length === 0) {
      console.warn(`caddy-ask: 許可されていないドメインへの発行要求 domain=${domain}`);
      return plainTextResponse("Not Found", { "Cache-Control": "no-store" }, 404);
    }
    return plainTextResponse("OK", { "Cache-Control": "no-store" });
  });
}
