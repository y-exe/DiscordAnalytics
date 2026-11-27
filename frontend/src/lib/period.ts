export interface Period {
  /** "YYYY-MM" または "all" (全期間) */
  key: string;
  year: number | null;
  month: number | null;
  isAll: boolean;
}

/** JSTで現在の「最新公開月」(前月) を返す */
export function latestPublishedMonth(now = new Date()): { year: number; month: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // UTC基準でJST月を取り、前月へ
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1; // 1-12
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function parsePeriod(raw: string | null | undefined, fallback?: Period): Period {
  if (raw === "all") return { key: "all", year: null, month: null, isAll: true };
  if (raw && /^\d{4}-(0?[1-9]|1[0-2])$/.test(raw)) {
    const [year, month] = raw.split("-").map(Number);
    // 正規形はゼロ埋め (2026-9 と 2026-09 が別URLにならないように)
    return { key: `${year}-${String(month).padStart(2, "0")}`, year, month, isAll: false };
  }
  return fallback ?? defaultPeriod();
}

/** URLの m パラメータとして正規 (そのまま使える) か */
export function isCanonicalPeriodParam(m: string): boolean {
  return m === "all" || /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

/**
 * m パラメータが正規形でない場合のリダイレクト先 (正規形に書き直したURL)。
 * 正規形 (または指定なし) の場合は null。不正値は既定期間へ落とす。
 */
export function canonicalPeriodRedirect(
  m: string | undefined,
  buildPath: (period: Period) => string,
): string | null {
  if (m === undefined) return null;
  if (isCanonicalPeriodParam(m)) return null;
  const period = parsePeriod(m);
  return buildPath(period);
}

/** ページのcanonicalパス。既定期間はクエリなし、月別はゼロ埋め ?m=、全期間は ?m=all */
export function canonicalPeriodPath(
  pathname: string,
  period: Period,
  defaultKey = defaultPeriod().key,
): string {
  if (period.isAll) return `${pathname}?m=all`;
  if (period.key === defaultKey) return pathname;
  return `${pathname}?m=${period.key}`;
}

export function defaultPeriod(): Period {
  const { year, month } = latestPublishedMonth();
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    year,
    month,
    isAll: false,
  };
}

export function periodLabel(period: Period): string {
  if (period.isAll) return "全期間";
  return `${period.year}年${period.month}月`;
}

export function shortPeriodLabel(period: Period): string {
  if (period.isAll) return "全期間";
  return `${period.year}.${String(period.month).padStart(2, "0")}`;
}

/** 期間を表すクエリパラメータ値。サイドバー/期間選択は既定月でも常に m= を付ける
 * (URLで期間を明示し、ページ間移動で期間が落ちないようにするため) */
export function periodQueryValue(period: Period): string | null {
  return period.key || null;
}

export function periodHref(
  pathname: string,
  period: Period,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams(extra ?? {});
  const m = periodQueryValue(period);
  if (m) params.set("m", m);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 直近nヶ月ぶんの月リスト (新しい順) */
export function recentMonths(
  count: number,
  now = new Date(),
): Array<{ year: number; month: number; key: string }> {
  const { year, month } = latestPublishedMonth(now);
  const list: Array<{ year: number; month: number; key: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    list.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    });
  }
  return list;
}

/** 前月 (サマリーの前期間比較用) */
export function previousMonthOf(period: Period): { year: number; month: number } | null {
  if (period.isAll || period.year === null || period.month === null) return null;
  return period.month === 1
    ? { year: period.year - 1, month: 12 }
    : { year: period.year, month: period.month - 1 };
}

const LAST_MONTHLY_KEY = "period.lastMonthly";

/** 選択した月別期間を記憶する (全期間→月別トグルで復帰できるように) */
export function rememberMonthlyPeriod(mParam: string): void {
  if (!/^\d{4}-(0?[1-9]|1[0-2])$/.test(mParam)) return;
  try {
    sessionStorage.setItem(LAST_MONTHLY_KEY, mParam);
  } catch {
    // プライベートモード等では記憶できないだけですぐ問題にはならない
  }
}

/** 全期間から月別へ戻るときのhref。直前に選んだ月を優先し、なければ最新公開月 */
export function lastMonthlyHref(pathname: string, searchParams?: URLSearchParams): string {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(LAST_MONTHLY_KEY);
  } catch {
    saved = null;
  }
  if (saved && /^\d{4}-(0?[1-9]|1[0-2])$/.test(saved)) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("m", saved);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }
  return periodHref(pathname, defaultPeriod());
}
