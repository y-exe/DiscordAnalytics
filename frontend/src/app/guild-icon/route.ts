import { NextRequest, NextResponse } from "next/server";
import { getGuildContext, sizedIconPng } from "@/lib/guild-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 許可するアイコンサイズ (Discord CDNの標準ステップに合わせる) */
const SIZES = new Set([64, 128, 180, 256, 512]);

/**
 * ギルドアイコンを同一オリジンで配信する (favicon / apple-touch-icon / PWA manifest用)。
 * CDN直リンクだとPWAインストールやオフライン時に壊れうるためプロキシする。
 * アイコン自体は日の単位で変わりうるため1日キャッシュ。
 */
export async function GET(request: NextRequest): Promise<Response> {
  const guild = await getGuildContext();
  const icon = sizedIconPng(guild.iconUrl, 512);
  if (!icon) return NextResponse.redirect(new URL("/apple-touch-icon.png", request.url), 307);

  const sizeParam = Number(request.nextUrl.searchParams.get("s") ?? 256);
  const size = SIZES.has(sizeParam) ? sizeParam : 256;
  const cdnUrl = sizedIconPng(guild.iconUrl, size);
  if (!cdnUrl) return NextResponse.redirect(new URL("/apple-touch-icon.png", request.url), 307);

  const response = await fetch(cdnUrl, { cache: "no-store" });
  if (!response.ok) {
    return NextResponse.redirect(new URL("/apple-touch-icon.png", request.url), 307);
  }
  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
