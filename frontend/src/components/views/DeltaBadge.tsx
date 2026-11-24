import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";

/**
 * 前期間比。null (前期間データなし・全期間など) は何も表示しない。
 * deltaは小数 (0.042 = +4.2%)。
 * variant:
 * - badge: 背景付きバッジ (テーブル等)
 * - text:  Cloudflareタイル風のプレーンテキスト (値の横に添える)
 */
export default function DeltaBadge({
  delta,
  className = "",
  variant = "badge",
}: {
  delta: number | null;
  className?: string;
  variant?: "badge" | "text";
}) {
  if (delta === null || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta * 1000) / 10;
  const up = rounded > 0;
  const flat = rounded === 0;
  const Icon = up ? ArrowUpRight : flat ? ArrowRight : ArrowDownRight;
  if (variant === "text") {
    const colorClass = flat ? "text-muted-foreground" : up ? "text-delta-up" : "text-delta-down";
    return (
      <span
        className={`inline-flex items-center gap-0.5 text-sm font-semibold ${colorClass} ${className}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {Math.abs(rounded)}%
      </span>
    );
  }
  const colorClass = flat
    ? "text-muted-foreground bg-muted"
    : up
      ? "text-delta-up bg-delta-up/10"
      : "text-delta-down bg-delta-down/10";
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-black ${colorClass} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {Math.abs(rounded)}%
    </span>
  );
}

export function deltaRate(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined)
    return null;
  if (previous === 0) return current > 0 ? null : 0;
  return (current - previous) / previous;
}
