import type { Metadata } from "next";
import MembersView from "@/components/views/MembersView";
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
  const title = `メンバー (${periodLabel(period)})`;
  const description = `${subject}のメンバー別アクティビティ (${periodLabel(period)})。発言数・文字数の上位メンバーを一覧できます。`;
  return socialMetadata({
    title,
    description,
    url: `${baseUrl ?? DEFAULT_SITE_ORIGIN}${canonicalPeriodPath("/members", period)}`,
    imageUrl: guild.iconUrl,
  });
}

export default async function MembersPage({ searchParams }: PageProps) {
  const { m } = await searchParams;
  // 非正形の m は proxy.ts がレンダー前に正規URLへ集約する
  const period = parsePeriod(m);
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const base = baseUrl ?? DEFAULT_SITE_ORIGIN;
  const subject = guild.name || "Discordサーバー";
  const url = `${base}/members`;
  const label = periodLabel(period);
  const embed = buildComponentEmbed({
    title: `メンバー (${label})`,
    url,
    description: `${subject}のメンバー別ランキングと活動データを閲覧できます。`,
    thumbnailUrl: guild.iconUrl,
    buttons: [
      { label: "チャンネル", url: `${base}/channels` },
      { label: "共通のかかわり", url: `${base}/relation` },
      { label: "比較", url: `${base}/compare` },
    ],
    footer: `${subject} ・ ${label}`,
  });
  return (
    <>
      <DiscordComponentEmbedScript payload={embed} />
      <MembersView period={period} />
    </>
  );
}
