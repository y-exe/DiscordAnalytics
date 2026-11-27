import type { Metadata } from "next";
import RestrictedMonthGate from "@/components/views/RestrictedMonthGate";
import SummaryView from "@/components/views/SummaryView";
import { fetchAPI } from "@/lib/api";
import { DEFAULT_SITE_ORIGIN, getGuildBaseUrl, getGuildContext } from "@/lib/guild-context";
import { isPublishedReportMonth } from "@/lib/report-period";
import { canonicalPeriodPath, defaultPeriod, parsePeriod, periodLabel } from "@/lib/period";
import { serializeJsonLd } from "@/lib/seo";

type PageProps = { searchParams: Promise<{ m?: string }> };

/** 既定期間 (最新公開月) はクエリなしの / を正とする */
function canonicalPathForSearch(m: string | undefined): string {
  const period = parsePeriod(m);
  if (period.isAll) return "/?m=all";
  return period.key === defaultPeriod().key ? "/" : `/?m=${period.key}`;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { m } = await searchParams;
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const base = baseUrl ?? DEFAULT_SITE_ORIGIN;
  const subject = guild.name || "Discordサーバー";
  const period = parsePeriod(m);
  const title = period.isAll ? "総合ランキング" : `${periodLabel(period)}の統計`;

  // descriptionは月ごとに実数値を入れて差別化する (クローラーへの重複コンテンツ対策)
  const stats = await fetchInitialParts({
    isAll: period.isAll,
    year: period.year ?? undefined,
    month: period.month ?? undefined,
  });
  const analysis = stats?.analysis as { total?: number; unique_users?: number } | null | undefined;
  const volume =
    typeof analysis?.total === "number" && analysis.total > 0
      ? `発言${analysis.total.toLocaleString("ja-JP")}件・参加${(analysis.unique_users ?? 0).toLocaleString("ja-JP")}人。`
      : "";
  const description = period.isAll
    ? `${subject}の全期間の累計統計。${volume}総発言数・メンバー別ランキング・チャンネル別の比較グラフを表示します。`
    : `${periodLabel(period)}の${subject}の活動データ。${volume}日別の推移・時間帯別ヒートマップ・チャンネル別シェアを表示します。`;
  const url = `${base}${canonicalPathForSearch(m)}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: [`${base}/og?m=${period.isAll ? "all" : period.key}`],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${base}/og?m=${period.isAll ? "all" : period.key}`],
    },
  };
}

export default async function SummaryPage({ searchParams }: PageProps) {
  const { m } = await searchParams;
  // 非正形の m は proxy.ts がレンダー前に308で正規URLへ集約する
  const period = parsePeriod(m);
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const embedBase = baseUrl ? `${baseUrl}/api` : `${DEFAULT_SITE_ORIGIN}/api`;

  if (period.isAll) {
    const initial = await fetchInitialParts({ isAll: true });
    const analysis = initial?.analysis as { total?: number; unique_users?: number } | null;
    return (
      <>
        <link
          rel="discord:component-embed"
          type="application/json"
          href={`${embedBase}/ranking/total/discord-embed`}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              "@context": "https://schema.org",
              "@type": "Dataset",
              name: `${guild.name || "Discordサーバー"} 全期間の活動統計`,
              description: `Discordサーバーの全期間の発言数ランキング・チャンネル別統計・時間帯別の活動データ。`,
              url: `${baseUrl ?? DEFAULT_SITE_ORIGIN}/?m=all`,
              creator: { "@type": "Organization", name: guild.name || undefined },
              keywords: ["Discord", "統計", "ランキング", "アクティビティ"],
            }),
          }}
        />
        <SummaryView year={null} month={null} isAll={true} initialParts={initial} />
      </>
    );
  }

  const year = period.year ?? 0;
  const month = period.month ?? 0;
  const isPublished = isPublishedReportMonth(year, month);
  const initial = isPublished ? await fetchInitialParts({ isAll: false, year, month }) : undefined;
  return (
    <>
      {isPublished && (
        <link
          rel="discord:component-embed"
          type="application/json"
          href={`${embedBase}/ranking/monthly/${year}/${month}/discord-embed`}
        />
      )}
      {isPublished && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              "@context": "https://schema.org",
              "@type": "Dataset",
              name: `${guild.name || "Discordサーバー"} ${periodLabel(period)}の活動統計`,
              description: `${period.year}年${period.month}月のDiscordサーバー発言数ランキング・チャンネル別統計・時間帯別の活動データ。`,
              url: `${baseUrl ?? DEFAULT_SITE_ORIGIN}/?m=${period.key}`,
              creator: { "@type": "Organization", name: guild.name || undefined },
              temporalCoverage: `${period.year}-${String(period.month).padStart(2, "0")}-01/${period.year}-${String(period.month).padStart(2, "0")}-31`,
              keywords: ["Discord", "統計", "ランキング", "アクティビティ"],
            }),
          }}
        />
      )}
      {isPublished ? (
        <SummaryView year={year} month={month} isAll={false} initialParts={initial} />
      ) : (
        <RestrictedMonthGate label={`${periodLabel(period)}のレポート`}>
          <SummaryView year={year} month={month} isAll={false} />
        </RestrictedMonthGate>
      )}
    </>
  );
}

/** KPI・推移カードのデータをサーバー側で取得し、初回HTMLに埋め込む。
 * これがないと初回表示がスケルトンのみになりLCP・SEOが大きく落ちる。
 * 失敗時はundefined (クライアントが通常通り取得する)。 */
async function fetchInitialParts(period: {
  isAll: boolean;
  year?: number;
  month?: number;
}): Promise<{ history: unknown; analysis: unknown } | undefined> {
  const base = period.isAll ? "/total" : `/${period.year}/${period.month}`;
  const [history, analysis] = await Promise.all([
    fetchAPI(`/stats/history${base}`, { quiet: true, retries: 1 })
      .then((res) => (res.ok ? res.json() : undefined))
      .catch(() => undefined),
    fetchAPI(`/stats/analysis${base}?extras=0`, { quiet: true, retries: 1 })
      .then((res) => (res.ok ? res.json() : res.status === 404 ? null : undefined))
      .catch(() => undefined),
  ]);
  if (history === undefined && analysis === undefined) return undefined;
  return { history, analysis };
}
