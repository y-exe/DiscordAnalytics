import { NextRequest, NextResponse } from "next/server";

/**
 * 本番向けCSP (nonce付き) を発行するmiddleware。
 * nonceはレスポンスごとに変わるため next.config の headers() では出せず、
 * ここで生成してCSPヘッダーに埋め込む。Next.jsはリクエストヘッダーのCSPに
 * nonceがあるとハイドレーション用インラインスクリプトへ同一nonceを自動付与する。
 *
 * style-srcは 'unsafe-inline' を維持する (chart等のstyle=""属性値をハッシュ
 * 付きで許可するのは実務的に不可能なため)。script-srcのみ実効性を上げる。
 *
 * HSTSもここで出す (includeSubDomains付き)。
 */
export function middleware(request: NextRequest): NextResponse {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    "default-src 'self'",
    isProd ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://cdn.discordapp.com",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  // nonceをNextのレンダリングへ渡す (requestヘッダー経由でNextが
  // インラインスクリプトへ同一nonceを自動付与する)
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  if (isProd) requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (isProd) {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}

export const config = {
  // /api/* と静的資産 (favicon / マニフェスト / _next) にはCSPは不要
  matcher: [
    "/((?!api/|guild-icon|_next/static|_next/image|favicon.ico|apple-touch-icon.png|manifest.webmanifest).*)",
  ],
};
