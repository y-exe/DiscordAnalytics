import type { Metadata } from "next";
import RelationGraphView from "@/components/views/RelationGraphView";
import {
  DiscordComponentEmbedScript,
  buildComponentEmbed,
  socialMetadata,
} from "@/lib/discord-embed";
import { DEFAULT_SITE_ORIGIN, getGuildBaseUrl, getGuildContext } from "@/lib/guild-context";
import { canonicalPeriodPath, parsePeriod, periodLabel } from "@/lib/period";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ m?: string }> };

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { m } = await searchParams;
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const period = parsePeriod(m);
  const subject = guild.name || "Discordサーバー";
  const title = `共通のかかわり (${periodLabel(period)})`;
  const description = `${subject}のメンバー間の結び付きをグラフで可視化 (${periodLabel(period)})。`;
  return socialMetadata({
    title,
    description,
    url: `${baseUrl ?? DEFAULT_SITE_ORIGIN}${canonicalPeriodPath("/relation", period)}`,
    imageUrl: guild.iconUrl,
  });
}

export default async function RelationPage({ searchParams }: PageProps) {
  const { m } = await searchParams;
  // 非正形の m は proxy.ts がレンダー前に正規URLへ集約する
  const period = parsePeriod(m);
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const base = baseUrl ?? DEFAULT_SITE_ORIGIN;
  const subject = guild.name || "Discordサーバー";
  const url = `${base}/relation`;
  const label = periodLabel(period);
  const embed = buildComponentEmbed({
    title: `共通のかかわり (${label})`,
    url,
    description: `${subject}のメンバー間の結び付きをインタラクティブなグラフで閲覧できます。`,
    thumbnailUrl: guild.iconUrl,
    buttons: [
      { label: "メンバー", url: `${base}/members` },
      { label: "チャンネル", url: `${base}/channels` },
      { label: "比較", url: `${base}/compare` },
    ],
    footer: `${subject} ・ ${label}`,
  });
  return (
    <>
      <DiscordComponentEmbedScript payload={embed} />
      {/* グラフビューはクライアント描画のため、h1はサーバー側で出す (スクリーンリーダー/SEO用) */}
      <h1 className="sr-only">{`共通のかかわり (${label})`}</h1>
      <RelationGraphView period={period} />
    </>
  );
}
