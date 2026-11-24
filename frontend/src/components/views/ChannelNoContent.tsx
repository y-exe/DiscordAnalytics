"use client";

import { useEffect, useMemo, useState } from "react";
import StatusPage from "@/components/shell/StatusPage";
import { CategoryBarChart } from "@/components/views/charts";
import { fetchAPI } from "@/lib/api";
import { lastActiveMonth, monthlyFromDaily } from "@/lib/insights-monthly";

interface ChannelTotalInsights {
  messages: number;
  daily: Array<{ date: string; count: number }>;
}

/** 選択月に発言がないチャンネルの204ページ。全期間insightsから最終発言月と月別グラフを出す */
export default function ChannelNoContent({
  channelId,
  channelName,
}: {
  channelId: string | null;
  channelName: string | null;
}) {
  const [total, setTotal] = useState<ChannelTotalInsights | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    fetchAPI(`/channels/${channelId}/insights/total`, { retries: 1, quiet: true })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as ChannelTotalInsights;
        if (!cancelled) setTotal(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const monthly = useMemo(() => monthlyFromDaily(total?.daily ?? []), [total]);
  const lastActive = useMemo(() => lastActiveMonth(total?.daily ?? []), [total]);

  const label = channelName ? `#${channelName}` : "このチャンネル";
  const everSpoke = (total?.messages ?? 0) > 0;
  const message = !everSpoke
    ? `${label} はこれまでに一度も発言されていないようです... (´・ω・\`)`
    : `${label} はこの期間に発言していないようです... (´・ω・\`)`;

  return (
    <StatusPage
      code={204}
      title="No Content"
      message={message}
      inline
      showChip={false}
      extra={
        !channelId || (total === null && !failed) ? null : everSpoke ? (
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
      actions={[
        { label: "ホームに戻る", href: "/" },
        ...(lastActive && channelId
          ? [
              {
                label: `${lastActive.label} に移動`,
                href: `/channels/${channelId}?m=${lastActive.key}`,
              },
            ]
          : []),
      ]}
    />
  );
}
