"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarClock, MessageSquare, Sparkles } from "lucide-react";
import PageToolbar from "@/components/shell/PageToolbar";
import { usePendingBar } from "@/components/shell/AppShell";
import PeriodPicker from "@/components/shell/PeriodPicker";
import { BoostBadge, BoostIcon, ServerTagChip, UserAvatar } from "./discord/DiscordIdentity";
import StatCard from "./StatCard";
import { TileExpandable } from "./TileDialog";
import { CategoryBarChart, ChannelShareDonut, DailyTrendChart } from "./charts";
import {
  DialogSection,
  DialogStats,
  dowLabel,
  fmtDay,
  jaNum,
  type DialogStatItem,
} from "./dialog-parts";
import {
  LongestMessageSection,
  activeDaysDialog,
  avgCharsDialog,
  channelShareDialog,
  charsDialog,
  hourDialog as hourDialogContent,
  dowDialog as dowDialogContent,
  totalMessagesDialog,
  trendDialog,
  type DialogData,
} from "./dialog-contents";
import { deltaRate } from "./DeltaBadge";
import { fetchAPI, prefetchAPI } from "@/lib/api";
import { formatDiscordDate, profileBannerStyle, snowflakeToDate } from "@/lib/discord-assets";
import MemberNoContent from "@/components/views/MemberNoContent";
import { periodLabel, previousMonthOf, latestPublishedMonth } from "@/lib/period";

interface InsightsUser {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  banner: string | null;
  accent_color: string | null;
  avatar_decoration: string | null;
  nameplate: { asset: string; palette: string } | null;
  primary_guild_tag: string | null;
  primary_guild_badge: string | null;
  joined_at: string | null;
  premium_since: string | null;
}

interface Insights {
  user: InsightsUser | null;
  messages: number;
  chars: number;
  rank: number | null;
  daily: Array<{ date: string; count: number; chars?: number }>;
  channels: Array<{ channel_id: string; name: string; count: number }>;
  dow: Array<{ dow: number; count: number }>;
  hours: Array<{ hour: number; count: number }>;
  longest_message: {
    chars: number;
    display_name: string;
    date: string;
    channel_name?: string;
  } | null;
  first_at: string | null;
  last_at: string | null;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function shortDate(date: string): string {
  const parts = date.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-bold text-foreground">{value}</span>
    </div>
  );
}

export default function MemberDetailView({
  userId,
  period,
}: {
  userId: string;
  period: { key: string; year: number | null; month: number | null; isAll: boolean };
}) {
  const [data, setData] = useState<Insights | null>(null);
  const [prevData, setPrevData] = useState<Insights | null>(null);

  const base = period.isAll
    ? `/users/${userId}/insights/total`
    : `/users/${userId}/insights/${period.year}/${period.month}`;

  // 前期間比表示用に前月のinsightsも取得する (全期間は比較対象がないためnull)
  const prevMonth = previousMonthOf(period);
  const prevBase = prevMonth
    ? `/users/${userId}/insights/${prevMonth.year}/${prevMonth.month}`
    : null;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setPrevData(null);
    // 本体を先に取得して表示し、前期間比 (delta) はその後に取得する
    const loadBase = async () => {
      try {
        const res = await fetchAPI(base, { retries: 1 });
        if (cancelled) return;
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Insights;
        if (!cancelled) setData(body);
      } catch {
        // 失敗時のリダイレクトは fetchAPI 側で処理済み
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
  }, [base, prevBase, userId]);

  // データ取得後、前後の月のinsightsを事前取得しておく (期間切替を高速化)
  useEffect(() => {
    if (!data) return;
    const bases: string[] = [];
    if (period.isAll) {
      const latest = latestPublishedMonth();
      bases.push(`/users/${userId}/insights/${latest.year}/${latest.month}`);
    } else if (period.year && period.month) {
      const prev = previousMonthOf({
        key: "",
        year: period.year,
        month: period.month,
        isAll: false,
      });
      if (prev) bases.push(`/users/${userId}/insights/${prev.year}/${prev.month}`);
      const nextMonth = period.month === 12 ? 1 : period.month + 1;
      const nextYear = period.month === 12 ? period.year + 1 : period.year;
      const latest = latestPublishedMonth();
      const published =
        nextYear < latest.year || (nextYear === latest.year && nextMonth <= latest.month);
      if (published) bases.push(`/users/${userId}/insights/${nextYear}/${nextMonth}`);
    }
    if (bases.length === 0) return;
    const timer = setTimeout(() => {
      for (const base of bases) prefetchAPI(base);
    }, 1000);
    return () => clearTimeout(timer);
  }, [data, userId, period]);

  const title = period.isAll ? "全期間" : periodLabel(period);

  const trendPoints = useMemo(
    () => (data?.daily ?? []).map((p) => ({ date: Date.parse(p.date), value: p.count })),
    [data],
  );

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

  const accountCreatedAt = useMemo(() => snowflakeToDate(userId), [userId]);

  // 初回読み込み中はカード構成 (タイトル等) を維持し、値とグラフだけスケルトンにする。
  // 失敗時も同じ構成のまま「—」等を表示して崩れないようにする
  const loading = !data;

  // 読み込み中はシェル最上部の共通バーを出す
  usePendingBar(loading);

  // 初回読み込み中・失敗時はカード構成 (タイトル) を維持したスケルトンを表示する。
  // 失敗時は shimmer を止めて「—」等を表示して崩れないようにする
  if (!data) {
    const sk = (cls: string) => (loading ? `skeleton ${cls}` : `bg-muted ${cls}`);
    return (
      <div className="space-y-5">
        <Link
          href={`/members?m=${period.key}`}
          className="inline-flex items-center gap-1 text-sm font-bold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          メンバー一覧へ戻る
        </Link>

        <PageToolbar
          title={title}
          subtitle="メンバーの行動や好みをより詳しく把握しましょう！"
          right={<PeriodPicker period={period} />}
        />

        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
          <div className="app-card overflow-hidden">
            <div className={sk("h-32 w-full md:h-40")} />
            <div className="px-5 pb-5 md:px-6">
              <div className="-mt-10 mb-3">
                <div className={sk("h-20 w-20 rounded-full")} />
              </div>
              <div className="space-y-2">
                <div className={sk("h-6 w-48 rounded-lg")} />
                <div className={sk("h-4 w-32 rounded-md")} />
              </div>
              <div className="mt-4 space-y-2.5 border-t border-border pt-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className={sk("h-4 w-full max-w-64 rounded-md")} />
                ))}
              </div>
            </div>
          </div>
          <div className="grid auto-rows-fr grid-cols-2 gap-4">
            {["発言数", "総文字数", "平均文字数/発言", "アクティブ日数"].map((t) => (
              <StatCard key={t} title={t} value="—" loading={loading} />
            ))}
          </div>
        </div>

        <TileExpandable
          label="日別の発言数推移"
          dialog={
            <div className="pr-7">
              {loading ? (
                <div className={sk("h-[300px] rounded-xl")} />
              ) : (
                <div className={sk("h-[300px] rounded-xl")} />
              )}
            </div>
          }
        >
          <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
            <p className="text-sm font-black text-foreground">日別の発言数推移</p>
            <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
              {title}の毎日の発言数
            </p>
            <div className={sk("h-[240px] rounded-xl")} />
          </div>
        </TileExpandable>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <TileExpandable
            label="よく発言するチャンネル"
            dialog={
              <div className="pr-7">
                {loading ? (
                  <div className={sk("h-[280px] rounded-xl")} />
                ) : (
                  <div className={sk("h-[280px] rounded-xl")} />
                )}
              </div>
            }
          >
            <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
              <p className="text-sm font-black text-foreground">よく発言するチャンネル</p>
              <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                発言シェアの内訳
              </p>
              <div className="flex flex-1 items-center justify-center">
                {loading ? (
                  <div className="skeleton h-[180px] w-[180px] rounded-full" />
                ) : (
                  <div className={sk("h-[280px] rounded-xl")} />
                )}
              </div>
            </div>
          </TileExpandable>

          <TileExpandable
            label="曜日別の発言数"
            dialog={
              <div className="pr-7">
                {loading ? (
                  <div className={sk("h-[280px] rounded-xl")} />
                ) : (
                  <div className={sk("h-[280px] rounded-xl")} />
                )}
              </div>
            }
          >
            <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
              <p className="text-sm font-black text-foreground">曜日別の発言数</p>
              <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                よく発言する曜日の傾向
              </p>
              <div className="flex flex-1 items-center">
                <div className={sk("h-[150px] w-full rounded-xl")} />
              </div>
            </div>
          </TileExpandable>
          <TileExpandable
            label="時間帯別の発言数"
            dialog={
              <div className="pr-7">
                {loading ? (
                  <div className={sk("h-[280px] rounded-xl")} />
                ) : (
                  <div className={sk("h-[280px] rounded-xl")} />
                )}
              </div>
            }
          >
            <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
              <p className="text-sm font-black text-foreground">時間帯別の発言数</p>
              <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
                よく発言する時間帯の傾向
              </p>
              <div className="flex flex-1 items-center">
                <div className={sk("h-[150px] w-full rounded-xl")} />
              </div>
            </div>
          </TileExpandable>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {["最もよく発言するチャンネル", "よく発言する時間帯", "最長メッセージ"].map((t) => (
            <TileExpandable
              key={t}
              label={t}
              dialog={
                <div className="pr-7">
                  {loading ? (
                    <div className={sk("h-[200px] rounded-xl")} />
                  ) : (
                    <div className={sk("h-[200px] rounded-xl")} />
                  )}
                </div>
              }
            >
              <div className="app-card-padded app-tile flex h-full min-w-0 flex-col justify-center">
                <p className="text-sm font-black text-foreground">{t}</p>
                <div className="mt-2 space-y-2">
                  <div className={sk("h-8 w-32 rounded-md")} />
                  <div className={sk("h-4 w-40 rounded-md")} />
                </div>
              </div>
            </TileExpandable>
          ))}
        </div>
      </div>
    );
  }

  if (!data.user || data.messages === 0) {
    return (
      <div className="space-y-4">
        <Link
          href={`/members?m=${period.key}`}
          className="inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          メンバー一覧へ戻る
        </Link>
        <MemberNoContent userId={userId} />
      </div>
    );
  }

  const user = data.user;
  const activeDays = data.daily.filter((p) => p.count > 0).length;
  const charsTrendPoints = data.daily.some((p) => p.chars !== undefined)
    ? data.daily.map((p) => ({ date: Date.parse(p.date), value: p.chars ?? 0 }))
    : null;
  const channelsTotal = data.channels.reduce((s, c) => s + c.count, 0);
  const top3Share =
    channelsTotal > 0
      ? data.channels.slice(0, 3).reduce((s, c) => s + c.count, 0) / channelsTotal
      : null;
  /** 発言率 (0〜1) を % 表記に。対象が0なら null */
  const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);
  const topChannel = data.channels[0];
  const peakHour = data.hours.reduce<(typeof data.hours)[number] | null>(
    (best, h) => (!best || h.count > best.count ? h : best),
    null,
  );

  // 各カードの拡大ポップアップに渡すデータ一式 (メンバーは曜日別データがないため
  // ヒートマップのmatrixは時間帯集計のみ時間帯比率に使う)
  const hourMatrix = (() => {
    const m = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const h of data.hours) m[0][h.hour] = h.count;
    return m;
  })();
  const dlgCtx: DialogData = {
    daily: data.daily.map((p) => ({ date: Date.parse(p.date), value: p.count })),
    dailyChars: data.daily.some((p) => p.chars !== undefined)
      ? data.daily.map((p) => ({ date: Date.parse(p.date), value: p.chars ?? 0 }))
      : undefined,
    matrix: hourMatrix,
    dowData: DOW_LABELS.map((label, dow) => ({
      label,
      value: data.dow.find((d) => d.dow === dow)?.count ?? 0,
    })),
    hourData: Array.from({ length: 24 }, (_, hour) => ({
      label: String(hour),
      value: data.hours.find((h) => h.hour === hour)?.count ?? 0,
    })),
    channels: data.channels.map((c) => ({ name: c.name, value: c.count })),
    analysis: {
      new_members: null,
      repeat: null,
      longest_message: data.longest_message,
      leaders: null,
    },
    isAll: period.isAll,
  };
  const dlg = {
    messages: totalMessagesDialog(dlgCtx),
    chars: charsDialog(dlgCtx),
    avgChars: avgCharsDialog(dlgCtx),
    activeDays: activeDaysDialog(dlgCtx),
    trend: trendDialog(dlgCtx),
    share: channelShareDialog(dlgCtx),
    dow: dowDialogContent(dlgCtx),
    hour: hourDialogContent(dlgCtx),
  };

  // 前期間比 (全期間や前月データなしのときはnull → "--"表示)
  const prevInsights = period.isAll ? null : prevData;
  const prevActiveDays = prevInsights ? prevInsights.daily.filter((p) => p.count > 0).length : null;
  const curAvgChars = data.messages > 0 ? Math.round(data.chars / data.messages) : null;
  const prevAvgChars =
    prevInsights && prevInsights.messages > 0
      ? Math.round(prevInsights.chars / prevInsights.messages)
      : null;

  return (
    <div className="space-y-5">
      <Link
        href={`/members?m=${period.key}`}
        className="inline-flex items-center gap-1 text-sm font-bold text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        メンバー一覧へ戻る
      </Link>

      <PageToolbar
        title={title}
        subtitle="メンバーの行動や好みをより詳しく把握しましょう！"
        right={<PeriodPicker period={period} />}
      />

      {/* プロフィール (左) とKPI (右) を別カードで左右に配置 */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
        <div className="app-card anim-rise overflow-hidden">
          <div
            className="h-32 w-full md:h-40"
            style={profileBannerStyle({
              banner: user.banner,
              accentColor: user.accent_color,
              userId: user.user_id,
            })}
          />
          <div className="px-5 pb-5 md:px-6">
            <div>
              <div className="-mt-10 mb-3">
                <UserAvatar user={user} size={80} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-black tracking-tight text-foreground md:text-2xl">
                  {user.display_name}
                </h2>
                <ServerTagChip tag={user.primary_guild_tag} badge={user.primary_guild_badge} />
                {user.premium_since && <BoostBadge />}
              </div>
              <p className="text-sm font-bold text-muted-foreground">@{user.username}</p>
              <div className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
                <MetaRow
                  icon={<CalendarClock className="h-4 w-4" aria-hidden="true" />}
                  label="サーバーに参加した日"
                  value={formatDiscordDate(user.joined_at)}
                />
                <MetaRow
                  icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
                  label="Discordアカウント作成日"
                  value={formatDiscordDate(accountCreatedAt?.toISOString() ?? null)}
                />
                {user.premium_since && (
                  <MetaRow
                    icon={<BoostIcon className="h-4 w-4" />}
                    label="ブースト開始日"
                    value={formatDiscordDate(user.premium_since)}
                  />
                )}
                <MetaRow
                  icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
                  label="最初の発言"
                  value={formatDiscordDate(data.first_at)}
                />
              </div>
            </div>
          </div>
        </div>
        <div
          className="anim-rise grid auto-rows-fr grid-cols-2 gap-4"
          style={{ animationDelay: "60ms" }}
        >
          <StatCard
            title="発言数"
            value={data.messages}
            unit="件"
            delta={deltaRate(data.messages, prevInsights?.messages ?? null)}
            series={data.daily.map((p) => ({
              label: shortDate(p.date),
              date: Date.parse(p.date),
              value: p.count,
            }))}
            dialogStats={dlg.messages.stats}
            dialogExtra={dlg.messages.extra}
          />
          <StatCard
            title="総文字数"
            value={data.chars}
            unit="字"
            delta={deltaRate(data.chars, prevInsights?.chars ?? null)}
            series={data.daily.map((p) => ({
              label: shortDate(p.date),
              date: Date.parse(p.date),
              value: p.chars ?? 0,
            }))}
            dialogStats={dlg.chars.stats}
            dialogExtra={dlg.chars.extra}
          />
          <StatCard
            title="平均文字数/発言"
            value={curAvgChars ?? "—"}
            unit="字"
            delta={deltaRate(curAvgChars, prevAvgChars)}
            series={data.daily.map((p) => ({
              label: shortDate(p.date),
              date: Date.parse(p.date),
              value: p.count > 0 ? Math.round((p.chars ?? 0) / p.count) : 0,
            }))}
            dialogStats={dlg.avgChars.stats}
            dialogExtra={dlg.avgChars.extra}
          />
          <StatCard
            title="アクティブ日数"
            value={activeDays}
            unit="日"
            delta={deltaRate(activeDays, prevActiveDays)}
            chartType="bar"
            series={data.daily.map((p) => ({ label: shortDate(p.date), value: p.count }))}
            dialogStats={dlg.activeDays.stats}
            dialogExtra={dlg.activeDays.extra}
          />
        </div>
      </div>

      <TileExpandable
        className="anim-rise"
        label="日別の発言数推移"
        dialog={
          <div className="pr-7">
            <DialogStats items={dlg.trend.stats} />
            <div className="mt-4">
              <DailyTrendChart points={trendPoints} height={300} />
            </div>
            {dlg.trend.extra}
            {charsTrendPoints && (
              <div className="mt-5">
                <DialogSection title="文字数の推移" note="1日の合計文字数">
                  <DailyTrendChart points={charsTrendPoints} height={180} />
                </DialogSection>
              </div>
            )}
          </div>
        }
      >
        <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
          <p className="text-sm font-black text-foreground">日別の発言数推移</p>
          <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
            {title}の毎日の発言数
          </p>
          <div className="h-[240px]">
            <div className="data-in h-full">
              <DailyTrendChart points={trendPoints} fill className="h-full" />
            </div>
          </div>
        </div>
      </TileExpandable>

      {/* ドーナツは横幅の1/3に抑え、その隣に曜日別・時間帯別を並べる */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TileExpandable
          className="anim-rise"
          label="よく発言するチャンネル"
          dialog={
            <div className="pr-7">
              <DialogStats className="mb-4" items={dlg.share.stats} />
              <ChannelShareDonut
                channels={data.channels.map((c) => ({ name: c.name, value: c.count }))}
                max={10}
              />
            </div>
          }
        >
          <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
            <p className="text-sm font-black text-foreground">よく発言するチャンネル</p>
            <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">発言シェアの内訳</p>
            <div className="flex flex-1 items-center justify-center">
              <div className="data-in">
                <ChannelShareDonut
                  channels={data.channels.map((c) => ({ name: c.name, value: c.count }))}
                  max={10}
                  showLegend={false}
                  size={180}
                />
              </div>
            </div>
          </div>
        </TileExpandable>

        <TileExpandable
          className="anim-rise"
          label="曜日別の発言数"
          dialog={
            <div className="pr-7">
              <DialogStats className="mb-4" items={dlg.dow.stats} />
              <p className="mb-3 text-sm font-black text-foreground">曜日別の発言数</p>
              <CategoryBarChart data={dowData} height={280} />
              <div className="mt-5">{dlg.dow.extra}</div>
            </div>
          }
        >
          <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
            <p className="text-sm font-black text-foreground">曜日別の発言数</p>
            <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
              よく発言する曜日の傾向
            </p>
            <div className="flex flex-1 items-center">
              <div className="data-in w-full">
                <CategoryBarChart data={dowData} height={150} />
              </div>
            </div>
          </div>
        </TileExpandable>
        <TileExpandable
          className="anim-rise"
          label="時間帯別の発言数"
          dialog={
            <div className="pr-7">
              <DialogStats className="mb-4" items={dlg.hour.stats} />
              <p className="mb-3 text-sm font-black text-foreground">時間帯別の発言数</p>
              <CategoryBarChart data={hourData} height={280} />
              <div className="mt-5">{dlg.hour.extra}</div>
            </div>
          }
        >
          <div className="app-card-padded app-tile flex h-full min-w-0 flex-col">
            <p className="text-sm font-black text-foreground">時間帯別の発言数</p>
            <p className="mt-0.5 mb-2 text-xs font-bold text-muted-foreground">
              よく発言する時間帯の傾向
            </p>
            <div className="flex flex-1 items-center">
              <div className="data-in w-full">
                <CategoryBarChart data={hourData} height={150} />
              </div>
            </div>
          </div>
        </TileExpandable>
      </div>

      {/* ハイライトカード: トップチャンネル / ピーク時間帯 / 最長メッセージ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {topChannel && (
          <TileExpandable
            className="anim-rise"
            label="最もよく発言するチャンネル"
            dialog={
              <div className="pr-7">
                <DialogStats className="mb-4" items={dlg.share.stats} />
                <p className="mb-3 text-sm font-black text-foreground">
                  よく発言するチャンネル トップ{Math.min(5, data.channels.length)}
                </p>
                <CategoryBarChart
                  data={data.channels.slice(0, 5).map((c) => ({
                    label: `#${c.name}`,
                    value: c.count,
                  }))}
                  height={280}
                />
              </div>
            }
          >
            <div className="app-card-padded app-tile flex h-full min-w-0 flex-col justify-center">
              <p className="text-sm font-black text-foreground">最もよく発言するチャンネル</p>
              <div className="mt-2 data-in">
                <p className="truncate text-3xl font-black tracking-tight text-foreground">
                  #{topChannel.name}
                </p>
                <p className="mt-1 text-sm font-bold text-muted-foreground">
                  {jaNum.format(topChannel.count)}件
                  {channelsTotal > 0 && ` (発言の${pct(topChannel.count / channelsTotal)})`}
                </p>
              </div>
            </div>
          </TileExpandable>
        )}
        {peakHour && (
          <TileExpandable
            className="anim-rise"
            label="よく発言する時間帯"
            dialog={
              <div className="pr-7">
                <DialogStats className="mb-4" items={dlg.hour.stats} />
                <p className="mb-3 text-sm font-black text-foreground">時間帯別の発言数</p>
                <CategoryBarChart data={hourData} height={280} />
                <div className="mt-5">{dlg.hour.extra}</div>
              </div>
            }
          >
            <div className="app-card-padded app-tile flex h-full min-w-0 flex-col justify-center">
              <p className="text-sm font-black text-foreground">よく発言する時間帯</p>
              <div className="mt-2 data-in">
                <p className="text-3xl font-black tracking-tight text-foreground">
                  {peakHour.hour}時台
                </p>
                <p className="mt-1 text-sm font-bold text-muted-foreground">
                  {jaNum.format(peakHour.count)}件
                  {` (発言の${pct(peakHour.count / data.messages)})`}
                </p>
              </div>
            </div>
          </TileExpandable>
        )}
        <TileExpandable
          className="anim-rise"
          label="最長メッセージ"
          dialog={
            <div className="pr-7">
              <DialogSection
                title="最長メッセージ"
                note={
                  data.longest_message
                    ? `${fmtDay(Date.parse(data.longest_message.date))} (${dowLabel(
                        Date.parse(data.longest_message.date),
                      )})`
                    : undefined
                }
              >
                <LongestMessageSection longest={data.longest_message} />
              </DialogSection>
            </div>
          }
        >
          <div className="app-card-padded app-tile flex h-full min-w-0 flex-col justify-center">
            <p className="text-sm font-black text-foreground">最長メッセージ</p>
            <div className="mt-2 data-in">
              {data.longest_message ? (
                <>
                  <p className="text-3xl font-black tracking-tight text-foreground">
                    {jaNum.format(data.longest_message.chars)}
                    <span className="ml-1.5 text-sm font-bold text-muted-foreground">字</span>
                  </p>
                  <p className="mt-1 text-sm font-bold text-muted-foreground">
                    {fmtDay(Date.parse(data.longest_message.date))} (
                    {dowLabel(Date.parse(data.longest_message.date))})
                  </p>
                </>
              ) : (
                <p className="text-3xl font-black tracking-tight text-foreground">—</p>
              )}
            </div>
          </div>
        </TileExpandable>
      </div>
    </div>
  );
}
