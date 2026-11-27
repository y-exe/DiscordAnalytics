import { NextRequest, NextResponse } from "next/server";

/**
 * レンダー前の全リクエスト処理 (Next 16: middleware → proxy にリネーム)。
 *
 * ① 本番CSP (nonce付き) を発行する。nonceはレスポンス毎に変わるため
 *    next.config の headers() では出せず、ここで生成してヘッダーに埋め込む。
 *    Next.jsはリクエストヘッダーのCSPをnonce検出に使い、ハイドレーション用の
 *    インラインスクリプトへ自動nonceを付与する。
 *    style-srcは 'unsafe-inline' を維持する (chart系がstyle=""を多用し
 *    ハッシュ化は実質的に不可能なため)。
 * ② ダッシュボードの m パラメータ (?m=YYYY-MM / all) を正規形へ集約する。
 *    非正形 (abc / 2026-13 / 2026-11-01 / 2026-9 など) はレンダー前に
 *    308リダイレクトする (Server Component内のredirectはSuspense配下では
 *    メタ更新フォールバックになるため、ここで処理する)。
 *    HSTSも先頭ドメインに対して出す (includeSubDomains付き)。
 */

const CANONICAL_M = /^(?:all|\d{4}-(?:0[1-9]|1[0-2]))$/;
const UNPADDED_M = /^(\d{4})-(0?[1-9]|1[0-2])$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 最新公開月 (前月, JST) をゼロ埋めの m パラメータ値で */
function defaultMonthParam(now = new Date()): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month).padStart(2, "0")}`;
}

export function proxy(request: NextRequest): NextResponse {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    "default-src 'self'",
    isProd ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  // ② m パラメータの正規化 (レンダー前に308で集約)
  const m = request.nextUrl.searchParams.get("m");
  if (m !== null && !CANONICAL_M.test(m)) {
    const target = new URL(request.nextUrl);
    const unpadded = UNPADDED_M.exec(m);
    if (unpadded) {
      // 2026-9 → 2026-09 (同じ内容の重複URLを潰す)
      target.searchParams.set("m", `${unpadded[1]}-${unpadded[2].padStart(2, "0")}`);
    } else {
      // 不正値 (abc / 2026-13 / 2026-11-01) は既定期間 (=クエリなし) へ
      target.searchParams.delete("m");
    }
    const redirectResponse = NextResponse.redirect(target, 308);
    if (isProd) {
      redirectResponse.headers.set("Content-Security-Policy", csp);
      redirectResponse.headers.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    return redirectResponse;
  }

  // nonceをNextのレンダリングへ渡す (requestヘッダー経由でNextが
  // インラインスクリプトへ自動nonceを付与する)
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  if (isProd) requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (isProd) {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // HTMLのCache-Controlはnginx (GitOps) が proxy_hide_header 後に入れ替える
    // (max-age=120 + stale-while-revalidate / 管理者Cookie時はno-store) のため触らない
  }
  return response;
}

export const config = {
  // /api/* と静的成果物 (favicon / マニフェスト / _next) にはCSPは不要
  matcher: [
    "/((?!api/|guild-icon|_next/static|_next/image|favicon.ico|apple-touch-icon.png|manifest.webmanifest).*)",
  ],
};
