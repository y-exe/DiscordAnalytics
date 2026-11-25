import { ImageResponse } from "next/og";
import { NextRequest, NextResponse } from "next/server";
import { fetchAPI } from "@/lib/api";
import { getGuildContext } from "@/lib/guild-context";
import { parsePeriod, periodLabel } from "@/lib/period";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 630;

/** satori用フォントキャッシュ (textサブセットごとに取得し、プロセス内で再利用) */
const fontCache = new Map<string, ArrayBuffer>();

/** 必要なグリフだけのNoto Sans JPサブセットを取得する (satoriに日本語を描けるように) */
async function loadFont(text: string, weight: 700 | 900): Promise<ArrayBuffer | null> {
  const key = `${weight}:${text}`;
  const cached = fontCache.get(key);
  if (cached) return cached;
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}&text=${encodeURIComponent(text)}`,
      { cache: "no-store" },
    ).then((res) => res.text());
    // text=サブセット指定時はformat('truetype')のURLが返る (拡張子なしの /l/font?kit= 形式)
    const url = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
    if (!url) return null;
    const buffer = await fetch(url, { cache: "no-store" }).then((res) => res.arrayBuffer());
    fontCache.set(key, buffer);
    if (fontCache.size > 30) fontCache.delete(fontCache.keys().next().value as string);
    return buffer;
  } catch {
    return null;
  }
}

/** satoriのサブセットフォントに無い字形 (絵文字・記号) が□になるためOG表示では落とす */
function ogSafeText(text: string): string {
  return text.replace(
    /[\u{1F000}-\u{10FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu,
    "",
  );
}

interface RankRow {
  display_name: string;
  count: number;
}

/**
 * 月別の共有カード (og:image) を動的に生成する。
 * 全期間・全月で同じ静的画像を使わず、ギルド名・期間・上位3名を載せる。
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const period = parsePeriod(searchParams.get("m") ?? undefined);
  const label = periodLabel(period);

  const [guild, ranking] = await Promise.all([
    getGuildContext(),
    fetchAPI(period.isAll ? "/ranking/total" : `/ranking/monthly/${period.year}/${period.month}`, {
      quiet: true,
      retries: 0,
    })
      .then((res) => (res.ok ? (res.json() as Promise<RankRow[]>) : null))
      .catch(() => null),
  ]);

  const subject = ogSafeText(guild.name || "Discordサーバー");
  const top = (ranking ?? [])
    .slice(0, 3)
    .map((row) => ({ ...row, display_name: ogSafeText(row.display_name) }));
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";

  const texts = [
    ...`${subject}${label}Discord Analytics${host}発言数1.2.3位`,
    ...top.map((r) => r.display_name),
  ].join("");
  const [font700, font900] = await Promise.all([loadFont(texts, 700), loadFont(texts, 900)]);
  // フォント取得に失敗したら静的画像へフォールバック (日本語が豆腐になるのを避ける)
  if (!font700) {
    return NextResponse.redirect(new URL("/ranking.webp", request.url), 307);
  }

  let png: Response;
  let buffer: ArrayBuffer | undefined;
  try {
    png = new ImageResponse(
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 64px",
          backgroundColor: "#0a0a0a",
          color: "#fafafa",
          backgroundImage:
            "radial-gradient(circle at 85% 15%, rgba(88,101,242,0.22), transparent 55%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: 44,
              backgroundColor: "#1f1f23",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 44,
              fontWeight: 900,
              color: "#7f8dff",
            }}
          >
            {subject.slice(0, 1)}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 44, fontWeight: 900 }}>{subject}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#a1a1aa" }}>
              {`${label}の統計`}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {top.map((row, index) => (
            <div key={index} style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: "#7f8dff", width: 44 }}>
                {`${String(index + 1)}`}
              </div>
              <div style={{ fontSize: 38, fontWeight: 700, maxWidth: 640 }}>
                {`${row.display_name}`}
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#a1a1aa" }}>
                {`${row.count.toLocaleString("ja-JP")}発言`}
              </div>
            </div>
          ))}
          {top.length === 0 && (
            <div style={{ fontSize: 38, fontWeight: 700, color: "#a1a1aa" }}>
              {`${label}のランキング`}
            </div>
          )}
        </div>
        <div style={{ display: "flex", fontSize: 24, fontWeight: 700, color: "#71717a" }}>
          {host}
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        fonts: [
          { name: "Noto Sans JP", data: font700, weight: 700, style: "normal" },
          ...(font900
            ? [{ name: "Noto Sans JP", data: font900, weight: 900, style: "normal" } as const]
            : []),
        ],
      },
    );
    buffer = await png.arrayBuffer();
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
    const message =
      error instanceof Error
        ? `${error.message}
CAUSE: ${cause?.message ?? "-"}`
        : "og error";
    return new NextResponse(message, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
