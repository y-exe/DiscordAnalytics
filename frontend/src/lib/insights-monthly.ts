/** insights系APIの daily (日別発言数) を月別グラフ/最終発言月に変換する共通処理 */

export interface DailyPoint {
  date: string;
  count: number;
}

/** 日別データを月ごとに合計したカテゴリ別グラフ用データ (昇順) */
export function monthlyFromDaily(daily: DailyPoint[]): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const point of daily) {
    if (point.count <= 0) continue;
    const [year, month] = point.date.split("-");
    const key = `${year}-${Number(month)}`;
    map.set(key, (map.get(key) ?? 0) + point.count);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => {
      const [year, month] = key.split("-");
      return {
        label: `${Number(year)}/${String(month).padStart(2, "0")}`,
        value: count,
      };
    });
}

/** 最後に発言のあった月 (なければnull) */
export function lastActiveMonth(daily: DailyPoint[]): { key: string; label: string } | null {
  const last = [...daily].reverse().find((p) => p.count > 0);
  if (!last) return null;
  const [year, month] = last.date.split("-").map(Number);
  return { key: `${year}-${month}`, label: `${year}年${month}月` };
}
