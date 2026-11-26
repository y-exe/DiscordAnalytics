import type { Metadata } from "next";
import RestrictedMonthGate from "@/components/views/RestrictedMonthGate";
import SummaryView from "@/components/views/SummaryView";
import { fetchAPI } from "@/lib/api";
import { DEFAULT_SITE_ORIGIN, getGuildBaseUrl, getGuildContext } from "@/lib/guild-context";
import { isPublishedReportMonth } from "@/lib/report-period";
import { defaultPeriod, parsePeriod, periodLabel } from "@/lib/period";

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
  const description = period.isAll
    ? `${subject}の総合ランキングと活動データです。`
    : `${periodLabel(period)}の${subject}の活動データです。`;
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
  const period = parsePeriod(m);
  const baseUrl = await getGuildBaseUrl();
  const embedBase = baseUrl ? `${baseUrl}/api` : `${DEFAULT_SITE_ORIGIN}/api`;

  if (period.isAll) {
    const initial = await fetchInitialParts({ isAll: true });
    return (
      <>
        <link
          rel="discord:component-embed"
          type="application/json"
          href={`${embedBase}/ranking/total/discord-embed`}
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
