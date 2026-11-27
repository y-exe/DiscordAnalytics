"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import PageToolbar from "@/components/shell/PageToolbar";
import PeriodPicker from "@/components/shell/PeriodPicker";
import { Button } from "@/components/ui/button";
import ChannelNoContent from "@/components/views/ChannelNoContent";
import Reorderable from "./Reorderable";
import StatCard from "./StatCard";
import RankTopCard from "./RankTopCard";
import { ActivityHeatChart, CategoryBarChart, DailyTrendChart } from "./charts";
import { DialogSection, DialogStats, dowLabel, fmtDay, jaNum } from "./dialog-parts";
import {
  LongestMessageSection,
  activeDaysDialog,
  avgCharsDialog,
  avgPerDayDialog,
  charsDialog,
  heatmapDialog as heatDialogContent,
  hourDialog as hourDialogContent,
  dowDialog as dowDialogContent,
  membersDialog,
  peakHourDialog,
  rankDialog,
  topDaysDialog,
  topMembersDialog,
  totalMessagesDialog,
  trendDialog,
  type DialogData,
} from "./dialog-contents";
import { deltaRate } from "./DeltaBadge";
import { fetchAPI, prefetchAPI } from "@/lib/api";
import { savedCardOrder, useSequentialReveal } from "@/lib/card-reveal";
import { useFooterAction, usePendingBar } from "@/components/shell/AppShell";
import { periodLabel, previousMonthOf, latestPublishedMonth } from "@/lib/period";

interface InsightsMember {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  count: number;
  /** 文字数王カード用 (backendの新API以降で返る。旧キャッシュでは欠落) */
  chars?: number;
}

interface Insights {
  channel: { channel_id: string; name: string; category: string; position: number } | null;
  messages: number;
  chars: number;
  users: number;
  rank: number | null;
  daily: Array<{ date: string; count: number; users?: number; chars?: number }>;
  members: InsightsMember[];
  dow: Array<{ dow: number; count: number }>;
  hours: Array<{ hour: number; count: number }>;
  heatmap: Array<{ dow: number; hour: number; count: number }>;
  top_dates: Array<{ date: string; count: number }>;
  first_at: string | null;
  last_at: string | null;
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

function shortDate(date: string): string {
  const parts = date.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

/** 既定のカード順 (チャンネル詳細)。保存順がない場合・新規カードのフォールバック */
const CHANNEL_CARD_ORDER = [
  "kpi-total",
  "kpi-users",
  "kpi-chars",
  "kpi-avg-day",
  "kpi-avg-chars",
  "kpi-peak",
  "kpi-rank",
  "kpi-active-days",
  "heatmap",
  "rank-messages",
  "rank-chars",
  "rank-dates",
  "trend",
  "dow",
  "hour",
];

export default function ChannelDetailView({
  channelId,
  period,
}: {
  channelId: string;
  period: { key: string; year: number | null; month: number | null; isAll: boolean };
}) {
  const [data, setData] = useState<Insights | null>(null);
  const [prevData, setPrevData] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);
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
  usePendingBar(!data && !failed);

  // データが揃ったカードを表示順 (保存順) に1枚ずつめくる
  const { ready, reset: resetReveal } = useSequentialReveal(
    useMemo(
      () =>
        savedCardOrder(
          period.isAll ? "layout.channel.all" : "layout.channel.month",
          CHANNEL_CARD_ORDER,
        ),
      [period.isAll],
    ),
    useCallback((id: string) => data !== null, [data]),
  );

  const base = period.isAll
    ? `/channels/${channelId}/insights/total`
    : `/channels/${channelId}/insights/${period.year}/${period.month}`;

  // 前期間比表示用に前月のinsightsも取得する (全期間は比較対象がないためnull)
  const prevMonth = previousMonthOf(period);
  const prevBase = prevMonth
    ? `/channels/${channelId}/insights/${prevMonth.year}/${prevMonth.month}`
    : null;

  useEffect(() => {
    let cancelled = false;
    resetReveal();
    setData(null);
    setPrevData(null);
    setFailed(false);
    // 本体を先に取得してカードを早く表示し、前期間比 (delta) はその後に取得する
    const loadBase = async () => {
      try {
        const res = await fetchAPI(base, { retries: 1 });
        if (cancelled) return;
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Insights;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    const loadPrev = async () => {
      if (!prevBase) return;
      try {
        const res = await fetchAPI(prevBase, { retries: 1 });
        if (cancelled) return;
        if (res.ok) setPrevData((await res.json()) as Insights);
      } catch {
        // 前期間比は装飾的なので失敗しても画面は崩さない
      }
    };
    void loadBase().then(loadPrev);
    return () => {
      cancelled = true;
    };
  }, [base, prevBase, channelId, resetReveal]);

  // データ取得後、前後の月のinsightsを事前取得しておく (期間切替を高速化)
  useEffect(() => {
    if (!data) return;
    const bases: string[] = [];
    if (period.isAll) {
      const latest = latestPublishedMonth();
      bases.push(`/channels/${channelId}/insights/${latest.year}/${latest.month}`);
    } else if (period.year && period.month) {
      const prev = previousMonthOf({
        key: "",
        year: period.year,
        month: period.month,
        isAll: false,
      });
      if (prev) bases.push(`/channels/${channelId}/insights/${prev.year}/${prev.month}`);
      const nextMonth = period.month === 12 ? 1 : period.month + 1;
      const nextYear = period.month === 12 ? period.year + 1 : period.year;
      const latest = latestPublishedMonth();
      const published =
        nextYear < latest.year || (nextYear === latest.year && nextMonth <= latest.month);
      if (published) bases.push(`/channels/${channelId}/insights/${nextYear}/${nextMonth}`);
    }
    if (bases.length === 0) return;
    const timer = setTimeout(() => {
      for (const base of bases) prefetchAPI(base);
    }, 1000);
    return () => clearTimeout(timer);
  }, [data, channelId, period]);

  const title = period.isAll ? "全期間" : periodLabel(period);

  const trendPoints = useMemo(
    () => (data?.daily ?? []).map((p) => ({ date: Date.parse(p.date), value: p.count })),
    [data],
  );

  const heatMatrix = useMemo(() => {
    const m: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const p of data?.heatmap ?? []) {
      if (p.dow >= 0 && p.dow < 7 && p.hour >= 0 && p.hour < 24) m[p.dow][p.hour] = p.count;
    }
    return m;
  }, [data]);

  const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  const dowData = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.dow.map((d) => [d.dow, d.count]));
    return DOW_LABELS.map((label, dow) => ({ label, value: map.get(dow) ?? 0 }));
  }, [data]);

  const hourData = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.hours.map((h) => [h.hour, h.count]));
    return Array.from({ length: 24 }, (_, hour) => ({
      label: String(hour),
      value: map.get(hour) ?? 0,
    }));
  }, [data]);

  const daysInPeriod = useMemo(() => {
    if (!period.year || !period.month) return null;
    if (period.isAll) {
      const daily = data?.daily ?? [];
      if (daily.length === 0) return null;
      const dates = daily.map((point) => new Date(point.date).getTime());
      const days = Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000) + 1;
      return days > 0 ? days : null;
    }
    return new Date(period.year, period.month, 0).getDate();
  }, [period, data]);

  const peakHour = useMemo<{ hour: number; count: number } | null>(() => {
    if (!data) return null;
    return data.hours.reduce(
      (best, cur) => (best === null || cur.count > best.count ? cur : best),
      null as { hour: number; count: number } | null,
    );
  }, [data]);

  // 初回読み込み中はカード構成 (タイトル) を維持し、値とグラフだけスケルトンにする。
  // 失敗時も同じ構成のまま「—」等を表示して崩れないようにする
  const loading = !data && !failed;

  if (failed) {
    // fallthrough: 下でバナーを出しつつカードグリッドを描画する
  }

  if (data && (!data.channel || data.messages === 0)) {
    return (
      <div className="space-y-4">
        <Link
          href={`/channels?m=${period.key}`}
          className="inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground"
        >
          チャンネル一覧へ戻る
        </Link>
        <ChannelNoContent
          channelId={data.channel?.channel_id ?? null}
          channelName={data.channel?.name ?? null}
        />
      </div>
    );
  }

  const channel = data?.channel ?? null;
  const total = data?.messages ?? 0;
  const avgPerDay = daysInPeriod && total > 0 ? total / daysInPeriod : null;
  const avgChars = data && total > 0 ? Math.round(data.chars / total) : null;
  const activeDays = data?.daily.length ?? 0;
  /** 文字数王カードを出せるか (旧APIレスポンスには含まれない。読み込み中は出しておく) */
  const hasChars = loading || typeof data?.members[0]?.chars === "number";
  const members = data?.members ?? [];
  const top10 = members.slice(0, 10);
  const top10Share = total > 0 ? top10.reduce((s, u) => s + u.count, 0) / total : null;
  const topDates = data?.top_dates ?? [];

  /** 発言率 (0〜1) を % 表記に。対象が0なら null */
  const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);

  // 前期間比 (全期間や前月データなしのときはnull → "--"表示)
  const prevInsights = period.isAll ? null : prevData;
  const prevTotal = prevInsights?.messages ?? null;
  const prevUsers = prevInsights?.users ?? null;
  const prevChars = prevInsights?.chars ?? null;
  const prevAvgChars =
    prevInsights && prevInsights.messages > 0
      ? Math.round(prevInsights.chars / prevInsights.messages)
      : null;
  const prevActiveDays = prevInsights ? prevInsights.daily.length : null;
  const prevAvgPerDay = (() => {
    if (!prevInsights || !prevMonth) return null;
    const days = new Date(prevMonth.year, prevMonth.month, 0).getDate();
    return prevInsights.messages > 0 ? prevInsights.messages / days : null;
  })();
  const prevPeak = prevInsights
    ? prevInsights.hours.reduce(
        (best, cur) => (best === null || cur.count > best.count ? cur : best),
        null as { hour: number; count: number } | null,
      )
    : null;

  // 各カードの拡大ポップアップに渡すデータ一式
  const dlgCtx: DialogData = {
    daily: (data?.daily ?? []).map((p) => ({ date: Date.parse(p.date), value: p.count })),
    dailyUsers: (data?.daily ?? []).some((p) => p.users !== undefined)
      ? (data?.daily ?? []).map((p) => ({ date: Date.parse(p.date), value: p.users ?? 0 }))
      : undefined,
    dailyChars: (data?.daily ?? []).some((p) => p.chars !== undefined)
      ? (data?.daily ?? []).map((p) => ({ date: Date.parse(p.date), value: p.chars ?? 0 }))
      : undefined,
    matrix: heatMatrix,
    dowData,
    hourData,
    topMembers: members.slice(0, 10).map((u) => ({ name: u.display_name, value: u.count })),
    analysis: {
      new_members: data?.new_members ?? null,
      repeat: data?.repeat ?? null,
      longest_message: data?.longest_message ?? null,
      leaders: data?.leaders ?? null,
    },
    daysInPeriod,
    isAll: period.isAll,
  };
  const dlg = {
    total: totalMessagesDialog(dlgCtx),
    users: membersDialog(dlgCtx),
    chars: charsDialog(dlgCtx),
    avgDay: avgPerDayDialog(dlgCtx),
    avgChars: avgCharsDialog(dlgCtx),
    peak: peakHourDialog(dlgCtx),
    rank: rankDialog(dlgCtx, { rank: data?.rank ?? null, category: channel?.category ?? "" }),
    activeDays: activeDaysDialog(dlgCtx),
    heatmap: heatDialogContent(dlgCtx),
    trend: trendDialog(dlgCtx),
    topMembers: topMembersDialog(dlgCtx, {
      items: members.slice(0, 10).map((u) => ({ name: u.display_name, count: u.count })),
      total,
    }),
    topDays: topDaysDialog(dlgCtx, { topDates, total }),
    dow: dowDialogContent(dlgCtx),
    hour: hourDialogContent(dlgCtx),
  };

  return (
    <div className="space-y-5">
      <PageToolbar
        title={channel ? `#${channel.name}` : "#…"}
        subtitle={`${title}のチャンネル統計`}
        right={<PeriodPicker period={period} />}
      />

      <Reorderable
        resetToken={orderResetToken}
        storageKey={period.isAll ? "layout.channel.all" : "layout.channel.month"}
        items={[
          {
            id: "kpi-total",
            node: (
              <StatCard
                title="総発言数"
                value={total}
                unit="件"
                delta={deltaRate(total, prevTotal)}
                series={(data?.daily ?? []).map((p) => ({
                  label: shortDate(p.date),
                  date: Date.parse(p.date),
                  value: p.count,
                }))}
                loading={!ready("kpi-total")}
                dialogStats={dlg.total.stats}
                dialogExtra={dlg.total.extra}
              />
            ),
          },
          {
            id: "kpi-users",
            node: (
              <StatCard
                title="アクティブメンバー"
                value={data?.users ?? 0}
                unit="人"
                delta={deltaRate(data?.users ?? 0, prevUsers)}
                series={
                  (data?.daily ?? []).some((p) => p.users !== undefined)
                    ? (data?.daily ?? []).map((p) => ({
                        label: shortDate(p.date),
                        date: Date.parse(p.date),
                        value: p.users ?? 0,
                      }))
                    : undefined
                }
                loading={!ready("kpi-users")}
                dialogStats={dlg.users.stats}
                dialogExtra={dlg.users.extra}
              />
            ),
          },
          {
            id: "kpi-chars",
            node: (
              <StatCard
                title="総文字数"
                value={data?.chars ?? 0}
                unit="字"
                delta={deltaRate(data?.chars ?? 0, prevChars)}
                series={
                  (data?.daily ?? []).some((p) => p.chars !== undefined)
                    ? (data?.daily ?? []).map((p) => ({
                        label: shortDate(p.date),
                        date: Date.parse(p.date),
                        value: p.chars ?? 0,
                      }))
                    : undefined
                }
                loading={!ready("kpi-chars")}
                dialogStats={dlg.chars.stats}
                dialogExtra={dlg.chars.extra}
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
                delta={deltaRate(avgPerDay, prevAvgPerDay)}
                chartType="bar"
                series={(data?.daily ?? [])
                  .slice(-14)
                  .map((p) => ({ label: shortDate(p.date), value: p.count }))}
                loading={!ready("kpi-avg-day")}
                dialogStats={dlg.avgDay.stats}
                dialogExtra={dlg.avgDay.extra}
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
                delta={deltaRate(avgChars, prevAvgChars)}
                series={
                  (data?.daily ?? []).some((p) => p.chars !== undefined)
                    ? (data?.daily ?? []).map((p) => ({
                        label: shortDate(p.date),
                        date: Date.parse(p.date),
                        value: p.count > 0 ? Math.round((p.chars ?? 0) / p.count) : 0,
                      }))
                    : undefined
                }
                loading={!ready("kpi-avg-chars")}
                dialogStats={dlg.avgChars.stats}
                dialogExtra={dlg.avgChars.extra}
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
                delta={deltaRate(peakHour?.count ?? null, prevPeak?.count ?? null)}
                series={hourData}
                chartType="bar"
                loading={!ready("kpi-peak")}
                dialogStats={dlg.peak.stats}
                dialogExtra={dlg.peak.extra}
              />
            ),
          },
          {
            id: "kpi-rank",
            node: (
              <StatCard
                title="チャンネルランク"
                value={data?.rank ? `${data.rank}位` : "—"}
                series={(data?.daily ?? []).map((p) => ({
                  label: shortDate(p.date),
                  date: Date.parse(p.date),
                  value: p.count,
                }))}
                loading={!ready("kpi-rank")}
                dialogStats={dlg.rank.stats}
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
                delta={deltaRate(activeDays, prevActiveDays)}
                series={(data?.daily ?? []).map((p) => ({
                  label: shortDate(p.date),
                  date: Date.parse(p.date),
                  value: p.count,
                }))}
                loading={!ready("kpi-active-days")}
                dialogStats={dlg.activeDays.stats}
                dialogExtra={dlg.activeDays.extra}
              />
            ),
          },
          {
            id: "heatmap",
            className: "md:col-span-2 xl:col-span-2",
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
                <DialogStats items={dlg.heatmap.stats} />
                <div className="mt-4">
                  <ActivityHeatChart matrix={heatMatrix} />
                </div>
                {dlg.heatmap.extra}
              </div>
            ),
          },
          {
            id: "rank-messages",
            // 発言王は最も注目するカードなので横2列で一番左に置く
            className: "xl:col-span-2",
            node: (
              <RankTopCard
                title="発言王"
                note="このチャンネルで最も発言したメンバー"
                unit="件"
                loading={!ready("rank-messages")}
                items={members.map((u) => ({
                  user_id: u.user_id,
                  display_name: u.display_name,
                  avatar: u.avatar,
                  count: u.count,
                }))}
                hrefBase="/members/"
                hrefQuery={`m=${period.key}`}
              />
            ),
            dialog: (
              <div className="pr-7">
                <DialogStats className="mb-4" items={dlg.topMembers.stats} />
                <RankTopCard
                  bare
                  title="発言王"
                  note="このチャンネルで最も発言したメンバー トップ10"
                  unit="件"
                  max={10}
                  items={members.map((u) => ({
                    user_id: u.user_id,
                    display_name: u.display_name,
                    avatar: u.avatar,
                    count: u.count,
                  }))}
                  hrefBase="/members/"
                  hrefQuery={`m=${period.key}`}
                />
                <div className="mt-5">{dlg.topMembers.extra}</div>
              </div>
            ),
          },
          {
            id: "rank-dates",
            // 文字数王があるときは1列、ないときは2列で発言王の横を埋める
            className: hasChars ? "" : "xl:col-span-2",
            node: (
              <RankTopCard
                title="最多発言日"
                note="このチャンネルで最も盛り上がった日 トップ5"
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
                <DialogStats className="mb-4" items={dlg.topDays.stats} />
                <RankTopCard
                  bare
                  title="最多発言日"
                  note="このチャンネルで最も盛り上がった日 トップ5"
                  unit="件"
                  emptyText="データがありません"
                  items={topDates.map((entry) => ({
                    user_id: `date-${entry.date}`,
                    display_name: entry.date.replaceAll("-", "/"),
                    count: entry.count,
                  }))}
                />
                <div className="mt-5">{dlg.topDays.extra}</div>
              </div>
            ),
          },
          // 文字数は旧APIレスポンスに含まれないため、データがある場合のみ表示する
          ...(typeof data?.members[0]?.chars === "number"
            ? [
                {
                  id: "rank-chars",
                  node: (
                    <RankTopCard
                      title="文字数王"
                      note="このチャンネルで最も多く文字を書いたメンバー"
                      unit="字"
                      loading={!ready("rank-chars")}
                      items={[...members]
                        .sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))
                        .map((u) => ({
                          user_id: u.user_id,
                          display_name: u.display_name,
                          avatar: u.avatar,
                          count: u.chars ?? 0,
                        }))}
                      hrefBase="/members/"
                      hrefQuery={`m=${period.key}`}
                    />
                  ),
                  dialog: (
                    <div className="pr-7">
                      <DialogStats
                        className="mb-4"
                        items={[
                          { label: "総文字数", value: jaNum.format(data?.chars ?? 0), sub: "字" },
                          { label: "対象メンバー", value: `${members.length}人` },
                          {
                            label: "1位の文字数",
                            value: jaNum.format(
                              [...members].sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))[0]
                                ?.chars ?? 0,
                            ),
                            sub:
                              [...members].sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))[0]
                                ?.display_name ?? undefined,
                          },
                          {
                            label: "1位のシェア",
                            value: pct(
                              (data?.chars ?? 0) > 0
                                ? ([...members].sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))[0]
                                    ?.chars ?? 0) / (data?.chars ?? 0)
                                : null,
                            ),
                          },
                        ]}
                      />
                      <RankTopCard
                        bare
                        title="文字数王"
                        note="このチャンネルで最も多く文字を書いたメンバー トップ10"
                        unit="字"
                        max={10}
                        items={[...members]
                          .sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))
                          .map((u) => ({
                            user_id: u.user_id,
                            display_name: u.display_name,
                            avatar: u.avatar,
                            count: u.chars ?? 0,
                          }))}
                        hrefBase="/members/"
                        hrefQuery={`m=${period.key}`}
                      />
                      {data?.longest_message && (
                        <div className="mt-5">
                          <DialogSection
                            title="最長メッセージ"
                            note={`${fmtDay(Date.parse(data.longest_message.date))} (${dowLabel(
                              Date.parse(data.longest_message.date),
                            )})`}
                          >
                            <LongestMessageSection longest={data.longest_message} />
                          </DialogSection>
                        </div>
                      )}
                    </div>
                  ),
                },
              ]
            : []),
          {
            id: "trend",
            className: "md:col-span-2 xl:col-span-2",
            node: (
              <div className="app-card-padded app-tile h-full min-w-0">
                <p className="text-sm font-black text-foreground">日別の発言数推移</p>
                <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                  期間内の每日の発言数
                </p>
                {!ready("trend") ? (
                  <div className="skeleton h-[240px] rounded-xl" />
                ) : (
                  <div className="data-in">
                    <DailyTrendChart points={trendPoints} height={240} />
                  </div>
                )}
              </div>
            ),
            dialog: (
              <div className="pr-7">
                <DialogStats items={dlg.trend.stats} />
                <div className="mt-4">
                  <DailyTrendChart points={trendPoints} height={300} />
                </div>
                {dlg.trend.extra}
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
                    <div className="skeleton h-[210px] rounded-xl" />
                  ) : (
                    <div className="data-in">
                      <CategoryBarChart data={dowData} height={210} />
                    </div>
                  )}
                </div>
              </div>
            ),
            dialog: (
              <div className="pr-7">
                <DialogStats className="mb-4" items={dlg.dow.stats} />
                <p className="mb-3 text-sm font-black text-foreground">曜日別の発言数</p>
                <CategoryBarChart data={dowData} height={300} />
                <div className="mt-5">{dlg.dow.extra}</div>
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
                    <div className="skeleton h-[210px] rounded-xl" />
                  ) : (
                    <div className="data-in">
                      <CategoryBarChart data={hourData} height={210} />
                    </div>
                  )}
                </div>
              </div>
            ),
            dialog: (
              <div className="pr-7">
                <DialogStats className="mb-4" items={dlg.hour.stats} />
                <p className="mb-3 text-sm font-black text-foreground">時間帯別の発言数</p>
                <CategoryBarChart data={hourData} height={300} />
                <div className="mt-5">{dlg.hour.extra}</div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
