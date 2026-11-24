"use client";

/*
 * Interactive Area Chart — EasyUI (https://easyui.site/components/interactive-area-chart)
 * MIT © Suraj — 手書きSVG・チャートライブラリ不要。
 * 日本語プロジェクト向けに改変: 書式/日付のローカライズ、ヘッダー非表示、
 * コンテナ高さ追従(fill)、線色の指定を追加。デモデータは削除。
 * さらに data 変更時に render 中へ同期し、期間切替直後も即座に再描画されるよう修正。
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";

/* -------------------------------------------------------------------------- */
/*  Interactive Area Chart — hand-written SVG, no chart library                */
/*  Deps: react 19, framer-motion, tailwindcss.                                */
/* -------------------------------------------------------------------------- */

export type ChartPoint = { date: number; value: number }; // date = UTC ms
export type AreaChartData = Record<string, ChartPoint[]>;

export interface InteractiveAreaChartProps {
  data: AreaChartData;
  defaultRange?: string;
  title?: string;
  /** 固定高さ (px)。fill=true のときは無視される */
  height?: number;
  /** trueでコンテナの高さに追従する */
  fill?: boolean;
  /** ヘッダー (タイトル+現在値+変化率+レンジ切替) を表示するか */
  showHeader?: boolean;
  /** 線・エリアの色 (既定はニュートラル) */
  color?: string;
  /** 値の書式 (センター大数値・ツールチップ) */
  formatValue?: (n: number) => string;
  /** Y軸目盛りの書式 */
  formatTick?: (n: number) => string;
  /** 日付のロケール (既定 ja-JP) */
  locale?: string;
  ariaLabel?: string;
  className?: string;
}

const N = 72; // every dataset is resampled to N points so ranges can morph 1:1
const PAD = { t: 48, r: 12, b: 28, l: 48 };
const TIP_W = 124;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const f = (n: number) => Math.round(n * 100) / 100;

/* --------------------------------- Maths ----------------------------------- */

// Catmull-Rom sample so sparse datasets (7 points) resample smoothly
function spline(v: number[], pos: number) {
  const n = v.length;
  if (n === 1) return v[0];
  const i = Math.min(Math.floor(pos), n - 2);
  const t = pos - i;
  const p0 = v[Math.max(i - 1, 0)];
  const p1 = v[i];
  const p2 = v[i + 1];
  const p3 = v[Math.min(i + 2, n - 1)];
  return (
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

function niceScale(min: number, max: number, count = 4) {
  const raw = (max - min || 1) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

function buildModel(data: AreaChartData) {
  const out: Record<
    string,
    { pts: ChartPoint[]; ny: Float64Array; lo: number; hi: number; ticks: number[] }
  > = {};
  for (const [key, pts] of Object.entries(data)) {
    if (!pts.length) continue;
    const vals = pts.map((p) => p.value);
    const { lo, hi, ticks } = niceScale(Math.min(...vals), Math.max(...vals));
    const ny = new Float64Array(N);
    for (let k = 0; k < N; k++)
      ny[k] = (spline(vals, (k / (N - 1)) * (vals.length - 1)) - lo) / (hi - lo);
    out[key] = { pts, ny, lo, hi, ticks };
  }
  return out;
}

function smoothPath(p: [number, number][]) {
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/* -------------------------------- Component -------------------------------- */

export function InteractiveAreaChart({
  data,
  defaultRange = "",
  title = "",
  height = 280,
  fill = false,
  showHeader = true,
  color,
  formatValue,
  formatTick,
  locale = "ja-JP",
  ariaLabel,
  className = "",
}: InteractiveAreaChartProps) {
  const uid = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  const model = useMemo(() => buildModel(data), [data]);
  const keys = useMemo(() => Object.keys(model), [model]);

  const [range, setRange] = useState(() =>
    keys.includes(defaultRange) ? defaultRange : (keys[0] ?? ""),
  );
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [measuredH, setMeasuredH] = useState(0);
  const H = fill ? measuredH || height : height;

  const wrapRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<Float64Array>(model[range]?.ny ?? new Float64Array(N));
  const toRef = useRef<Float64Array>(model[range]?.ny ?? new Float64Array(N));
  const morphCtl = useRef<{ stop: () => void } | null>(null);
  const started = useRef(false);
  const lastHover = useRef(0);

  const fmts = useMemo(() => {
    const value =
      formatValue ??
      ((n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n));
    const tick =
      formatTick ??
      ((n: number) =>
        new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n));
    const tip = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const axis = (len: number, isNarrow = false) =>
      new Intl.DateTimeFormat(
        locale,
        len <= 10
          ? { weekday: "short", timeZone: "UTC" }
          : isNarrow
            ? { month: "numeric", day: "numeric", timeZone: "UTC" }
            : len <= 60
              ? { month: "short", day: "numeric", timeZone: "UTC" }
              : { month: "short", timeZone: "UTC" },
      );
    return { value, tick, tip, axis };
  }, [locale, formatValue, formatTick]);

  const t = useMotionValue(1); // morph progress between datasets
  const ver = useMotionValue(0); // bumps on every range change
  const wMV = useMotionValue(0); // width
  const reveal = useMotionValue(reduce ? 1 : 0); // intro draw progress
  const cx = useMotionValue(0);
  const cxS = useSpring(cx, { stiffness: 520, damping: 42, mass: 0.6 });

  // データ変更を render 中に refs へ同期する。
  // framer-motion の useTransform は render 中に updateValue() を同時実行するため、
  // ここで refs を更新しておけば lineD/areaD が同期的に新データで再計算される。
  // (useEffect で行うと再計算がフレームルームに依託され、期間切替直後に
  //  古いグラフのままになるため)
  const lastSyncedModel = useRef(model);
  if (lastSyncedModel.current !== model) {
    lastSyncedModel.current = model;
    const mm = model[range];
    if (mm) {
      fromRef.current = mm.ny;
      toRef.current = mm.ny;
      t.set(1);
    }
  }

  const pad = showHeader ? PAD : { ...PAD, t: 12 };
  const innerH = Math.max(1, H - pad.t - pad.b);
  const bottom = pad.t + innerH;
  const yPx = (n: number) => pad.t + (1 - n) * innerH;
  const disp = (k: number) => {
    const a = fromRef.current[k];
    return a + (toRef.current[k] - a) * t.get();
  };
  const points = (w: number) => {
    const iw = Math.max(1, w - pad.l - pad.r);
    return Array.from(
      { length: N },
      (_, k) => [pad.l + (k / (N - 1)) * iw, yPx(disp(k))] as [number, number],
    );
  };
  const sampleY = (frac: number) => {
    const k = clamp(frac, 0, 1) * (N - 1);
    const i = Math.min(Math.floor(k), N - 2);
    const a = disp(i);
    return yPx(a + (disp(i + 1) - a) * (k - i));
  };

  const lineD = useTransform([t, wMV, ver], () => {
    const w = wMV.get();
    return w ? smoothPath(points(w)) : "M0 0";
  });
  const areaD = useTransform([t, wMV, ver], () => {
    const w = wMV.get();
    if (!w) return "M0 0";
    const p = points(w);
    return `${smoothPath(p)}L${f(p[N - 1][0])} ${bottom}L${f(p[0][0])} ${bottom}Z`;
  });
  const clipW = useTransform([reveal, wMV], ([r, w]: number[]) =>
    r >= 0.999 ? w : pad.l + Math.max(0, w - pad.l - pad.r) * r,
  );
  const leadX = useTransform(
    [reveal, wMV],
    ([r, w]: number[]) => pad.l + Math.max(0, w - pad.l - pad.r) * r,
  );
  const leadY = useTransform([reveal, t, wMV, ver], ([r]: number[]) => sampleY(r));
  const leadO = useTransform(reveal, [0, 0.02, 0.96, 1], [0, 1, 1, 0]);
  const dotY = useTransform([cxS, t, wMV, ver], ([c]: number[]) =>
    sampleY((c - pad.l) / Math.max(1, wMV.get() - pad.l - pad.r)),
  );
  const tipX = useTransform([cxS, wMV], ([c, w]: number[]) =>
    clamp(c - TIP_W / 2, 0, Math.max(0, w - TIP_W)),
  );

  // Track width (+ height when fill) and start the intro draw once we know it
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width || el.offsetWidth || 500);
      if (w <= 0) return;
      setWidth(w);
      wMV.set(w);
      if (fill) {
        const h = Math.round(el.clientHeight);
        if (h > 0) setMeasuredH(h);
      }
      if (!started.current) {
        started.current = true;
        if (reduce) reveal.set(1);
        else animate(reveal, 1, { duration: 1.1, ease: EASE_IN_OUT });
      }
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // データ変更時にモーフィングを同期し直す
  // データ変更後は旧データの hover インデックスをリセットする
  useEffect(() => {
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, range]);

  const m = model[range];
  if (!m || m.pts.length === 0) {
    return (
      <div className={`w-full ${className}`}>
        <p className="py-10 text-center text-[13px] text-neutral-500">データがありません</p>
      </div>
    );
  }
  const len = m.pts.length;

  // Morph: interruptible — always starts from what's currently on screen
  const changeRange = (next: string) => {
    if (next === range) return;
    const target = model[next];
    if (!target) return;
    morphCtl.current?.stop();
    const e = t.get();
    const cur = new Float64Array(N);
    for (let k = 0; k < N; k++)
      cur[k] = fromRef.current[k] + (toRef.current[k] - fromRef.current[k]) * e;
    fromRef.current = cur;
    toRef.current = target.ny;
    t.set(0);
    ver.set(ver.get() + 1);
    morphCtl.current = animate(t, 1, { duration: reduce ? 0 : 0.55, ease: EASE_IN_OUT });
    setRange(next);
    setHover(null);
  };

  // Scrubbing: snap to the nearest real data point, spring the visuals
  const moveTo = (idx: number) => {
    const iw = Math.max(1, width - pad.l - pad.r);
    const target = pad.l + (len > 1 ? idx / (len - 1) : 0.5) * iw;
    cx.set(target);
    if (hover === null) cxS.jump(target); // don't sweep in from the left on first hover
    lastHover.current = idx;
    setHover(idx);
  };
  const onScrub = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const frac = clamp((e.clientX - box.left - pad.l) / Math.max(1, width - pad.l - pad.r), 0, 1);
    moveTo(Math.round(frac * (len - 1)));
  };

  const shown = m.pts[hover != null ? Math.min(hover, len - 1) : len - 1];
  const tipPt = m.pts[Math.min(lastHover.current, len - 1)];
  const delta = (shown.value - m.pts[0].value) / m.pts[0].value;
  const isNarrow = width > 0 && width < 380;
  const axis = fmts.axis(len, isNarrow);
  const labelCount = isNarrow ? 3 : width < 520 ? 4 : 5;
  const xLabels = [
    ...new Set(
      Array.from({ length: labelCount }, (_, j) => Math.round((j / (labelCount - 1)) * (len - 1))),
    ),
  ];
  const ready = width > 0 && H > pad.t + pad.b + 20;

  return (
    <div className={`w-full ${className}`}>
      {/* Header */}
      {showHeader && (
        <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="text-[13px] text-neutral-500">{title}</p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-neutral-900 sm:text-3xl dark:text-neutral-50">
              {fmts.value(shown.value)}
            </p>
            <p
              className={`mt-1 text-xs tabular-nums sm:text-[13px] ${
                delta >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {delta >= 0 ? "+" : ""}
              {(delta * 100).toFixed(1)}%{" "}
              <span className="text-neutral-500">
                {hover !== null ? fmts.tip.format(shown.date) : range}
              </span>
            </p>
          </div>

          {keys.length > 1 && (
            <div
              role="tablist"
              aria-label="Range"
              className="flex shrink-0 self-start rounded-full bg-neutral-100 p-0.5 sm:self-auto dark:bg-neutral-900"
            >
              {keys.map((k) => (
                <button
                  key={k}
                  role="tab"
                  type="button"
                  aria-selected={k === range}
                  onClick={() => changeRange(k)}
                  className={`relative z-10 rounded-full px-2.5 py-1 text-xs font-medium outline-none transition-[color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-neutral-400 sm:px-3 ${
                    k === range ? "text-neutral-900 dark:text-neutral-50" : "text-neutral-500"
                  }`}
                >
                  {k === range && (
                    <motion.span
                      layoutId={`${uid}-pill`}
                      className="absolute inset-0 -z-10 rounded-full bg-white shadow-sm dark:bg-neutral-800"
                      transition={{ type: "spring", duration: 0.3, bounce: 0.15 }}
                    />
                  )}
                  {k}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chart */}
      <div
        ref={wrapRef}
        className={fill ? "relative h-full min-h-[120px] w-full" : "relative"}
        style={fill ? undefined : { height }}
      >
        {ready && (
          <>
            <svg
              width={width}
              height={H}
              role="img"
              tabIndex={0}
              aria-label={
                ariaLabel ??
                `${title}: ${fmts.value(m.pts[0].value)} → ${fmts.value(m.pts[len - 1].value)}. 左右キーで値を確認できます。`
              }
              className="block select-none text-neutral-900 outline-none dark:text-neutral-100"
              style={color ? { color } : undefined}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  moveTo(clamp((hover ?? len - 1) + (e.key === "ArrowRight" ? 1 : -1), 0, len - 1));
                } else if (e.key === "Escape") setHover(null);
              }}
              onBlur={() => setHover(null)}
            >
              <defs>
                <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
                <clipPath id={`${uid}-clip`}>
                  <motion.rect x={0} y={0} height={H} width={clipW} />
                </clipPath>
              </defs>

              {/* Grid + axes: crossfade per range */}
              <AnimatePresence>
                <motion.g
                  key={range}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE_OUT }}
                >
                  {m.ticks.map((v) => {
                    const y = yPx((v - m.lo) / (m.hi - m.lo));
                    return (
                      <g key={v}>
                        <line
                          x1={pad.l}
                          x2={width - pad.r}
                          y1={y}
                          y2={y}
                          stroke="currentColor"
                          className="text-neutral-200 dark:text-neutral-800"
                        />
                        <text
                          x={pad.l - 10}
                          y={y}
                          textAnchor="end"
                          dominantBaseline="middle"
                          className="fill-neutral-500 text-[11px] tabular-nums"
                        >
                          {fmts.tick(v)}
                        </text>
                      </g>
                    );
                  })}
                  {xLabels.map((idx, j) => (
                    <text
                      key={idx}
                      x={pad.l + (idx / (len - 1)) * (width - pad.l - pad.r)}
                      y={H - 6}
                      textAnchor={j === 0 ? "start" : j === xLabels.length - 1 ? "end" : "middle"}
                      className="fill-neutral-500 text-[11px]"
                    >
                      {axis.format(m.pts[idx].date)}
                    </text>
                  ))}
                </motion.g>
              </AnimatePresence>

              {/* Area + line (revealed left→right on load) */}
              <g clipPath={`url(#${uid}-clip)`}>
                <motion.path d={areaD} fill={`url(#${uid}-fill)`} />
                <motion.path
                  d={lineD}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
              <motion.circle
                cx={leadX}
                cy={leadY}
                r={3.5}
                fill="currentColor"
                style={{ opacity: leadO }}
              />

              {/* Crosshair + dot */}
              <motion.g
                initial={false}
                animate={{ opacity: hover !== null ? 1 : 0 }}
                transition={{ duration: 0.15, ease: EASE_OUT }}
                pointerEvents="none"
              >
                <motion.line
                  x1={cxS}
                  x2={cxS}
                  y1={pad.t - 6}
                  y2={bottom}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                  strokeDasharray="3 3"
                />
                <motion.circle
                  cx={cxS}
                  cy={dotY}
                  r={4.5}
                  stroke="currentColor"
                  strokeWidth={2}
                  className="fill-white dark:fill-neutral-950"
                />
              </motion.g>

              {/* Pointer surface */}
              <rect
                x={0}
                y={0}
                width={width}
                height={H}
                fill="transparent"
                style={{ touchAction: "pan-y", cursor: "crosshair" }}
                onPointerMove={onScrub}
                onPointerDown={onScrub}
                onPointerLeave={() => setHover(null)}
              />
            </svg>

            {/* Tooltip */}
            <motion.div
              className="pointer-events-none absolute top-0 left-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
              style={{ x: tipX, width: TIP_W }}
              initial={false}
              animate={{ opacity: hover !== null ? 1 : 0 }}
              transition={{ duration: 0.15, ease: EASE_OUT }}
            >
              <p className="text-[11px] leading-tight text-neutral-500">
                {fmts.tip.format(tipPt.date)}
              </p>
              <p className="text-sm font-medium tabular-nums text-neutral-900 dark:text-neutral-50">
                {fmts.value(tipPt.value)}
              </p>
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
}

export default InteractiveAreaChart;
