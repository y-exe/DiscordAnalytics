"use client";

/**
 * EasyUI (https://easyui.site) ラッパー群。
 * サマリー / チャンネル / メンバーの各ビューで共通利用する。
 */

import { ActivityHeatmap } from "@/components/ui/easyui/ActivityHeatmap";
import { BarChart } from "@/components/ui/easyui/BarChart";
import { DonutChart } from "@/components/ui/easyui/DonutChart";
import { InteractiveAreaChart, type ChartPoint } from "@/components/ui/easyui/InteractiveAreaChart";

export const CHART_ACCENT = "#3964fe";

const jaNum = new Intl.NumberFormat("ja-JP");
const jaCompact = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

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
    <InteractiveAreaChart
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
    <BarChart
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
      <ActivityHeatmap
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
}: {
  channels: { name: string; value: number }[];
  max?: number;
  /** ドーナツ下の凡例リスト。カード本体では false にしてダイアログでのみ表示する */
  showLegend?: boolean;
}) {
  const data = channels.slice(0, max).map((c) => ({ label: `#${c.name}`, value: c.value }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  return (
    <div className={showLegend ? "" : "flex justify-center"}>
      <DonutChart
        data={data}
        size={220}
        thickness={18}
        centerLabel="合計"
        formatValue={(n) => `${jaNum.format(Math.round(n))}件`}
        showLegend={showLegend}
        /* 凡例あり (ダイアログ) のときはドーナツ+凡例の行を中央寄せにする */
        className={showLegend ? "justify-center" : ""}
        ariaLabel="チャンネル別発言シェア"
      />
    </div>
  );
}
