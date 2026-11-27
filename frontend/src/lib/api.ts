const SAME_ORIGIN = process.env.NEXT_PUBLIC_SAME_ORIGIN === "true";
// 開発時のみ: クライアントを同一オリジン /api に向け、next.config.ts の rewrite で
// NEXT_PUBLIC_API_URL (本番API) へ中継する。本番ビルドでは無効。
const DEV_PROXY =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_DEV_PROXY === "true";
const API_URL =
  SAME_ORIGIN || DEV_PROXY
    ? "/api"
    : process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV === "development" ? "" : "/api");
const SSR_API_URL = SAME_ORIGIN
  ? process.env.API_URL || "http://127.0.0.1:4321/api"
  : process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:4321/api";

interface FetchAPIOptions extends Omit<RequestInit, "signal"> {
  timeout?: number;
  retries?: number;
  /** trueで失敗時にエラーページへ遷移しない (事前取得などバックグラウンド用) */
  quiet?: boolean;
}

export class APIError extends Error {
  status: number;
  url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.url = url;
  }
}

/** SSR時に元リクエストのホストを取得し、バックエンドのギルド解決に渡す */
async function resolveForwardedHost(): Promise<string | null> {
  if (typeof window !== "undefined") return null;
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    return incoming.get("x-forwarded-host") ?? incoming.get("host");
  } catch {
    return null;
  }
}

/* ------------------------- クライアント側 GET キャッシュ ------------------------- */
// 期間切替やページ間の行き来を高速化するため、直近のGETレスポンスをメモリに保持する。
// SSRでは無効 (サーバーはリクエスト間で状態を持たない)。月次集計は変化が緩やかなため
// 短いTTLで十分。
interface CacheEntry {
  ts: number;
  body: unknown;
}
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 40;
const responseCache = new Map<string, CacheEntry>();

function cacheStore(key: string, body: unknown): void {
  while (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { ts: Date.now(), body });
}

function cacheGet(key: string): unknown {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return hit.body;
}

export async function fetchAPI(path: string, options: FetchAPIOptions = {}): Promise<Response> {
  const { retries = 2, ...fetchOptions } = options;
  const isServer = typeof window === "undefined";
  const baseUrl = isServer ? SSR_API_URL : API_URL;
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const forwardedHost = isServer ? await resolveForwardedHost() : null;
  const headers: Record<string, string> = {
    // クロスオリジンSSR取得時は配信中サイト自身をRefererにする (固定ドメインを持たない)
    ...(isServer && !SAME_ORIGIN && forwardedHost ? { Referer: `https://${forwardedHost}/` } : {}),
    ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
    ...((fetchOptions.headers as Record<string, string>) || {}),
  };

  // クライアントのGETのみキャッシュ対象
  const method = (fetchOptions.method ?? "GET").toUpperCase();
  const canCache = !isServer && method === "GET" && !fetchOptions.body;
  if (canCache) {
    const cached = cacheGet(url);
    if (cached !== null) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...fetchOptions,
        cache: fetchOptions.cache ?? "no-store",
        headers,
        credentials: fetchOptions.credentials ?? "include",
      });

      if (res.ok) {
        if (canCache) {
          try {
            cacheStore(url, await res.clone().json());
          } catch {
            // JSONでないボディはキャッシュしない
          }
        }
        return res;
      }
      if (res.status === 404) return res;

      // 5xxの応答にはエラーID (error_id) が入ることがある。エラーページまで運搬し
      // ユーザーが報告できるようにする (サーバーログと同じIDで引ける)
      const apiError = new APIError(await describeHttpError(res), res.status, url);
      lastError = apiError;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          // 429はRetry-Afterヘッダーがあればそれを講守する (最長10秒)
          const retryAfter = Number(res.headers.get("Retry-After"));
          const waitMs =
            res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 10_000)
              : 1000 * Math.pow(2, attempt);
          await delay(waitMs);
          continue;
        }
      }

      throw apiError;
    } catch (err) {
      if (!(err instanceof APIError)) {
        lastError = new APIError(err instanceof Error ? err.message : "Network failure", 0, url);
        if (err instanceof Error) {
          lastError.name = err.name;
        }
      } else {
        lastError = err;
      }

      if (attempt < retries) {
        await delay(1000 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  if (lastError) {
    redirectToErrorPage(lastError, isServer, options.quiet ?? false);
    throw lastError;
  }
  throw new Error("Fetch failed after retries");
}

/** エラーレスポンスからUI向けの短い説明を作る (サーバー発のerror_idがあれば添える) */
async function describeHttpError(res: Response): Promise<string> {
  if (res.status < 500) return `HTTP ${res.status}`;
  try {
    const body = (await res.clone().json()) as { error_id?: unknown; detail?: unknown };
    if (body && typeof body === "object") {
      const detail = typeof body.detail === "string" ? body.detail : "";
      if (typeof body.error_id === "string" && body.error_id) {
        return `HTTP ${res.status} (${detail} / error_id: ${body.error_id})`;
      }
    }
  } catch {
    // JSONでない応答は従来どおり
  }
  return `HTTP ${res.status}`;
}

function redirectToErrorPage(error: Error, isServer: boolean, quiet: boolean): void {
  // あらゆるAPI失敗 (4xx/5xx/ネットワーク断) をエラーコードページへ集約する。
  // - quiet (事前取得等のバックグラウンド) は画面遷移させない
  // - SSR時はリダイレクトできないため、クライアントの再取得で処理される
  if (
    isServer ||
    quiet ||
    typeof window === "undefined" ||
    !(error instanceof APIError) ||
    window.location.pathname === "/error"
  )
    return;

  // ネットワーク断 (status 0) は到達不能を意味するため503として扱う
  const code = error.status >= 400 ? error.status : 503;
  // ページのパスと code/msg をクエリに渡す (内部APIのURLは露出させない)
  const params = new URLSearchParams({
    code: String(code),
    msg: error.message || "Bad Gateway",
    path: window.location.pathname,
  });
  window.location.assign(`/error?${params.toString()}`);
}

/** 指定パスを事前取得してキャッシュを温める (期間切替の高速化)。失敗しても何もしない */
const inflightPrefetch = new Set<string>();
export function prefetchAPI(path: string): void {
  if (typeof window === "undefined") return;
  const url = `${API_URL}${path}`;
  if (cacheGet(url) !== null || inflightPrefetch.has(url)) return;
  inflightPrefetch.add(url);
  void fetchAPI(path, { retries: 1, quiet: true })
    .catch(() => {})
    .finally(() => inflightPrefetch.delete(url));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { API_URL };
