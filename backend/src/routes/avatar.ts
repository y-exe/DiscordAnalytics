/**
 * Discord CDN アセットの同一オリジンプロキシ (/api/avatar/avatars/... 等)。
 *
 * - img-src を 'self' に閉じる (利用者のIPをDiscordに直接見せない)
 * - 許可するアセット種別を限定し、パストラバーサル・任意URLの中継を禁止する
 * - 成功レスポンスをメモリにキャッシュし、同一URLの同時fetchを1つにまとめる
 *   (1ページで数十枚のアバターが要求されるため、Discord CDNへのfetchを削減する)
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

/** メモリキャッシュ: 最大エントリ数とTTL (DiscordのアセットURLはハッシュベースで不変) */
const CACHE_MAX_ENTRIES = 2_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 1枚あたりのキャッシュ上限 (超える画像はキャッシュせず素通し) */
const CACHE_MAX_BYTES = 512 * 1024;

/** 画像プロキシのレート制限 (IPごと 10分あたり2400リクエスト)。NGINX側でもキャッシュする */
const RATE_LIMIT_MAX = 2400;
const RATE_LIMIT_WINDOW_SEC = 600;

interface CacheEntry {
  body: Buffer;
  contentType: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/** 同一URLへの同時fetchを1つにまとめる */
const inFlight = new Map<string, Promise<{ body: Buffer; contentType: string } | null>>();

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  // LRU: 参照時に末尾へ移動
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: CacheEntry): void {
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** 上流 (Discord CDN) から取得。同一URLの同時リクエストは1つのfetchにまとめる */
function fetchUpstream(upstreamUrl: string): Promise<{ body: Buffer; contentType: string } | null> {
  const existing = inFlight.get(upstreamUrl);
  if (existing) return existing;

  const promise = (async () => {
    const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok || !upstream.body) return null;
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length === 0 || body.length > CACHE_MAX_BYTES) return null;
    return { body, contentType: upstream.headers.get("Content-Type") ?? "image/webp" };
  })().finally(() => inFlight.delete(upstreamUrl));

  inFlight.set(upstreamUrl, promise);
  return promise;
}

export function register(app: Hono<AppEnv>, h: RouteHelpers): void {
  const { cache: rateCache, getPeerIp } = h;

  app.get("/avatar/*", async (c: Context) => {
    const relPath = c.req.path.slice("/avatar/".length);
    // パストラバーサルと許可外アセットを拒否 (open proxy化を防ぐ)
    if (relPath.includes("..") || !ALLOWED_PATH.test(relPath)) {
      return c.text("Not Found", 404);
    }
    // 帯域のabuse対策 (NGINX側でキャッシュするため実質は初回のみ到達)
    if (!rateCache.consumeLimit(`imgpr:${getPeerIp(c)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC)) {
      return c.text("Too Many Requests", 429);
    }

    const search = new URLSearchParams();
    for (const key of ["size", "publisher_restricted", "passthrough"]) {
      const value = c.req.query(key);
      if (value !== undefined && value.length <= 32) search.set(key, value);
    }
    const qs = search.toString();
    const cacheKey = `${relPath}${qs ? `?${qs}` : ""}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    const fetched = await fetchUpstream(`${DISCORD_CDN}${cacheKey}`);
    if (!fetched) return c.text("Not Found", 404);

    cacheSet(cacheKey, { ...fetched, expiresAt: Date.now() + CACHE_TTL_MS });
    return new Response(fetched.body, {
      status: 200,
      headers: {
        "Content-Type": fetched.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  });
}
