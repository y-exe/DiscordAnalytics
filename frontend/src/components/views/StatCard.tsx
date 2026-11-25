"use client";

import { useMemo, useState, type ReactNode } from "react";
import { BarChart } from "@/components/ui/easyui/BarChart";
import { InteractiveAreaChart, type ChartPoint } from "@/components/ui/easyui/InteractiveAreaChart";
import DeltaBadge from "./DeltaBadge";
import TileDialog from "./TileDialog";
import { DialogStats, type DialogStatItem } from "./dialog-parts";

export interface MiniSeriesPoint {
  label: string;
  value: number;
  /** 拡大ダイアログの日付軸用 (UTC ms)。未指定ならラベル順 */
  date?: number;
}

const ACCENT = "#3964fe";

export default function StatCard({
  title,
  value,
  unit,
  delta,
  series,
  footer,
  chartType = "area",
  showMiniChart = true,
  loading = false,
  dialogStats,
  dialogExtra,
  /** ダイアログを開いた時に呼ばれる (ポップアップ専用データの遅延取得に使う) */
  onDialogOpen,
  formatValue = (v: number) => v.toLocaleString("ja-JP"),
}: {
  title: string;
  value: string | number;
  unit?: string;
  /** 前期間比 (小数)。nullなら非表示 */
  delta?: number | null;
  /** ミニグラフ用データ (拡大ダイアログにも使う) */
  series?: MiniSeriesPoint[];
  footer?: ReactNode;
  chartType?: "area" | "bar";
  /** カード本体にミニグラフを出すか (falseでも拡大ダイアログには表示される) */
  showMiniChart?: boolean;
  /** trueで値・グラフをスケルトン表示 (タイトルはそのまま出す) */
  loading?: boolean;
  /** 拡大ダイアログの統計グリッド (curated)。未指定ならseriesから自動生成 */
  dialogStats?: DialogStatItem[];
  /** ダイアログを開いた時に呼ばれる */
  onDialogOpen?: () => void;
  /** 拡大ダイアログのグラフ下に追加するセクション */
  dialogExtra?: ReactNode;
  formatValue?: (value: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const values = series?.map((p) => p.value) ?? [];
  const points: ChartPoint[] = (series ?? []).map((p, i) => ({
    date: p.date ?? i * 86_400_000,
    value: p.value,
  }));
  const valueText = typeof value === "number" ? formatValue(value) : value;

  // 拡大ダイアログ用の統計グリッド (系列データがある場合のみ)
  const statItems = useMemo<DialogStatItem[]>(() => {
    if (!series || series.length < 2) return [];
    const sum = values.reduce((s, v) => s + v, 0);
    let maxI = 0;
    let minI = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[maxI]) maxI = i;
      if (values[i] < values[minI]) minI = i;
    }
    const first = series[0].label;
    const last = series[series.length - 1].label;
    return [
      {
        label: "合計",
        value: formatValue(sum),
        sub: chartType === "area" ? `${first}〜${last}` : unit,
      },
      {
        label: "平均",
        value: formatValue(Math.round((sum / values.length) * 10) / 10),
        sub: unit,
      },
      { label: "最大", value: formatValue(values[maxI]), sub: series[maxI].label },
      { label: "最少", value: formatValue(values[minI]), sub: series[minI].label },
      ...(chartType === "area"
        ? [
            {
              label: "直近",
              value: formatValue(values[values.length - 1]),
              sub: last,
            },
          ]
        : []),
    ];
  }, [series, values, chartType, unit, formatValue]);

  return (
    <div
      className="app-card-padded app-tile flex h-full flex-col gap-3 focus-visible:border-muted-foreground/60 focus-visible:outline-none"
      role="button"
      tabIndex={0}
      aria-label={`${title}の詳細を開く`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        setExpanded(true);
        onDialogOpen?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded(true);
          onDialogOpen?.();
        }
      }}
    >
      <p className="text-sm font-black text-foreground">{title}</p>
      {/* 前期間比は値の横に添える (Cloudflareダッシュボード風) */}
      <div>
        {loading ? (
          <div className="skeleton h-9 w-32 rounded-lg" />
        ) : (
          <div className="data-in flex flex-wrap items-baseline gap-2">
            <p className="text-3xl font-black tracking-tight text-foreground">
              {valueText}
              {unit && (
                <span className="ml-1.5 text-sm font-bold text-muted-foreground">{unit}</span>
              )}
            </p>
            {delta !== undefined && <DeltaBadge delta={delta ?? null} variant="text" />}
          </div>
        )}
      </div>
      {/* ミニグラフは easyui の InteractiveAreaChart (ホバーでcrosshair+ツールチップ) */}
      {showMiniChart &&
        (loading ? (
          <div className="mt-auto">
            <div className="skeleton h-[110px] rounded-xl" />
          </div>
        ) : (
          values.length > 1 && (
            <div className="data-in mt-auto">
              <InteractiveAreaChart
                data={{ 値: points }}
                showHeader={false}
                height={110}
                color={ACCENT}
                locale="ja-JP"
                formatValue={formatValue}
                ariaLabel={`${title}のミニグラフ`}
              />
            </div>
          )
        ))}
      {footer}
      <TileDialog open={expanded} onClose={() => setExpanded(false)} label={title}>
        <div className="pr-7">
          <p className="text-sm font-black text-foreground">{title}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <p className="text-3xl font-black tracking-tight text-foreground">
              {valueText}
              {unit && (
                <span className="ml-1.5 text-sm font-bold text-muted-foreground">{unit}</span>
              )}
            </p>
            {delta !== undefined && <DeltaBadge delta={delta ?? null} variant="text" />}
          </div>
          {(dialogStats ?? statItems).length > 0 && (
            <DialogStats className="mt-4" items={dialogStats ?? statItems} />
          )}
          {points.length > 0 ? (
            <div className="mt-4">
              {chartType === "bar" ? (
                <BarChart
                  data={(series ?? []).map((p) => ({ label: p.label, value: p.value }))}
                  series={[{ key: "value", label: title, color: ACCENT }]}
                  height={280}
                  formatValue={(n) => `${formatValue(n)}${unit ?? ""}`}
                  formatTick={(n) => n.toLocaleString("ja-JP")}
                  showLegend={false}
                  ariaLabel={`${title}の拡大グラフ`}
                />
              ) : (
                <InteractiveAreaChart
                  data={{ 値: points }}
                  showHeader={false}
                  height={280}
                  color={ACCENT}
                  locale="ja-JP"
                  formatValue={formatValue}
                  ariaLabel={`${title}の拡大グラフ`}
                />
              )}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              このカードにはグラフデータがありません
            </p>
          )}
          {dialogExtra && <div className="mt-5">{dialogExtra}</div>}
          {footer && <div className="mt-3">{footer}</div>}
        </div>
      </TileDialog>
    </div>
  );
}
