/**
 * Discord CDN アセットの同一オリジンプロキシ (/api/avatar/avatars/... 等)。
 *
 * - img-src を 'self' に閉じる (利用者のIPをDiscordに直接見せない)
 * - 許可するアセット種別を限定し、パストラバーサル・任意URLの中継を禁止する
 * - レスポンスは24時間のブラウザキャッシュ (URLはハッシュベースで不変なため安全)
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import type { RouteHelpers } from "./context";

const DISCORD_CDN = "https://cdn.discordapp.com/";

/** プロキシを許可するDiscord CDNアセット種別 (それ以外は404) */
const ALLOWED_PATH =
  /^(?:avatars|embed\/avatars|clan-badges|banners|avatar-decoration-presets|nameplates|role-icons|emojis)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:png|webp|gif|jpe?g|apng)$/;

/** 上流へ素通ししてよいクエリパラメータ (サイズ指定などDiscord CDNの公式パラメータ) */
const ALLOWED_QUERY_KEY = /^(?:size|publisher_restricted|passthrough)$/;

/** 画像プロキシのレート制限 (IPごと 10分あたり600リクエスト) */
const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_SEC = 600;

export function register(app: Hono<AppEnv>, h: RouteHelpers): void {
  const { cache, getPeerIp } = h;

  app.get("/avatar/*", async (c: Context) => {
    const relPath = c.req.path.slice("/avatar/".length);
    // パストラバーサルと許可外アセットを拒否 (open proxy化を防ぐ)
    if (relPath.includes("..") || !ALLOWED_PATH.test(relPath)) {
      return c.text("Not Found", 404);
    }
    // 帯域のabuse対策 (アバターは全ページで使うため控えめな制限値)
    if (!cache.consumeLimit(`imgpr:${getPeerIp(c)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC)) {
      return c.text("Too Many Requests", 429);
    }

    const search = new URLSearchParams();
    for (const key of ["size", "publisher_restricted", "passthrough"]) {
      const value = c.req.query(key);
      if (value !== undefined && value.length <= 32) search.set(key, value);
    }
    const qs = search.toString();
    try {
      const upstream = await fetch(`${DISCORD_CDN}${relPath}${qs ? `?${qs}` : ""}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok || !upstream.body) {
        return c.text("Not Found", 404);
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "image/webp",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      return c.text("Not Found", 404);
    }
  });
}
