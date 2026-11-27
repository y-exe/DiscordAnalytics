"use client";

/**
 * EasyUI (https://easyui.site) ラッパー群。
 * サマリー / チャンネル / メンバーの各ビューで共通利用する。
 *
 * チャート本体 (framer-motion依存を含む) は next/dynamic で遅延読み込みする。
 * カード側は ready判定のスケルトンを先に出すため、チャンク取得中も崩れない。
 */

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { ChartPoint } from "@/components/ui/easyui/InteractiveAreaChart";

export type { ChartPoint };

export const CHART_ACCENT = "#3964fe";

const jaNum = new Intl.NumberFormat("ja-JP");
const jaCompact = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

function chartSkeleton(height?: number) {
  return <div className="skeleton w-full rounded-xl" style={{ height: height ?? 220 }} />;
}

const LazyActivityHeatmap = dynamic(
  () => import("@/components/ui/easyui/ActivityHeatmap").then((m) => m.ActivityHeatmap),
  { loading: () => chartSkeleton(220) },
);
const LazyBarChart = dynamic(
  () => import("@/components/ui/easyui/BarChart").then((m) => m.BarChart),
  { loading: () => chartSkeleton(260) },
);
const LazyDonutChart = dynamic(
  () => import("@/components/ui/easyui/DonutChart").then((m) => m.DonutChart),
  { loading: () => chartSkeleton(220) },
);
const LazyInteractiveAreaChart = dynamic(
  () => import("@/components/ui/easyui/InteractiveAreaChart").then((m) => m.InteractiveAreaChart),
  { loading: () => chartSkeleton(260) },
);

/* ------------------------------ 日別の発言数推移 ------------------------------ */

export function DailyTrendChart({
  points,
  height,
  fill = false,
  formatValue,
  className = "",
}: {
  points: ChartPoint[];
  /** 固定高さ (px)。fill=true では親要素の高さに追従 */
  height?: number;
  fill?: boolean;
  formatValue?: (n: number) => string;
  className?: string;
}) {
  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  return (
    <LazyInteractiveAreaChart
      data={{ 発言数: points }}
      showHeader={false}
      fill={fill}
      height={height}
      color={CHART_ACCENT}
      locale="ja-JP"
      formatValue={formatValue}
      ariaLabel="日別の発言数推移"
      className={className}
    />
  );
}

/* ------------------------------ 曜日別/時間帯別バー ----------------------------- */

export function CategoryBarChart({
  data,
  height = 260,
  unit = "件",
}: {
  data: { label: string; value: number }[];
  height?: number;
  unit?: string;
}) {
  return (
    <LazyBarChart
      data={data}
      series={[{ key: "value", label: "発言数", color: CHART_ACCENT }]}
      height={height}
      formatValue={(n) => `${jaNum.format(n)}${unit}`}
      formatTick={(n) => (n >= 10000 ? jaCompact.format(n) : jaNum.format(n))}
      showLegend
      ariaLabel="カテゴリ別の発言数"
    />
  );
}

/* --------------------------- 時間帯別アクティビティ --------------------------- */

export function ActivityHeatChart({
  matrix,
  className = "",
}: {
  /** 時間帯モード用の 7×24 マトリックス */
  matrix: number[][];
  className?: string;
}) {
  const total = matrix.flat().reduce((s, v) => s + v, 0);
  return (
    <div className={className}>
      <div className="mb-3">
        <p className="text-sm font-black text-foreground">時間帯別アクティビティ</p>
        <p className="mt-0.5 text-xs font-bold text-muted-foreground">曜日 × 時間帯の発言集中度</p>
      </div>
      <LazyActivityHeatmap
        mode="hours"
        matrix={matrix}
        rowLabels={["日", "月", "火", "水", "木", "金", "土"]}
        color={CHART_ACCENT}
        unit="件の発言"
        summary={`${jaNum.format(total)}件の発言`}
        peakLabel="ピーク"
        locale="ja-JP"
        weekStart={0}
        ariaLabel="時間帯別アクティビティのヒートマップ"
      />
    </div>
  );
}

/* ------------------------------ チャンネル別シェア ----------------------------- */

export function ChannelShareDonut({
  channels,
  max = 6,
  showLegend = true,
  size = 220,
}: {
  channels: { name: string; value: number }[];
  max?: number;
  /** ドーナツ下の凡例リスト。カード本体では false にしてダイアログでのみ表示する */
  showLegend?: boolean;
  /** ドーナツの直径。カード幅が狭いときは小さくする */
  size?: number;
}) {
  const data = channels.slice(0, max).map((c) => ({ label: `#${c.name}`, value: c.value }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  const props = {
    data,
    size,
    thickness: 18,
    centerLabel: "合計",
    formatValue: (n: number) => `${jaNum.format(Math.round(n))}件`,
    showLegend,
    /* 凡例あり (ダイアログ) のときはドーナツ+凡例の行を中央寄せにする */
    className: showLegend ? "justify-center" : "",
    ariaLabel: "チャンネル別発言シェア",
  } satisfies ComponentProps<typeof LazyDonutChart>;
  return (
    <div className={showLegend ? "" : "flex justify-center"}>
      <LazyDonutChart {...props} />
    </div>
  );
}
