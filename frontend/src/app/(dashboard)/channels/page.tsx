import type { Metadata } from "next";
import ChannelsView from "@/components/views/ChannelsView";
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
  const title = `チャンネル (${periodLabel(period)})`;
  const description = `${subject}のチャンネル別アクティビティ (${periodLabel(period)})。発言数の多いチャンネルランキングと前期間との比較を表示します。`;
  return socialMetadata({
    title,
    description,
    url: `${baseUrl ?? DEFAULT_SITE_ORIGIN}${canonicalPeriodPath("/channels", period)}`,
    imageUrl: guild.iconUrl,
  });
}

export default async function ChannelsPage({ searchParams }: PageProps) {
  const { m } = await searchParams;
  // 非正形の m は proxy.ts がレンダー前に正規URLへ集約する
  const period = parsePeriod(m);
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const base = baseUrl ?? DEFAULT_SITE_ORIGIN;
  const subject = guild.name || "Discordサーバー";
  const url = `${base}/channels`;
  const label = periodLabel(period);
  const embed = buildComponentEmbed({
    title: `チャンネル (${label})`,
    url,
    description: `${subject}のチャンネル別アクティビティを閲覧できます。`,
    thumbnailUrl: guild.iconUrl,
    buttons: [
      { label: "メンバー", url: `${base}/members` },
      { label: "共通のかかわり", url: `${base}/relation` },
      { label: "比較", url: `${base}/compare` },
    ],
    footer: `${subject} ・ ${label}`,
  });
  return (
    <>
      <DiscordComponentEmbedScript payload={embed} />
      <ChannelsView period={period} />
    </>
  );
}
