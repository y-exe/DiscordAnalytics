"use client";

/**
 * カード拡大ポップアップの中身を構築するビルダー群。
 * サマリー / チャンネル / メンバーの各ビューで共通利用する。
 * 各ビルダーは curated な統計グリッド (stats) と、メイングラフの下に
 * 追加するセクション (extra) を返す。
 */

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import type { DataTableProps } from "@/components/ui/easyui/DataTable";
import { CategoryBarChart } from "./charts";

// DataTable (38KB) はダイアログ開閉時しか使わないため遅延読み込みする。
// next/dynamic はジェネリクスを保持しないため、使用側の形で型を付け直す。
const DataTable = dynamic(
  () => import("@/components/ui/easyui/DataTable").then((m) => m.DataTable),
  {
    ssr: false,
    loading: () => <div className="skeleton h-64 w-full rounded-xl" />,
  },
) as unknown as <T extends { id: string | number }>(props: DataTableProps<T>) => ReactNode;
import {
  ActivityCalendar,
  DialogSection,
  DialogStats,
  RatioDonut,
  SplitBar,
  TwoColumns,
  categoryStats,
  dowLabel,
  fmtDay,
  jaNum,
  median,
  stddev,
  splitHalves,
  streakDays,
  timeOfDaySplit,
  topShare,
  type DialogStatItem,
  type LabeledValue,
  weeklyBuckets,
  weekdayWeekend,
} from "./dialog-parts";

export interface RepeatBuckets {
  one: number;
  two_three: number;
  four_seven: number;
  eight_plus: number;
}

export interface LongestMessage {
  chars: number;
  display_name: string;
  date: string;
  channel_name?: string;
}

export interface LeaderEntry {
  date: string;
  display_name: string;
  count: number;
}

/** ダイアログ構築に必要なデータ一式 */
export interface DialogData {
  /** 日次発言数 */
  daily: { date: number; value: number }[];
  /** 日別ユニーク人数 (なければ非表示) */
  dailyUsers?: { date: number; value: number }[];
  /** 日次文字数 (なければ非表示) */
  dailyChars?: { date: number; value: number }[];
  /** 曜日×時間帯のヒートマップ */
  matrix: number[][];
  dowData: LabeledValue[];
  hourData: LabeledValue[];
  analysis?: {
    new_members: number | null;
    repeat: RepeatBuckets | null;
    longest_message: LongestMessage | null;
    leaders: LeaderEntry[] | null;
  };
  /** チャンネル別内訳 (サマリーのみ) */
  channels?: { name: string; value: number }[];
  /** 発言数上位メンバー (シェアドーナツ用) */
  topMembers?: { name: string; value: number }[];
  daysInPeriod?: number | null;
  isAll: boolean;
}

export interface DialogContent {
  stats: DialogStatItem[];
  extra: ReactNode;
}

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 日別の平均文字数系列 (chars/count) */
function avgCharsSeries(d: DialogData): { date: number; value: number }[] {
  const chars = d.dailyChars ?? [];
  const counts = new Map(d.daily.map((p) => [p.date, p.value]));
  return chars.map((p) => ({
    date: p.date,
    value: (counts.get(p.date) ?? 0) > 0 ? Math.round(p.value / (counts.get(p.date) ?? 1)) : 0,
  }));
}

/** 日付 (ms) → その日のユニーク人数 */
function usersOn(d: DialogData, dateMs: number): number | null {
  if (!d.dailyUsers) return null;
  return d.dailyUsers.find((p) => p.date === dateMs)?.value ?? null;
}

/* ------------------------------ 総発言数 ------------------------------ */

export function totalMessagesDialog(d: DialogData): DialogContent {
  const values = d.daily.map((p) => p.value);
  const maxI = values.indexOf(Math.max(...values));
  const minI = values.indexOf(Math.min(...values));
  const halves = splitHalves(d.daily);
  const halfDiff = halves.first > 0 ? (halves.second - halves.first) / halves.first : null;
  const ww = weekdayWeekend(d.dowData);
  const stats: DialogStatItem[] = [
    {
      label: "1日平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: "件",
    },
    { label: "中央値", value: jaNum.format(median(values)), sub: "件/日" },
    {
      label: "連続活動日数",
      value: `${streakDays(d.daily)}日`,
      sub: "毎日誰かが発言した最長記録",
    },
    {
      label: "最多日",
      value: jaNum.format(values[maxI] ?? 0),
      sub: d.daily[maxI]
        ? `${fmtDay(d.daily[maxI].date)} (${dowLabel(d.daily[maxI].date)})`
        : undefined,
    },
    {
      label: "最少日",
      value: jaNum.format(values[minI] ?? 0),
      sub: d.daily[minI] ? fmtDay(d.daily[minI].date) : undefined,
    },
    {
      label: "後半の変化",
      value: halfDiff === null ? "—" : `${halfDiff >= 0 ? "+" : ""}${Math.round(halfDiff * 100)}%`,
      sub: "前半15日比",
    },
  ];
  const extra = (
    <>
      <TwoColumns>
        <DialogSection title="週ごとの発言数" note="月曜始まりの週で集計">
          <CategoryBarChart data={weeklyBuckets(d.daily)} height={220} />
        </DialogSection>
        {d.channels && d.channels.length > 0 && (
          <DialogSection title="チャンネル別の内訳" note="発言数の多いチャンネル トップ6">
            <CategoryBarChart
              data={d.channels.slice(0, 6).map((c) => ({ label: `#${c.name}`, value: c.value }))}
              height={220}
            />
          </DialogSection>
        )}
      </TwoColumns>
      <DialogSection title="時間帯の比率" note="発言が集中した時間帯" className="mt-5">
        <RatioDonut items={timeOfDaySplit(d.matrix)} unit="件" />
      </DialogSection>
      <TwoColumns>
        <DialogSection title="前半 vs 後半" note="期間の前半15日と後半の比較">
          <SplitBar
            left={{ label: "前半", value: halves.first }}
            right={{ label: "後半", value: halves.second }}
            unit="件"
          />
        </DialogSection>
        <DialogSection title="平日 vs 週末" note="月-金と土日の合計">
          <SplitBar
            left={{ label: "平日", value: ww.weekday }}
            right={{ label: "週末", value: ww.weekend }}
            unit="件"
          />
        </DialogSection>
      </TwoColumns>
    </>
  );
  return { stats, extra };
}

/* --------------------------- アクティブメンバー --------------------------- */

export function membersDialog(d: DialogData): DialogContent {
  const values = d.dailyUsers?.map((p) => p.value) ?? [];
  const totalMessages = sum(d.daily.map((p) => p.value));
  const repeat = d.analysis?.repeat ?? null;
  const memberCount = repeat
    ? repeat.one + repeat.two_three + repeat.four_seven + repeat.eight_plus
    : 0;
  const twoPlus =
    repeat && memberCount > 0
      ? (repeat.two_three + repeat.four_seven + repeat.eight_plus) / memberCount
      : null;
  const stats: DialogStatItem[] = [
    {
      label: "1日平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: "人/日",
    },
    {
      label: "1人あたり発言数",
      value: memberCount > 0 ? jaNum.format(round1(totalMessages / memberCount)) : "—",
      sub: `累計 (${memberCount}人)`,
    },
    {
      label: "新規メンバー",
      value: d.analysis?.new_members != null ? `${jaNum.format(d.analysis.new_members)}人` : "—",
      sub: "この期間に初めて発言",
    },
    { label: "リピーター率", value: pct(twoPlus), sub: "2日以上発言した割合" },
  ];
  const repeatData = repeat
    ? [
        { label: "1日だけ", value: repeat.one },
        { label: "2-3日", value: repeat.two_three },
        { label: "4-7日", value: repeat.four_seven },
        { label: "8日以上", value: repeat.eight_plus },
      ]
    : [];
  const shareItems =
    d.topMembers && d.topMembers.length > 0
      ? d.topMembers.slice(0, 10).map((m) => ({ label: m.name, value: m.value }))
      : [];
  const extra = (
    <>
      <DialogSection title="活動日数の分布" note="期間内に何日発言したメンバーか">
        {repeat ? (
          <CategoryBarChart data={repeatData} height={220} />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">データがありません</p>
        )}
      </DialogSection>
      <DialogSection
        title="発言数トップ10のシェア"
        note="上位メンバーが全体のどれだけを占めるか"
        className="mt-5"
      >
        {shareItems.length > 0 ? (
          <RatioDonut items={shareItems} unit="件" centerLabel="トップ10" />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">データがありません</p>
        )}
      </DialogSection>
    </>
  );
  return { stats, extra };
}

/* ------------------------------ 総文字数 ------------------------------ */

export function charsDialog(d: DialogData): DialogContent {
  const values = d.dailyChars?.map((p) => p.value) ?? [];
  const avgPerMsg = sum(values) / Math.max(1, sum(d.daily.map((p) => p.value)));
  const longest = d.analysis?.longest_message ?? null;
  const halves = splitHalves(d.dailyChars ?? []);
  const ww = weekdayWeekend(d.dowData);
  const stats: DialogStatItem[] = [
    {
      label: "1日平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: "字/日",
    },
    {
      label: "平均文字数/発言",
      value: jaNum.format(round1(Number.isFinite(avgPerMsg) ? avgPerMsg : 0)),
      sub: "字",
    },
    {
      label: "最長メッセージ",
      value: longest ? jaNum.format(longest.chars) : "—",
      sub: longest ? `${longest.display_name} さん` : undefined,
    },
    { label: "文字数最多日", value: jaNum.format(Math.max(0, ...values)), sub: "字" },
  ];
  const extra = (
    <TwoColumns>
      <DialogSection
        title="最長メッセージ"
        note={
          longest
            ? `${fmtDay(Date.parse(longest.date))} (${dowLabel(Date.parse(longest.date))})`
            : undefined
        }
      >
        <LongestMessageSection longest={longest} />
      </DialogSection>
      <DialogSection title="平日 vs 週末" note="文字数の合計">
        <SplitBar
          left={{ label: "平日", value: ww.weekday }}
          right={{ label: "週末", value: ww.weekend }}
          unit="字"
        />
        <div className="mt-3">
          <SplitBar
            left={{ label: "前半", value: halves.first }}
            right={{ label: "後半", value: halves.second }}
            unit="字"
          />
        </div>
      </DialogSection>
    </TwoColumns>
  );
  return { stats, extra };
}

/* --------------------------- 1日平均発言数 --------------------------- */

export function avgPerDayDialog(d: DialogData): DialogContent {
  const values = d.daily.map((p) => p.value);
  const maxI = values.indexOf(Math.max(...values));
  const minI = values.indexOf(Math.min(...values));
  const halves = splitHalves(d.daily);
  const stats: DialogStatItem[] = [
    { label: "中央値", value: jaNum.format(median(values)), sub: "件/日" },
    {
      label: "標準偏差",
      value: jaNum.format(round1(stddev(values))),
      sub: "日ごとのばらつき",
    },
    {
      label: "最多日",
      value: jaNum.format(values[maxI] ?? 0),
      sub: d.daily[maxI]
        ? `${fmtDay(d.daily[maxI].date)} (${dowLabel(d.daily[maxI].date)})`
        : undefined,
    },
    {
      label: "最少日",
      value: jaNum.format(values[minI] ?? 0),
      sub: d.daily[minI] ? fmtDay(d.daily[minI].date) : undefined,
    },
  ];
  const ww = weekdayWeekend(d.dowData);
  const extra = (
    <>
      <DialogSection title="週ごとの発言数" note="月曜始まりの週で集計">
        <CategoryBarChart data={weeklyBuckets(d.daily)} height={220} />
      </DialogSection>
      <TwoColumns>
        <DialogSection title="前半 vs 後半" note="期間の前半15日と後半の比較">
          <SplitBar
            left={{ label: "前半", value: halves.first }}
            right={{ label: "後半", value: halves.second }}
            unit="件"
          />
        </DialogSection>
        <DialogSection title="平日 vs 週末" note="1日あたりではなく合計の比較">
          <SplitBar
            left={{ label: "平日", value: ww.weekday }}
            right={{ label: "週末", value: ww.weekend }}
            unit="件"
          />
        </DialogSection>
      </TwoColumns>
    </>
  );
  return { stats, extra };
}

/* --------------------------- 平均文字数/発言 --------------------------- */

export function avgCharsDialog(d: DialogData): DialogContent {
  const series = avgCharsSeries(d);
  const values = series.map((p) => p.value);
  const maxI = values.indexOf(Math.max(...values));
  const longest = d.analysis?.longest_message ?? null;
  const stats: DialogStatItem[] = [
    {
      label: "期間の平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: "字/発言",
    },
    {
      label: "平均が最高の日",
      value: jaNum.format(values[maxI] ?? 0),
      sub: series[maxI]
        ? `${fmtDay(series[maxI].date)} (${dowLabel(series[maxI].date)})`
        : undefined,
    },
    {
      label: "最長メッセージ",
      value: longest ? jaNum.format(longest.chars) : "—",
      sub: longest ? `${longest.display_name} さん` : undefined,
    },
  ];
  const extra = longest ? (
    <DialogSection
      title="最長メッセージ"
      note={`${fmtDay(Date.parse(longest.date))} (${dowLabel(Date.parse(longest.date))})`}
    >
      <LongestMessageSection longest={longest} />
    </DialogSection>
  ) : null;
  return { stats, extra };
}

/** 最長メッセージのハイライトカード */
export function LongestMessageSection({ longest }: { longest: LongestMessage | null }) {
  if (!longest) {
    return <p className="py-6 text-center text-sm text-muted-foreground">データがありません</p>;
  }
  return (
    <div className="rounded-xl bg-muted/60 px-4 py-3">
      <p className="text-2xl font-black tracking-tight text-foreground tabular-nums">
        {jaNum.format(longest.chars)}
        <span className="ml-1 text-sm font-bold text-muted-foreground">字</span>
      </p>
      <p className="mt-0.5 text-xs font-bold text-muted-foreground">
        {longest.display_name} さんがこの日に投稿
        {longest.channel_name ? ` (${longest.channel_name})` : ""}
      </p>
    </div>
  );
}

/* ------------------------------ ピーク時間帯 ------------------------------ */

export function peakHourDialog(d: DialogData): DialogContent {
  const hourValues = d.hourData.map((h) => h.value);
  const top3 = topShare(hourValues, 3);
  const totals = timeOfDaySplit(d.matrix);
  const peakSlot = (() => {
    let best = { dow: -1, hour: -1, count: 0 };
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        const v = d.matrix[dow]?.[hour] ?? 0;
        if (v > best.count) best = { dow, hour, count: v };
      }
    }
    return best;
  })();
  const stats: DialogStatItem[] = [
    {
      label: "トップ3占有率",
      value: pct(top3),
      sub: "上位3時間帯で全体の何%か",
    },
    peakSlot.dow >= 0
      ? {
          label: "ピークスロット",
          value: `${["日", "月", "火", "水", "木", "金", "土"][peakSlot.dow]} ${peakSlot.hour}:00`,
          sub: `${jaNum.format(peakSlot.count)}件`,
        }
      : { label: "ピークスロット", value: "—" },
  ];
  const extra = (
    <>
      <DialogSection title="時間帯の比率" note="0-6時 / 6-12時 / 12-18時 / 18-24時">
        <RatioDonut items={totals} unit="件" />
      </DialogSection>
      <DialogSection title="曜日別の発言数" note="時間帯との組み合わせで見る" className="mt-5">
        <CategoryBarChart data={d.dowData} height={220} />
      </DialogSection>
    </>
  );
  return { stats, extra };
}

/* --------------------------- 発言のあった日数 --------------------------- */

export function activeDaysDialog(d: DialogData): DialogContent {
  const activeDays = d.daily.filter((p) => p.value > 0).length;
  const span =
    d.daysInPeriod ??
    (d.daily.length > 0
      ? Math.round(
          (Math.max(...d.daily.map((p) => p.date)) - Math.min(...d.daily.map((p) => p.date))) /
            86400000,
        ) + 1
      : 0);
  const streak = streakDays(d.daily);
  const rate = span > 0 ? activeDays / span : null;
  const stats: DialogStatItem[] = [
    { label: "欠損日数", value: `${Math.max(0, span - activeDays)}日`, sub: `期間は${span}日` },
    { label: "活動率", value: pct(rate), sub: `${span}日中${activeDays}日` },
    {
      label: "連続活動日数",
      value: `${streak}日`,
      sub: "毎日発言があった最長記録",
    },
  ];
  const extra = (
    <DialogSection title="活動カレンダー" note="発言があった日を日めくりで表示">
      <ActivityCalendar daily={d.daily} />
    </DialogSection>
  );
  return { stats, extra };
}

/* ------------------------------ 発言王 / ランク系 ------------------------------ */

export function topMembersDialog(
  d: DialogData,
  opts: { items: { name: string; count: number }[]; total: number; unit?: string },
): DialogContent {
  const values = opts.items.map((i) => i.count);
  const first = opts.items[0];
  const leaderDays = new Map<string, number>();
  for (const leader of d.analysis?.leaders ?? []) {
    leaderDays.set(leader.display_name, (leaderDays.get(leader.display_name) ?? 0) + 1);
  }
  const leaderData = [...leaderDays.entries()]
    .map(([name, days]) => ({ label: name, value: days }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const stats: DialogStatItem[] = [
    first
      ? {
          label: "1位",
          value: jaNum.format(first.count),
          sub: `${first.name} (${unitShareLabel(first.count, opts.total)})`,
        }
      : { label: "1位", value: "—" },
    {
      label: "1位のシェア",
      value: pct(opts.total > 0 && first ? first.count / opts.total : null),
    },
    { label: "トップ10合計", value: pct(topShare(values, 10, opts.total)) },
    {
      label: "1人あたり平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: opts.unit ?? "件",
    },
  ];
  const extra =
    leaderData.length > 0 ? (
      <DialogSection
        title="日別1位の獲得回数"
        note="その日いちばん発言したメンバーを誰が何日獲得したか"
      >
        <CategoryBarChart data={leaderData} height={220} />
      </DialogSection>
    ) : null;
  return { stats, extra };
}

function unitShareLabel(count: number, total: number): string {
  return total > 0 ? `全体の${Math.round((count / total) * 1000) / 10}%` : "";
}

/* ------------------------------ 最多発言日 ------------------------------ */

export function topDaysDialog(
  d: DialogData,
  opts: { topDates: { date: string; count: number }[]; total: number },
): DialogContent {
  const first = opts.topDates[0];
  const datesTotal = opts.topDates.reduce((s, t) => s + t.count, 0);
  const rows = opts.topDates.map((entry, i) => {
    const dateMs = Date.parse(entry.date);
    const users = usersOn(d, dateMs);
    return {
      id: entry.date,
      date: entry.date.replaceAll("-", "/"),
      dow: dowLabel(dateMs),
      count: entry.count,
      users: users != null ? users : null,
      share: opts.total > 0 ? `${Math.round((entry.count / opts.total) * 1000) / 10}%` : "—",
      rank: i + 1,
    };
  });
  const stats: DialogStatItem[] = [
    first
      ? {
          label: "最多日",
          value: jaNum.format(first.count),
          sub: `${first.date.replaceAll("-", "/")} (${dowLabel(Date.parse(first.date))})`,
        }
      : { label: "最多日", value: "—" },
    {
      label: "最多日のシェア",
      value: pct(first && opts.total > 0 ? first.count / opts.total : null),
    },
    {
      label: "トップ5合計",
      value: pct(opts.total > 0 ? datesTotal / opts.total : null),
      sub: `${jaNum.format(datesTotal)}件`,
    },
    {
      label: "最多日の人数",
      value: rows[0]?.users != null ? `${jaNum.format(rows[0].users)}人` : "—",
      sub: "その日に発言したメンバー",
    },
  ];
  const extra =
    rows.length > 0 ? (
      <DialogSection title="トップ5日の詳細" note="曜日・発言数・その日の発言メンバー数">
        <DataTable
          rows={rows}
          columns={[
            { key: "date", header: "日付", width: "1fr" },
            { key: "dow", header: "曜日", width: "60px" },
            {
              key: "count",
              header: "発言数",
              align: "right",
              width: "110px",
              cell: (row) => jaNum.format(row.count),
            },
            {
              key: "users",
              header: "メンバー数",
              align: "right",
              width: "110px",
              cell: (row) => (row.users != null ? `${jaNum.format(row.users)}人` : "—"),
            },
            { key: "share", header: "シェア", align: "right", width: "80px" },
          ]}
          pageSize={5}
          ariaLabel="最多発言日の詳細"
        />
      </DialogSection>
    ) : null;
  return { stats, extra };
}

/* ------------------------------ チャンネルランク ------------------------------ */

export function rankDialog(
  d: DialogData,
  opts: { rank: number | null; category?: string },
): DialogContent {
  const stats: DialogStatItem[] = [
    { label: "順位", value: opts.rank ? `${opts.rank}位` : "—" },
    { label: "カテゴリ", value: opts.category ?? "—" },
  ];
  return { stats, extra: null };
}

/* ------------------------------ 日別推移 (単体カード) ------------------------------ */

export function trendDialog(d: DialogData): DialogContent {
  const values = d.daily.map((p) => p.value);
  const stats: DialogStatItem[] = [
    {
      label: "1日平均",
      value: jaNum.format(round1(sum(values) / Math.max(1, values.length))),
      sub: "件",
    },
    { label: "中央値", value: jaNum.format(median(values)), sub: "件/日" },
    {
      label: "連続活動日数",
      value: `${streakDays(d.daily)}日`,
      sub: "最長記録",
    },
  ];
  const weekly = weeklyBuckets(d.daily);
  const extra =
    weekly.length > 1 ? (
      <DialogSection title="週ごとの発言数" note="月曜始まりの週で集計">
        <CategoryBarChart data={weekly} height={220} />
      </DialogSection>
    ) : null;
  return { stats, extra };
}

/* ------------------------------ 曜日別 / 時間帯別 ------------------------------ */

export function dowDialog(d: DialogData): DialogContent {
  const ww = weekdayWeekend(d.dowData);
  const stats: DialogStatItem[] = [
    ...categoryStats(d.dowData, (n) => jaNum.format(n), {
      total: "総発言数",
      avg: "平均/曜日",
      max: "最多曜日",
      min: "最少曜日",
      unit: "件",
    }),
  ];
  const extra = (
    <DialogSection title="平日 vs 週末" note="月-金と土日の合計">
      <SplitBar
        left={{ label: "平日", value: ww.weekday }}
        right={{ label: "週末", value: ww.weekend }}
        unit="件"
      />
    </DialogSection>
  );
  return { stats, extra };
}

export function hourDialog(d: DialogData): DialogContent {
  const stats: DialogStatItem[] = categoryStats(d.hourData, (n) => jaNum.format(n), {
    total: "総発言数",
    avg: "平均/時間帯",
    max: "最多時間帯",
    min: "最少時間帯",
    unit: "件",
  });
  const extra = (
    <DialogSection title="時間帯の比率" note="0-6時 / 6-12時 / 12-18時 / 18-24時">
      <RatioDonut items={timeOfDaySplit(d.matrix)} unit="件" />
    </DialogSection>
  );
  return { stats, extra };
}

/* ------------------------------ チャンネル別シェア ------------------------------ */

export function channelShareDialog(d: DialogData): DialogContent {
  const channels = d.channels ?? [];
  const total = sum(channels.map((c) => c.value));
  const stats: DialogStatItem[] = [
    { label: "総発言数", value: jaNum.format(total), sub: "件" },
    { label: "対象チャンネル", value: `${channels.length}個` },
    {
      label: "トップ1シェア",
      value: pct(channels[0] && total > 0 ? channels[0].value / total : null),
      sub: channels[0] ? `#${channels[0].name}` : undefined,
    },
    {
      label: "トップ3合計",
      value: pct(total > 0 ? sum(channels.slice(0, 3).map((c) => c.value)) / total : null),
    },
  ];
  return { stats, extra: null };
}

/* ------------------------------ ヒートマップ ------------------------------ */

export function heatmapDialog(d: DialogData): { stats: DialogStatItem[]; extra: ReactNode } {
  const total = d.matrix.flat().reduce((s, v) => s + v, 0);
  const ww = weekdayWeekend(d.dowData);
  const maxDow = d.dowData.reduce(
    (best, cur) => (cur.value > best.value ? cur : best),
    d.dowData[0] ?? { label: "-", value: 0 },
  );
  const maxHour = d.hourData.reduce(
    (best, cur) => (cur.value > best.value ? cur : best),
    d.hourData[0] ?? { label: "-", value: 0 },
  );
  let peak = { dow: -1, hour: -1, count: 0 };
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const v = d.matrix[dow]?.[hour] ?? 0;
      if (v > peak.count) peak = { dow, hour, count: v };
    }
  }
  const stats: DialogStatItem[] = [
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
          value: `${["日", "月", "火", "水", "木", "金", "土"][peak.dow]} ${peak.hour}:00`,
          sub: `${jaNum.format(peak.count)}件`,
        }
      : { label: "ピークスロット", value: "—" },
  ];
  const extra = (
    <>
      <DialogSection title="平日 vs 週末" note="曜日別合計の比較">
        <SplitBar
          left={{ label: "平日", value: ww.weekday }}
          right={{ label: "週末", value: ww.weekend }}
          unit="件"
        />
      </DialogSection>
      <DialogSection
        title="時間帯の比率"
        note="0-6時 / 6-12時 / 12-18時 / 18-24時"
        className="mt-5"
      >
        <RatioDonut items={timeOfDaySplit(d.matrix)} unit="件" />
      </DialogSection>
      <TwoColumns>
        <DialogSection title="曜日別の発言数" className="mt-5">
          <CategoryBarChart data={d.dowData} height={220} />
        </DialogSection>
        <DialogSection title="時間帯別の発言数" className="mt-5">
          <CategoryBarChart data={d.hourData} height={220} />
        </DialogSection>
      </TwoColumns>
    </>
  );
  return { stats, extra };
}

export { DialogStats };
