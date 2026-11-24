"use client";

import { useEffect, useMemo, useState } from "react";
import StatusPage from "@/components/shell/StatusPage";
import { CategoryBarChart } from "@/components/views/charts";
import { fetchAPI } from "@/lib/api";
import { lastActiveMonth, monthlyFromDaily } from "@/lib/insights-monthly";

interface TotalInsights {
  user: { display_name: string } | null;
  messages: number;
  daily: Array<{ date: string; count: number }>;
  last_at: string | null;
}

/** 選択月に発言がないメンバーの204ページ。全期間insightsから最終発言月と月別グラフを出す */
export default function MemberNoContent({ userId }: { userId: string }) {
  const [total, setTotal] = useState<TotalInsights | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAPI(`/users/${userId}/insights/total`, { retries: 1, quiet: true })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as TotalInsights;
        if (!cancelled) setTotal(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const monthly = useMemo(() => monthlyFromDaily(total?.daily ?? []), [total]);
  const lastActive = useMemo(() => lastActiveMonth(total?.daily ?? []), [total]);

  const name = total?.user?.display_name ?? null;
  const everSpoke = (total?.messages ?? 0) > 0;
  const message = !everSpoke
    ? `${name ? `@${name} ` : ""}はこのサーバーで一度も発言していないようです... (´・ω・\`)`
    : `@${name ?? "このメンバー"} はこの期間に発言していないようです... (´・ω・\`)`;

  return (
    <StatusPage
      code={204}
      title="No Content"
      message={message}
      inline
      showChip={false}
      extra={
        total === null && !failed ? (
          <div className="flex flex-col items-center gap-3">
            <div className="skeleton h-4 w-32 rounded-md" />
            <div className="skeleton h-24 w-64 rounded-xl" />
          </div>
        ) : everSpoke ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs font-bold text-muted-foreground">
              最終発言月: {lastActive ? lastActive.label : "—"}
            </p>
            {monthly.length > 0 && (
              <div className="w-full">
                <p className="mb-2 text-center text-xs font-black text-foreground">発言月グラフ</p>
                <CategoryBarChart data={monthly} height={160} />
              </div>
            )}
          </div>
        ) : null
      }
      actions={
        lastActive
          ? [
              {
                label: `${lastActive.label} に移動`,
                href: `/members/${userId}?m=${lastActive.key}`,
              },
            ]
          : undefined
      }
    />
  );
}
