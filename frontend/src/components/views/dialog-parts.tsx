"use client";

/**
 * カード拡大ダイアログの共通パーツ。
 * DialogStats は統計グリッド、HeatDialogContent / TrendDialogContent は
 * ヒートマップ・日別推移の「情報量を増やした」ダイアログ中身。
 */

import type { ReactNode } from "react";
import { BarChart } from "@/components/ui/easyui/BarChart";
import { DonutChart } from "@/components/ui/easyui/DonutChart";
import { ActivityHeatmap } from "@/components/ui/easyui/ActivityHeatmap";
import { ActivityHeatChart, CHART_ACCENT, CategoryBarChart, DailyTrendChart } from "./charts";

export const jaNum = new Intl.NumberFormat("ja-JP");
export const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/* --------------------------- 派生計算ヘルパー --------------------------- */

/** 中央値 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 標準偏差 (母標準偏差) */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** 日次系列から最長連続活動日数 (値>0の日が連続した最大長) */
export function streakDays(daily: { date: number; value: number }[]): number {
  const days = [...daily]
    .filter((p) => p.value > 0)
    .map((p) => Math.floor(p.date / 86400000))
    .sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = -1;
  for (const day of days) {
    run = day === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

/** 期間を前半/後半に分けた合計 */
export function splitHalves(daily: { date: number; value: number }[]): {
  first: number;
  second: number;
} {
  if (daily.length === 0) return { first: 0, second: 0 };
  const sorted = [...daily].sort((a, b) => a.date - b.date);
  const mid = Math.ceil(sorted.length / 2);
  const sum = (arr: typeof sorted) => arr.reduce((s, p) => s + p.value, 0);
  return { first: sum(sorted.slice(0, mid)), second: sum(sorted.slice(mid)) };
}

/** 曜日 (0=日) ごとの 7日バケット合計 → 「1/1〜1/7週」ラベル */
export function weeklyBuckets(daily: { date: number; value: number }[]): {
  label: string;
  value: number;
}[] {
  const buckets = new Map<number, { start: number; end: number; value: number }>();
  for (const p of daily) {
    const d = new Date(p.date);
    // 月曜始まりの週キー
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = Math.floor(monday.getTime() / 86400000);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.value += p.value;
      bucket.end = Math.max(bucket.end, p.date);
    } else {
      buckets.set(key, { start: p.date, end: p.date, value: p.value });
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.start - b.start)
    .map((b) => {
      const fmt = (t: number) => {
        const dt = new Date(t);
        return `${dt.getMonth() + 1}/${dt.getDate()}`;
      };
      return { label: `${fmt(b.start)}〜`, value: b.value };
    });
}

/** 時間帯を4分割した比率 (深夜0-6 / 朝6-12 / 昼12-18 / 夜18-24) */
export function timeOfDaySplit(matrix: number[][]): { label: string; value: number }[] {
  const ranges = [
    { label: "深夜 (0-6時)", from: 0, to: 6 },
    { label: "朝 (6-12時)", from: 6, to: 12 },
    { label: "昼 (12-18時)", from: 12, to: 18 },
    { label: "夜 (18-24時)", from: 18, to: 24 },
  ];
  return ranges.map(({ label, from, to }) => ({
    label,
    value: matrix.reduce((s, row) => s + row.slice(from, to).reduce((a, v) => a + v, 0), 0),
  }));
}

/** 曜日別データから平日/週末の合計 */
export function weekdayWeekend(dowData: { label: string; value: number }[]): {
  weekday: number;
  weekend: number;
} {
  let weekday = 0;
  let weekend = 0;
  dowData.forEach((d, dow) => {
    if (dow === 0 || dow === 6) weekend += d.value;
    else weekday += d.value;
  });
  return { weekday, weekend };
}

/** 上位 n 件の占有率 (0-1) */
export function topShare(values: number[], n: number, total?: number): number | null {
  const sum = total ?? values.reduce((s, v) => s + v, 0);
  if (sum <= 0) return null;
  return values.slice(0, n).reduce((s, v) => s + v, 0) / sum;
}

/** 日付 (ms) を M/D 表記に */
export function fmtDay(t: number): string {
  const dt = new Date(t);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

/** 曜日ラベル (日..土) */
export function dowLabel(t: number): string {
  return DOW_LABELS[new Date(t).getDay()];
}

/* ------------------------------ セクション部品 ------------------------------ */

/** ダイアログ内の小見出し付きセクション */
export function DialogSection({
  title,
  note,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <p className="text-sm font-black text-foreground">{title}</p>
      {note && <p className="mt-0.5 text-xs font-bold text-muted-foreground">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** 構成比ドーナツ (時間帯比率・シェアなど) */
export function RatioDonut({
  items,
  unit = "",
  centerLabel = "合計",
}: {
  items: { label: string; value: number }[];
  unit?: string;
  centerLabel?: string;
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  return (
    <DonutChart
      data={items}
      size={180}
      thickness={16}
      centerLabel={centerLabel}
      formatValue={(n) => `${jaNum.format(Math.round(n))}${unit}`}
      showLegend
      className="justify-center"
      ariaLabel="構成比"
    />
  );
}

/** 2値比較バー (前半/後半・平日/週末など) */
export function SplitBar({
  left,
  right,
  unit = "",
}: {
  left: { label: string; value: number };
  right: { label: string; value: number };
  unit?: string;
}) {
  const total = left.value + right.value;
  const leftPct = total > 0 ? (left.value / total) * 100 : 50;
  return (
    <div>
      <div className="flex h-7 w-full overflow-hidden rounded-lg text-[11px] font-bold text-white">
        <div
          className="flex items-center justify-start bg-[#3964fe] pl-2"
          style={{ width: `${leftPct}%` }}
        >
          {leftPct >= 18 && <span>{Math.round(leftPct)}%</span>}
        </div>
        <div
          className="flex items-center justify-end bg-muted-foreground/60 pr-2"
          style={{ width: `${100 - leftPct}%` }}
        >
          {100 - leftPct >= 18 && <span>{Math.round(100 - leftPct)}%</span>}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] font-bold text-muted-foreground">
        <span>
          {left.label} {jaNum.format(Math.round(left.value))}
          {unit}
        </span>
        <span>
          {right.label} {jaNum.format(Math.round(right.value))}
          {unit}
        </span>
      </div>
    </div>
  );
}

/** 日別データのカレンダー表示 (活動日の可視化) */
export function ActivityCalendar({
  daily,
  unit = "件",
}: {
  daily: { date: number; value: number }[];
  unit?: string;
}) {
  const heat = daily.map((p) => {
    const d = new Date(p.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date: key, value: p.value };
  });
  if (heat.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <ActivityHeatmap
          mode="calendar"
          data={heat}
          color={CHART_ACCENT}
          unit={unit}
          locale="ja-JP"
          ariaLabel="活動カレンダー"
        />
      </div>
    </div>
  );
}

/** 横並びの2カラムセクション */
export function TwoColumns({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{children}</div>;
}

/* ------------------------------ 統計グリッド ------------------------------ */

export interface DialogStatItem {
  label: string;
  value: ReactNode;
  /** 値の下に小さく添える補足 (対象日・件数など) */
  sub?: string;
}

const COLS_CLASS: Record<2 | 3 | 4, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

/** ダイアログ上部のサマリー統計グリッド */
export function DialogStats({
  items,
  columns = 4,
  className = "",
}: {
  items: DialogStatItem[];
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`grid grid-cols-2 gap-2 ${COLS_CLASS[columns]} ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="rounded-xl bg-muted/60 px-3 py-2.5">
          <p className="text-[11px] font-bold text-muted-foreground">{item.label}</p>
          <p className="mt-0.5 truncate text-lg font-black leading-tight tracking-tight text-foreground tabular-nums">
            {item.value}
          </p>
          {item.sub && (
            <p className="truncate text-[11px] font-bold text-muted-foreground">{item.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* --------------------------- カテゴリ列の統計ヘルパー --------------------------- */

export interface LabeledValue {
  label: string;
  value: number;
}

/** 曜日別/時間帯別などのカテゴリ列から 合計・平均・最大・最少 の4項目を作る */
export function categoryStats(
  items: LabeledValue[],
  fmt: (n: number) => string,
  labels: { total?: string; avg?: string; max?: string; min?: string; unit?: string } = {},
): DialogStatItem[] {
  if (items.length === 0) return [];
  const total = items.reduce((s, it) => s + it.value, 0);
  let max = items[0];
  let min = items[0];
  for (const it of items) {
    if (it.value > max.value) max = it;
    if (it.value < min.value) min = it;
  }
  const unit = labels.unit ?? "";
  return [
    { label: labels.total ?? "合計", value: fmt(total), sub: unit || undefined },
    {
      label: labels.avg ?? "平均",
      value: fmt(Math.round((total / items.length) * 10) / 10),
      sub: unit || undefined,
    },
    { label: labels.max ?? "最大", value: fmt(max.value), sub: max.label },
    { label: labels.min ?? "最少", value: fmt(min.value), sub: min.label },
  ];
}

/** 時系列 (日別) から 合計・日平均・最多日・最少日 の4項目を作る */
export function timeSeriesStats(
  points: { date: number; value: number }[],
  fmt: (n: number) => string,
  labels: { total?: string; avg?: string; max?: string; min?: string; unit?: string } = {},
  /** 日付ラベルの整形 (既定は M/D) */
  formatLabel: (d: number) => string = (d) => {
    const dt = new Date(d);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  },
): DialogStatItem[] {
  if (points.length === 0) return [];
  const total = points.reduce((s, p) => s + p.value, 0);
  let max = points[0];
  let min = points[0];
  for (const p of points) {
    if (p.value > max.value) max = p;
    if (p.value < min.value) min = p;
  }
  const unit = labels.unit ?? "";
  return [
    { label: labels.total ?? "合計", value: fmt(total), sub: unit || undefined },
    {
      label: labels.avg ?? "日平均",
      value: fmt(Math.round((total / points.length) * 10) / 10),
      sub: unit || undefined,
    },
    { label: labels.max ?? "最多日", value: fmt(max.value), sub: formatLabel(max.date) },
    { label: labels.min ?? "最少日", value: fmt(min.value), sub: formatLabel(min.date) },
  ];
}

/* --------------------- 時間帯別アクティビティのダイアログ中身 --------------------- */

/** ヒートマップ + 統計 + 曜日別/時間帯別バー (サマリー・チャンネル共通) */
export function HeatDialogContent({
  matrix,
  dowData,
  hourData,
}: {
  matrix: number[][];
  dowData: LabeledValue[];
  hourData: LabeledValue[];
}) {
  const total = matrix.flat().reduce((s, v) => s + v, 0);
  let peak = { dow: -1, hour: -1, count: 0 };
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[d]?.[h] > peak.count) peak = { dow: d, hour: h, count: matrix[d][h] };
    }
  }
  const maxDow = dowData.reduce(
    (best, cur) => (cur.value > best.value ? cur : best),
    dowData[0] ?? { label: "-", value: 0 },
  );
  const maxHour = hourData.reduce(
    (best, cur) => (cur.value > best.value ? cur : best),
    hourData[0] ?? { label: "-", value: 0 },
  );
  return (
    <div className="pr-7">
      <ActivityHeatChart matrix={matrix} />
      <DialogStats
        className="mt-4"
        items={[
          { label: "総発言数", value: jaNum.format(total), sub: "件" },
          {
            label: "最多曜日",
            value: `${maxDow.label}曜日`,
            sub: `${jaNum.format(maxDow.value)}件`,
          },
          {
            label: "最多時間帯",
            value: `${maxHour.label}:00台`,
            sub: `${jaNum.format(maxHour.value)}件`,
          },
          peak.dow >= 0
            ? {
                label: "ピークスロット",
                value: `${DOW_LABELS[peak.dow]} ${peak.hour}:00`,
                sub: `${jaNum.format(peak.count)}件`,
              }
            : { label: "ピークスロット", value: "—" },
        ]}
      />
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-black text-foreground">曜日別の発言数</p>
          <CategoryBarChart data={dowData} height={220} />
        </div>
        <div>
          <p className="mb-2 text-sm font-black text-foreground">時間帯別の発言数</p>
          <CategoryBarChart data={hourData} height={220} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------ 日別推移のダイアログ中身 ------------------------ */

export interface TrendSecondary {
  title: string;
  points: { date: number; value: number }[];
  formatValue?: (n: number) => string;
}

/** 統計 + メインチャート + (任意の) 補助チャート列 */
export function TrendDialogContent({
  points,
  unit = "件",
  totalLabel = "総発言数",
  secondary = [],
}: {
  points: { date: number; value: number }[];
  unit?: string;
  totalLabel?: string;
  secondary?: TrendSecondary[];
}) {
  const jaCompact = new Intl.NumberFormat("ja-JP", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const fmtTick = (n: number) => (n >= 10000 ? jaCompact.format(n) : jaNum.format(n));
  return (
    <div className="pr-7">
      <DialogStats
        items={timeSeriesStats(points, (n) => jaNum.format(n), { unit, total: totalLabel })}
      />
      <div className="mt-4">
        <p className="mb-2 text-sm font-black text-foreground">日別の発言数推移</p>
        <DailyTrendChart points={points} height={300} />
      </div>
      {secondary.length > 0 && (
        <div className={`mt-5 grid gap-4 ${secondary.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {secondary.map((s) => (
            <div key={s.title}>
              <p className="mb-2 text-sm font-black text-foreground">{s.title}</p>
              <DailyTrendChart points={s.points} height={180} formatValue={s.formatValue} />
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-right text-[11px] font-bold text-muted-foreground">
        統計は表示中の期間 ({points.length}日分) が対象
      </p>
    </div>
  );
}
