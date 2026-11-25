"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import PageToolbar from "@/components/shell/PageToolbar";
import { usePendingBar } from "@/components/shell/AppShell";
import PeriodPicker from "@/components/shell/PeriodPicker";
import {
  BoostBadge,
  NameplateText,
  ServerTagChip,
  UserAvatar,
  nameplateBackgroundStyle,
} from "./discord/DiscordIdentity";
import DeltaBadge, { deltaRate } from "./DeltaBadge";
import { Avatar } from "./RankTopCard";
import { fetchAPI } from "@/lib/api";
import { periodLabel } from "@/lib/period";

interface MemberStat {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  /** ギルド用アイコンが読めない (退出等) 場合の代替: メインのアバター */
  avatar_fallback?: string | null;
  banner: string | null;
  avatar_decoration: string | null;
  nameplate: { asset: string; palette: string } | null;
  primary_guild_tag: string | null;
  primary_guild_badge: string | null;
  joined_at: string | null;
  premium_since: string | null;
  messages: number;
  chars: number;
  rank: number | null;
  prev: { messages: number; chars: number } | null;
}

type SortKey = "messages" | "chars" | "name";

export default function MembersView({
  period,
}: {
  period: { key: string; year: number | null; month: number | null; isAll: boolean };
}) {
  const [data, setData] = useState<MemberStat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("messages");
  const [page, setPage] = useState(0);
  /** 1ページの表示件数 (10/25/50/100)。既定は10 */
  const [pageSize, setPageSize] = useState(10);

  // 読み込み中はシェル最上部の共通バーを出す
  usePendingBar(!data && !failed);

  const base = period.isAll
    ? "/users/members/total"
    : `/users/members/${period.year}/${period.month}`;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    setPage(0);
    fetchAPI(base, { retries: 1 })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as MemberStat[];
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const rows = data.filter(
      (row) =>
        !q || row.display_name.toLowerCase().includes(q) || row.username.toLowerCase().includes(q),
    );
    if (sort === "chars") rows.sort((a, b) => b.chars - a.chars);
    else if (sort === "name")
      rows.sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
    else rows.sort((a, b) => b.messages - a.messages);
    return rows;
  }, [data, query, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const title = period.isAll ? "全期間" : periodLabel(period);
  const reduce = useReducedMotion();
  const spring = reduce
    ? { duration: 0 }
    : ({ type: "spring", duration: 0.55, bounce: 0.04 } as const);

  return (
    <div>
      <PageToolbar
        title="メンバー"
        subtitle="メンバーがどんな発言をしているか確認しましょう"
        right={<PeriodPicker period={period} />}
      />

      <div className="app-card">
        <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-black text-foreground">メンバーごとのデータ一覧</p>
            <p className="mt-0.5 text-xs font-bold text-muted-foreground">
              {title}の発言数・文字数と前期間との比較。行クリックで詳細を開けます
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="メンバーを検索..."
                className="h-8 w-48 rounded-lg border border-input bg-muted pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-8 rounded-lg border border-input bg-card px-2 text-xs font-bold text-foreground"
              aria-label="並び順"
            >
              <option value="messages">発言数順</option>
              <option value="chars">文字数順</option>
              <option value="name">名前順</option>
            </select>
          </div>
        </div>

        {failed ? (
          <div>
            <p className="p-6 pb-2 text-center text-sm text-muted-foreground">
              データの読み込みに失敗しました。時間をおいて再読み込みしてください。
            </p>
            <div className="space-y-2 p-4 pt-2" aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skeleton h-9 rounded-lg" />
              ))}
            </div>
          </div>
        ) : !data ? (
          <div className="space-y-2 p-4" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="skeleton h-9 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="data-in">
            <div className="overflow-x-auto custom-scrollbar">
              <div
                className="relative min-w-[640px] text-sm"
                role="table"
                aria-label="メンバー一覧"
              >
                <div
                  role="row"
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)_9rem_9rem] border-b border-border px-4 text-left text-xs font-bold text-muted-foreground"
                >
                  <div role="columnheader" className="py-3">
                    #
                  </div>
                  <div role="columnheader" className="py-3">
                    メンバー名
                  </div>
                  <div role="columnheader" className="py-3">
                    発言数
                  </div>
                  <div role="columnheader" className="py-3">
                    文字数
                  </div>
                </div>
                {/* 検索・並び替えで行が絞り替わるときはeasyui風に流す */}
                <AnimatePresence initial={false} mode="popLayout">
                  {pageRows.map((row) => (
                    <motion.div
                      key={row.user_id}
                      role="row"
                      layout={reduce ? false : "position"}
                      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: { duration: 0.15 } }}
                      transition={spring}
                      className="grid grid-cols-[3.5rem_minmax(0,1fr)_9rem_9rem] items-center border-b border-border/60 px-4 transition-colors last:border-b-0 hover:bg-muted/50"
                    >
                      <div role="cell" className="py-2 text-xs font-black text-muted-foreground">
                        {row.rank ?? "—"}
                      </div>
                      <div role="cell" className="min-w-0 py-2">
                        <Link
                          href={`/members/${row.user_id}?m=${period.key}`}
                          style={nameplateBackgroundStyle(row.nameplate)}
                          className="inline-flex max-w-full items-center gap-2.5 rounded-xl px-2 py-1.5"
                        >
                          <Avatar
                            src={row.avatar}
                            fallbackSrc={row.avatar_fallback}
                            className="h-9 w-9"
                            alt=""
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <NameplateText name={row.display_name} className="max-w-40 text-sm" />
                              <ServerTagChip
                                tag={row.primary_guild_tag}
                                badge={row.primary_guild_badge}
                              />
                              {row.premium_since && <BoostBadge />}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              @{row.username}
                            </span>
                          </span>
                        </Link>
                      </div>
                      <div role="cell" className="min-w-0 py-2">
                        <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                          {row.messages.toLocaleString("ja-JP")}
                          {row.prev && (
                            <DeltaBadge delta={deltaRate(row.messages, row.prev.messages)} />
                          )}
                        </span>
                      </div>
                      <div role="cell" className="min-w-0 py-2">
                        <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                          {row.chars.toLocaleString("ja-JP")}
                          {row.prev && <DeltaBadge delta={deltaRate(row.chars, row.prev.chars)} />}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {pageRows.length === 0 && (
                  <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                    該当するメンバーがいません
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border p-3 text-xs font-bold text-muted-foreground">
              <span className="flex items-center gap-1.5">
                表示中
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(0);
                  }}
                  className="h-7 rounded-lg border border-input bg-card px-1.5 text-xs font-bold text-foreground"
                  aria-label="表示件数"
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                / {filtered.length.toLocaleString("ja-JP")} のメンバー
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  aria-label="前のページ"
                  className="grid h-7 w-7 place-items-center rounded-lg border border-border bg-card transition-colors hover:bg-muted disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="px-2">
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  aria-label="次のページ"
                  className="grid h-7 w-7 place-items-center rounded-lg border border-border bg-card transition-colors hover:bg-muted disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
