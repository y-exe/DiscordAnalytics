"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import PageToolbar from "@/components/shell/PageToolbar";
import PeriodPicker from "@/components/shell/PeriodPicker";
import { Button } from "@/components/ui/button";
import StatCard from "./StatCard";
import RankTopCard from "./RankTopCard";
import Reorderable from "./Reorderable";
import { ActivityHeatChart, CategoryBarChart, ChannelShareDonut, DailyTrendChart } from "./charts";
import { DOW_LABELS, DialogStats, categoryStats, jaNum } from "./dialog-parts";
import {
  activeDaysDialog,
  avgCharsDialog,
  avgPerDayDialog,
  channelShareDialog,
  charsDialog,
  heatmapDialog as heatDialogContent,
  hourDialog as hourDialogContent,
  dowDialog as dowDialogContent,
  membersDialog,
  peakHourDialog,
  topDaysDialog,
  topMembersDialog,
  totalMessagesDialog,
  trendDialog,
  type DialogData,
} from "./dialog-contents";
import { deltaRate } from "./DeltaBadge";
import { fetchAPI, prefetchAPI } from "@/lib/api";
import { savedCardOrder, useSequentialReveal } from "@/lib/card-reveal";
import { useFooterAction, useGuildName, usePendingBar } from "@/components/shell/AppShell";
import { periodLabel, previousMonthOf, latestPublishedMonth, type Period } from "@/lib/period";

interface RankingUser {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  avatar_decoration: string | null;
  nameplate: { asset: string; palette: string } | null;
  primary_guild_tag: string | null;
  primary_guild_badge: string | null;
  count: number;
  char_count: number;
}

interface ChartPoint {
  date: string;
  total: number;
  /** 1日のユニーク発言者数 (/stats/history の新フィールド。旧キャッシュでは欠落) */
  users?: number;
  /** 1日の合計文字数 (同上) */
  chars?: number;
}

interface Analysis {
  total: number;
  unique_users: number;
  char_count?: number;
  max_date: { date: string; count: number } | null;
  /** 発言数が多い日の上位5位 (旧キャッシュでは欠落) */
  top_dates?: { date: string; count: number }[];
  max_dow: { dow: number; count: number } | null;
  max_hour: { hour: number; count: number } | null;
  /** ポップアップ用の派生集計 (新API以降で返る) */
  new_members: number | null;
  repeat: { one: number; two_three: number; four_seven: number; eight_plus: number } | null;
  longest_message: {
    chars: number;
    display_name: string;
    date: string;
    channel_name?: string;
  } | null;
  leaders: { date: string; display_name: string; count: number }[] | null;
}

interface HeatPoint {
  dow: number;
  hour: number;
  count: number;
}

interface PieItem {
  name: string;
  value: number;
}

/** サマリーページを構成するデータ区分 (カード群ごとに個別リクエストする)。
 *  extras (ポップアップ用の派生集計) はカード表示に不要なため最後尾で取得する */
type PartKey = "ranking" | "history" | "analysis" | "prev" | "heatmap" | "channels" | "extras";

/** カードid → 表示に必要なデータ区分。優先順リクエストとカード単位の段階表示に使う */
const CARD_PARTS: Record<string, PartKey[]> = {
  "kpi-total": ["history", "analysis"],
  "kpi-users": ["history", "analysis"],
  "kpi-chars": ["history", "analysis"],
  "kpi-avg-day": ["history", "analysis"],
  "kpi-avg-chars": ["history", "analysis"],
  "kpi-peak": ["heatmap"],
  "kpi-channel": ["channels"],
  "kpi-active-days": ["history"],
  heatmap: ["heatmap"],
  trend: ["history"],
  "rank-messages": ["ranking"],
  "rank-dates": ["analysis"],
  "channel-share": ["channels"],
  dow: ["heatmap"],
  hour: ["heatmap"],
};

/** ポップアップ用の派生集計 (/stats/analysis_extras)。カードには使わない */
interface ExtrasShape {
  new_members: number | null;
  repeat: { one: number; two_three: number; four_seven: number; eight_plus: number } | null;
  longest_message: {
    chars: number;
    display_name: string;
    date: string;
    channel_name?: string;
  } | null;
  leaders: { date: string; display_name: string; count: number }[] | null;
}

/** 既定のカード順 (保存順がない場合・新規カードのフォールバック) */
const DEFAULT_CARD_ORDER = Object.keys(CARD_PARTS);

function shortDate(date: string): string {
  const parts = date.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export default function SummaryView({
  year,
  month,
  isAll,
}: {
  year: number | null;
  month: number | null;
  isAll: boolean;
}) {
  /** データ区分ごとに到着したレスポンス (カード単位の段階表示用) */
  const [parts, setParts] = useState<Partial<Record<PartKey, unknown>>>({});
  const [failedParts, setFailedParts] = useState<Partial<Record<PartKey, boolean>>>({});
  /** 期間切替中 (既存データを薄めて表示し、取得できたら差し替える) */
  const [pending, setPending] = useState(false);
  // 変えるとカードの並び順をデフォルトに戻す (ReorderableのresetToken)
  const [orderResetToken, setOrderResetToken] = useState(0);

  // フッターにカード順列リセットを登録 (早期リターンより前に呼ぶ。setOrderResetTokenは安定)
  const resetButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground"
        onClick={() => setOrderResetToken((t) => t + 1)}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        カードの順列をリセット
      </Button>
    ),
    [],
  );
  useFooterAction(resetButton);

  // 読み込み中はシェル最上部の共通バーを出す
  usePendingBar(pending);

  // データが揃ったカードを到着順 (同着なら上から順) に1枚ずつめくる
  const { ready, reset: resetReveal } = useSequentialReveal(
    useMemo(
      () =>
        savedCardOrder(isAll ? "layout.summary.all" : "layout.summary.month", DEFAULT_CARD_ORDER),
      [isAll],
    ),
    useCallback(
      (id: string) =>
        (CARD_PARTS[id] ?? []).every(
          (key) => parts[key] !== undefined || failedParts[key] === true,
        ),
      [parts, failedParts],
    ),
  );

  // 到着したデータ区分を従来と同じ data 形にまとめる (既存の導出処理はそのまま動く)。
  // extras は新backendでは別レスポンス、旧backendでは analysis に同梱されているのでフォールバックする
  const analysisBody = parts.analysis as Analysis | null | undefined;
  const data = useMemo(
    () => ({
      ranking: (parts.ranking as RankingUser[] | undefined) ?? [],
      chart: (parts.history as { chart_data?: ChartPoint[] } | undefined)?.chart_data ?? [],
      analysis: analysisBody ?? null,
      prevAnalysis: (parts.prev as Analysis | null | undefined) ?? null,
      heatmap: (parts.heatmap as HeatPoint[] | undefined) ?? [],
      channels: (parts.channels as PieItem[] | undefined) ?? [],
      extras:
        (parts.extras as ExtrasShape | undefined) ??
        (analysisBody
          ? {
              new_members: analysisBody.new_members,
              repeat: analysisBody.repeat,
              longest_message: analysisBody.longest_message,
              leaders: analysisBody.leaders,
            }
          : null),
    }),
    [parts],
  );
  /** 全データ区分が失敗したときだけ全体のエラーバナーを出す */
  const failedEverything = (
    ["ranking", "history", "analysis", "heatmap", "channels"] as PartKey[]
  ).every((key) => failedParts[key] === true);

  useEffect(() => {
    let cancelled = false;
    const base = isAll ? "/total" : `/${year}/${month}`;
    const prev = previousMonthOf({ key: "", year, month, isAll });
    const paths: Partial<Record<PartKey, string>> = {
      ranking: isAll ? "/ranking/total" : `/ranking/monthly/${year}/${month}`,
      history: `/stats/history${base}`,
      analysis: `/stats/analysis${base}?extras=0`,
      heatmap: `/stats/heatmap${base}`,
      channels: `/stats/channels_distribution${base}`,
      extras: `/stats/analysis_extras${base}`,
    };
    if (prev) paths.prev = `/stats/analysis/${prev.year}/${prev.month}?extras=0`;

    // 保存したカード順に沿って、表示に必要なデータから優先的にリクエストする
    // (上にあるカードほど早くデータを受け取り、早く表示される)
    const cardOrder = savedCardOrder(
      isAll ? "layout.summary.all" : "layout.summary.month",
      DEFAULT_CARD_ORDER,
    );
    const order: PartKey[] = [];
    for (const id of cardOrder) {
      for (const key of CARD_PARTS[id] ?? []) {
        if (!order.includes(key)) order.push(key);
      }
    }
    // 前期間比 (deltaバッジ) とポップアップ用おまけは装飾的なので最後に回す
    if (paths.prev) order.push("prev");
    order.push("extras");

    // 期間が変わったらめくり状態をリセットする
    resetReveal();

    setPending(true);
    let remaining = order.length;
    const settle = () => {
      remaining -= 1;
      if (remaining <= 0 && !cancelled) setPending(false);
    };
    const load = async (key: PartKey) => {
      const path = paths[key];
      if (!path) {
        settle();
        return;
      }
      try {
        const res = await fetchAPI(path);
        if (cancelled) return;
        if (res.ok) {
          const body = await res.json();
          if (cancelled) return;
          setParts((p) => ({ ...p, [key]: body }));
        } else {
          // analysis は 404 (データなし月) を「空」として扱う (従来同等)
          if (key === "analysis") setParts((p) => ({ ...p, [key]: null }));
          if (key !== "analysis" || res.status !== 404) {
            setFailedParts((f) => ({ ...f, [key]: true }));
          }
        }
      } catch {
        if (!cancelled) {
          if (key === "analysis") setParts((p) => ({ ...p, [key]: null }));
          setFailedParts((f) => ({ ...f, [key]: true }));
        }
      } finally {
        settle();
      }
    };
    // 先頭のリクエストから順に送信する (少し間隔を空けて先頭ほど早く着信するように)
    const timers = order.map((key, index) => setTimeout(() => void load(key), index * 60));
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [year, month, isAll]);

  // データ取得後、前後の月のデータを事前取得しておく (期間切替を高速化)
  useEffect(() => {
    const bases: string[] = [];
    if (isAll) {
      const latest = latestPublishedMonth();
      bases.push(`/${latest.year}/${latest.month}`);
    } else if (year && month) {
      const prev = previousMonthOf({ key: "", year, month, isAll: false });
      if (prev) bases.push(`/${prev.year}/${prev.month}`);
      // 翌月 (未公開月を除く)
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const latest = latestPublishedMonth();
      const published =
        nextYear < latest.year || (nextYear === latest.year && nextMonth <= latest.month);
      if (published) bases.push(`/${nextYear}/${nextMonth}`);
    }
    if (bases.length === 0) return;
    // 初期描画を優先させた後に取得
    const timer = setTimeout(() => {
      for (const base of bases) {
        prefetchAPI(`/stats/history${base}`);
        prefetchAPI(`/stats/analysis${base}?extras=0`);
        prefetchAPI(`/stats/analysis_extras${base}`);
        prefetchAPI(`/stats/heatmap${base}`);
        prefetchAPI(`/stats/channels_distribution${base}`);
        prefetchAPI(`/ranking/monthly${base}`);
      }
    }, 1200);
    return () => clearTimeout(timer);
    // 主要データが揃うのを待たず、期間が決まった時点で prefetch を開始する
  }, [year, month, isAll]);

  const guildName = useGuildName();
  const title = isAll
    ? "全期間"
    : periodLabel({ key: `${year}-${month}`, year, month, isAll: false });

  const trendPoints = useMemo(
    () => (data?.chart ?? []).map((p) => ({ date: Date.parse(p.date), value: p.total })),
    [data],
  );

  // 日別推移ダイアログの補助チャート (旧キャッシュではusers/charsが欠落するので任意)
  const userTrendPoints = useMemo(() => {
    const chart = data?.chart ?? [];
    return chart.some((p) => p.users !== undefined)
      ? chart.map((p) => ({ date: Date.parse(p.date), value: p.users ?? 0 }))
      : null;
  }, [data]);

  const charsTrendPoints = useMemo(() => {
    const chart = data?.chart ?? [];
    return chart.some((p) => p.chars !== undefined)
      ? chart.map((p) => ({ date: Date.parse(p.date), value: p.chars ?? 0 }))
      : null;
  }, [data]);

  const heatMatrix = useMemo(() => {
    const m: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const p of data?.heatmap ?? []) {
      if (p.dow >= 0 && p.dow < 7 && p.hour >= 0 && p.hour < 24) m[p.dow][p.hour] = p.count;
    }
    return m;
  }, [data]);

  const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  const dowData = useMemo(() => {
    const map = new Map((data?.heatmap ?? []).map((point) => [point.dow, point.count]));
    return DOW_LABELS.map((label, dow) => ({ label, value: map.get(dow) ?? 0 }));
  }, [data]);

  const hourData = useMemo(() => {
    const map = new Map((data?.heatmap ?? []).map((point) => [point.hour, point.count]));
    return Array.from({ length: 24 }, (_, hour) => ({
      label: String(hour),
      value: map.get(hour) ?? 0,
    }));
  }, [data]);

  const daysInPeriod = useMemo(() => {
    if (isAll) {
      // 全期間: 実データが存在する最初〜最終日の日数で平均を取る
      const chart = data?.chart ?? [];
      if (chart.length === 0) return null;
      const dates = chart.map((point) => new Date(point.date).getTime());
      const days = Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000) + 1;
      return days > 0 ? days : null;
    }
    if (year === null || month === null) return null;
    return new Date(year, month, 0).getDate();
  }, [year, month, isAll, data]);

  // 各カードの拡大ポップアップの中身 (データ到達時に一度だけ構築)
  const chart = data.chart;
  const ranking = data.ranking;
  const channels = data.channels;
  const dialogs = useMemo(() => {
    const ctx: DialogData = {
      daily: chart.map((p) => ({ date: Date.parse(p.date), value: p.total })),
      dailyUsers: chart.some((p) => p.users !== undefined)
        ? chart.map((p) => ({ date: Date.parse(p.date), value: p.users ?? 0 }))
        : undefined,
      dailyChars: chart.some((p) => p.chars !== undefined)
        ? chart.map((p) => ({ date: Date.parse(p.date), value: p.chars ?? 0 }))
        : undefined,
      matrix: heatMatrix,
      dowData,
      hourData,
      channels: channels.map((c) => ({ name: c.name, value: c.value })),
      topMembers: ranking.slice(0, 10).map((u) => ({ name: u.display_name, value: u.count })),
      analysis: data.extras
        ? {
            new_members: data.extras.new_members,
            repeat: data.extras.repeat,
            longest_message: data.extras.longest_message,
            leaders: data.extras.leaders,
          }
        : undefined,
      daysInPeriod,
      isAll,
    };
    const topDatesLocal =
      data.analysis?.top_dates ?? (data.analysis?.max_date ? [data.analysis.max_date] : []);
    return {
      total: totalMessagesDialog(ctx),
      users: membersDialog(ctx),
      chars: charsDialog(ctx),
      avgDay: avgPerDayDialog(ctx),
      avgChars: avgCharsDialog(ctx),
      peak: peakHourDialog(ctx),
      channel: channelShareDialog(ctx),
      activeDays: activeDaysDialog(ctx),
      heatmap: heatDialogContent(ctx),
      trend: trendDialog(ctx),
      topMembers: topMembersDialog(ctx, {
        items: ranking.slice(0, 10).map((u) => ({ name: u.display_name, count: u.count })),
        total: data.analysis?.total ?? 0,
      }),
      topDays: topDaysDialog(ctx, { topDates: topDatesLocal, total: data.analysis?.total ?? 0 }),
      dow: dowDialogContent(ctx),
      hour: hourDialogContent(ctx),
      share: channelShareDialog(ctx),
    };
    // 依存はデータ導出元に追従
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, chart, ranking, channels, heatMatrix, dowData, hourData, daysInPeriod, isAll]);

  const total = data?.analysis?.total ?? 0;
  const uniqueUsers = data?.analysis?.unique_users ?? 0;
  const chars = data?.analysis?.char_count ?? null;
  const prevTotal = data?.prevAnalysis?.total ?? null;
  const prevUsers = data?.prevAnalysis?.unique_users ?? null;
  const prevChars = data?.prevAnalysis?.char_count ?? null;
  const avgPerDay = daysInPeriod && total > 0 ? total / daysInPeriod : null;
  const avgDelta =
    avgPerDay !== null && prevTotal !== null && daysInPeriod
      ? deltaRate(avgPerDay, prevTotal / daysInPeriod)
      : null;

  const avgChars = chars !== null && total > 0 ? Math.round(chars / total) : null;
  const activeDays = data?.chart.length ?? 0;
  const peakHour = data?.analysis?.max_hour ?? null;
  const busiestChannel = data?.channels[0] ?? null;
  const topDates =
    data?.analysis?.top_dates ?? (data?.analysis?.max_date ? [data.analysis.max_date] : []);

  const period: Period = { key: isAll ? "all" : `${year}-${month}`, year, month, isAll };

  /** 発言率 (0〜1) を % 表記に。対象が0なら null */
  const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);

  return (
    <div className="space-y-5">
      <PageToolbar
        title={`${title}の統計`}
        subtitle={`${guildName || "このサーバー"}の統計です！分析/調査/把握にお役立てください！`}
        right={<PeriodPicker period={period} />}
      />

      {/* 読み込み中はシェル最上部の共通バーを出す (usePendingBarで登録済み) */}
      {/* 主要データが全て失敗したときだけ全体のエラーバナーを出す (カードはスケルトン構成のまま維持) */}
      {failedEverything && (
        <div className="app-card-padded text-sm text-muted-foreground">
          データの読み込みに失敗しました。時間をおいて再読み込みしてください。
        </div>
      )}

      <div
        className={`transition-opacity duration-200 ${
          pending ? "pointer-events-none opacity-40" : "opacity-100"
        }`}
      >
        <Reorderable
          replayKey={period.key}
          resetToken={orderResetToken}
          storageKey={isAll ? "layout.summary.all" : "layout.summary.month"}
          items={[
            {
              id: "kpi-total",
              node: (
                <StatCard
                  title="総発言数"
                  value={total}
                  unit="件"
                  delta={deltaRate(total, prevTotal)}
                  series={chart.map((p) => ({
                    label: shortDate(p.date),
                    date: Date.parse(p.date),
                    value: p.total,
                  }))}
                  loading={!ready("kpi-total")}
                  dialogStats={dialogs?.total.stats}
                  dialogExtra={dialogs?.total.extra}
                />
              ),
            },
            {
              id: "kpi-users",
              node: (
                <StatCard
                  title="アクティブメンバー"
                  value={uniqueUsers}
                  unit="人"
                  delta={deltaRate(uniqueUsers, prevUsers)}
                  series={
                    chart.some((p) => p.users !== undefined)
                      ? chart.map((p) => ({
                          label: shortDate(p.date),
                          date: Date.parse(p.date),
                          value: p.users ?? 0,
                        }))
                      : undefined
                  }
                  loading={!ready("kpi-users")}
                  dialogStats={dialogs?.users.stats}
                  dialogExtra={dialogs?.users.extra}
                />
              ),
            },
            {
              id: "kpi-chars",
              node: (
                <StatCard
                  title="総文字数"
                  value={chars ?? "—"}
                  unit={chars === null ? undefined : "字"}
                  delta={deltaRate(chars, prevChars)}
                  series={
                    chart.some((p) => p.chars !== undefined)
                      ? chart.map((p) => ({
                          label: shortDate(p.date),
                          date: Date.parse(p.date),
                          value: p.chars ?? 0,
                        }))
                      : undefined
                  }
                  loading={!ready("kpi-chars")}
                  dialogStats={dialogs?.chars.stats}
                  dialogExtra={dialogs?.chars.extra}
                />
              ),
            },
            {
              id: "kpi-avg-day",
              node: (
                <StatCard
                  title="1日平均発言数"
                  value={avgPerDay === null ? "—" : Math.round(avgPerDay * 10) / 10}
                  unit="件"
                  delta={avgDelta}
                  chartType="bar"
                  series={chart
                    .slice(-14)
                    .map((p) => ({ label: shortDate(p.date), value: p.total }))}
                  loading={!ready("kpi-avg-day")}
                  dialogStats={dialogs?.avgDay.stats}
                  dialogExtra={dialogs?.avgDay.extra}
                />
              ),
            },
            {
              id: "kpi-avg-chars",
              node: (
                <StatCard
                  title="平均文字数/発言"
                  value={avgChars ?? "—"}
                  unit={avgChars === null ? undefined : "字"}
                  showMiniChart={false}
                  series={
                    chart.some((p) => p.chars !== undefined)
                      ? chart.map((p) => ({
                          label: shortDate(p.date),
                          date: Date.parse(p.date),
                          value: p.total > 0 ? Math.round((p.chars ?? 0) / p.total) : 0,
                        }))
                      : undefined
                  }
                  loading={!ready("kpi-avg-chars")}
                  dialogStats={dialogs?.avgChars.stats}
                  dialogExtra={dialogs?.avgChars.extra}
                />
              ),
            },
            {
              id: "kpi-peak",
              node: (
                <StatCard
                  title="ピーク時間帯"
                  value={peakHour ? `${peakHour.hour}:00台` : "—"}
                  unit={peakHour ? `${peakHour.count.toLocaleString("ja-JP")}件` : undefined}
                  showMiniChart={false}
                  series={hourData}
                  chartType="bar"
                  formatValue={(v) => v.toLocaleString("ja-JP")}
                  loading={!ready("kpi-peak")}
                  dialogStats={dialogs?.peak.stats}
                  dialogExtra={dialogs?.peak.extra}
                />
              ),
            },
            {
              id: "kpi-channel",
              node: (
                <StatCard
                  title="最も活発なチャンネル"
                  value={busiestChannel ? `#${busiestChannel.name}` : "—"}
                  unit={
                    busiestChannel ? `${busiestChannel.value.toLocaleString("ja-JP")}件` : undefined
                  }
                  loading={!ready("kpi-channel")}
                  dialogStats={dialogs?.channel.stats}
                />
              ),
            },
            {
              id: "kpi-active-days",
              node: (
                <StatCard
                  title="発言のあった日数"
                  value={activeDays > 0 ? activeDays : "—"}
                  unit={activeDays > 0 ? "日" : undefined}
                  loading={!ready("kpi-active-days")}
                  dialogStats={dialogs?.activeDays.stats}
                  dialogExtra={dialogs?.activeDays.extra}
                />
              ),
            },
            {
              id: "heatmap",
              className: "xl:col-span-2",
              node: (
                <div className="app-card-padded app-tile h-full min-w-0">
                  {!ready("heatmap") ? (
                    <>
                      <p className="text-sm font-black text-foreground">時間帯別アクティビティ</p>
                      <p className="mt-0.5 text-xs font-bold text-muted-foreground">
                        曜日 × 時間帯の発言集中度
                      </p>
                      <div className="mt-3 skeleton h-[220px] rounded-xl" />
                    </>
                  ) : (
                    <div className="data-in">
                      <ActivityHeatChart matrix={heatMatrix} />
                    </div>
                  )}
                </div>
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats items={dialogs?.heatmap.stats ?? []} />
                  <div className="mt-4">
                    <ActivityHeatChart matrix={heatMatrix} />
                  </div>
                  {dialogs?.heatmap.extra}
                </div>
              ),
            },
            {
              id: "trend",
              className: "xl:col-span-2",
              node: (
                <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
                  <p className="text-sm font-black text-foreground">日別の発言数推移</p>
                  <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                    期間内の每日の発言数
                  </p>
                  {!ready("trend") ? (
                    <div className="min-h-0 flex-1 skeleton rounded-xl" />
                  ) : (
                    <div className="data-in min-h-0 flex-1">
                      <DailyTrendChart points={trendPoints} fill className="h-full" />
                    </div>
                  )}
                </div>
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats items={dialogs?.trend.stats ?? []} />
                  <div className="mt-4">
                    <DailyTrendChart points={trendPoints} height={300} />
                  </div>
                  {dialogs?.trend.extra}
                  {(userTrendPoints || charsTrendPoints) && (
                    <div className="mt-5 grid gap-4 lg:grid-cols-2">
                      {userTrendPoints && (
                        <div>
                          <p className="mb-2 text-sm font-black text-foreground">
                            アクティブメンバー数の推移
                          </p>
                          <DailyTrendChart points={userTrendPoints} height={180} />
                        </div>
                      )}
                      {charsTrendPoints && (
                        <div>
                          <p className="mb-2 text-sm font-black text-foreground">文字数の推移</p>
                          <DailyTrendChart points={charsTrendPoints} height={180} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ),
            },
            {
              id: "rank-messages",
              className: "xl:col-span-2",
              node: (
                <RankTopCard
                  title="発言王"
                  note="この期間に最も発言したメンバー"
                  unit="件"
                  loading={!ready("rank-messages")}
                  items={ranking.map((u) => ({
                    user_id: u.user_id,
                    display_name: u.display_name,
                    avatar: u.avatar,
                    avatar_decoration: u.avatar_decoration,
                    nameplate: u.nameplate,
                    primary_guild_tag: u.primary_guild_tag,
                    primary_guild_badge: u.primary_guild_badge,
                    count: u.count,
                  }))}
                  hrefBase="/members/"
                  hrefQuery={`m=${period.key}`}
                />
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats className="mb-4" items={dialogs?.topMembers.stats ?? []} />
                  <RankTopCard
                    bare
                    title="発言王"
                    note="この期間に最も発言したメンバー トップ10"
                    unit="件"
                    max={10}
                    items={ranking.map((u) => ({
                      user_id: u.user_id,
                      display_name: u.display_name,
                      avatar: u.avatar,
                      avatar_decoration: u.avatar_decoration,
                      nameplate: u.nameplate,
                      primary_guild_tag: u.primary_guild_tag,
                      primary_guild_badge: u.primary_guild_badge,
                      count: u.count,
                    }))}
                    hrefBase="/members/"
                    hrefQuery={`m=${period.key}`}
                  />
                  <div className="mt-5">{dialogs?.topMembers.extra}</div>
                </div>
              ),
            },
            {
              id: "rank-dates",
              node: (
                <RankTopCard
                  title="最多発言日"
                  note="期間内で最も盛り上がった日 トップ5"
                  unit="件"
                  emptyText="データがありません"
                  loading={!ready("rank-dates")}
                  items={topDates.map((entry) => ({
                    user_id: `date-${entry.date}`,
                    display_name: entry.date.replaceAll("-", "/"),
                    count: entry.count,
                  }))}
                />
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats className="mb-4" items={dialogs?.topDays.stats ?? []} />
                  <RankTopCard
                    bare
                    title="最多発言日"
                    note="期間内で最も盛り上がった日 トップ5"
                    unit="件"
                    emptyText="データがありません"
                    items={topDates.map((entry) => ({
                      user_id: `date-${entry.date}`,
                      display_name: entry.date.replaceAll("-", "/"),
                      count: entry.count,
                    }))}
                  />
                  <div className="mt-5">{dialogs?.topDays.extra}</div>
                </div>
              ),
            },
            {
              id: "channel-share",
              node: (
                <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
                  <p className="text-sm font-black text-foreground">チャンネル別発言シェア</p>
                  <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                    発言数の多いチャンネル トップ6
                  </p>
                  <div className="flex min-h-0 flex-1 flex-col justify-center">
                    {!ready("channel-share") ? (
                      <div className="skeleton mx-auto h-[220px] w-[220px] rounded-full" />
                    ) : (
                      <div className="data-in">
                        <ChannelShareDonut channels={channels} showLegend={false} />
                      </div>
                    )}
                  </div>
                </div>
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats className="mb-4" items={dialogs?.share.stats ?? []} />
                  <p className="mb-3 text-sm font-black text-foreground">チャンネル別発言シェア</p>
                  <ChannelShareDonut channels={channels} max={12} />
                </div>
              ),
            },
            {
              id: "dow",
              className: "xl:col-span-2",
              node: (
                <div className="app-card-padded app-tile h-full min-w-0">
                  <p className="text-sm font-black text-foreground">曜日別の発言数</p>
                  <div className="mt-2">
                    {!ready("dow") ? (
                      <div className="skeleton h-[230px] rounded-xl" />
                    ) : (
                      <div className="data-in">
                        <CategoryBarChart data={dowData} height={230} />
                      </div>
                    )}
                  </div>
                </div>
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats className="mb-4" items={dialogs?.dow.stats ?? []} />
                  <p className="mb-3 text-sm font-black text-foreground">曜日別の発言数</p>
                  <CategoryBarChart data={dowData} height={300} />
                  <div className="mt-5">{dialogs?.dow.extra}</div>
                </div>
              ),
            },
            {
              id: "hour",
              className: "xl:col-span-2",
              node: (
                <div className="app-card-padded app-tile h-full min-w-0">
                  <p className="text-sm font-black text-foreground">時間帯別の発言数</p>
                  <div className="mt-2">
                    {!ready("hour") ? (
                      <div className="skeleton h-[230px] rounded-xl" />
                    ) : (
                      <div className="data-in">
                        <CategoryBarChart data={hourData} height={230} />
                      </div>
                    )}
                  </div>
                </div>
              ),
              dialog: (
                <div className="pr-7">
                  <DialogStats className="mb-4" items={dialogs?.hour.stats ?? []} />
                  <p className="mb-3 text-sm font-black text-foreground">時間帯別の発言数</p>
                  <CategoryBarChart data={hourData} height={300} />
                  <div className="mt-5">{dialogs?.hour.extra}</div>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
