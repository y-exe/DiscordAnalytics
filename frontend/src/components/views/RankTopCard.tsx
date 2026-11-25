"use client";

import { useEffect, useState } from "react";
import {
  NameplateText,
  ServerTagChip,
  UserAvatar,
  nameplateBackgroundStyle,
  type DiscordIdentity,
} from "./discord/DiscordIdentity";

export function Avatar({
  src,
  fallbackSrc,
  alt = "",
  className = "",
}: {
  src?: string | null;
  /** srcが読めない場合 (退出してギルド用アイコンが消滅等) の代替URL。
   * 通常はユーザーIDから引けるメインのプロフィールアバターを指定する */
  fallbackSrc?: string | null;
  alt?: string;
  className?: string;
}) {
  const [stage, setStage] = useState<"src" | "fallback" | "none">("src");

  // src / fallbackSrcが変わったらフォールバック状態をリセットする
  useEffect(() => {
    setStage("src");
  }, [src, fallbackSrc]);

  // 最後の手段のデフォルトアバターは出さない (仮ロゴより無い方が良いので
  // 全ソースが揃わない場合は画像ごと省略する)
  if (stage === "none") return null;
  const resolvedSrc = stage === "fallback" ? (fallbackSrc ?? null) : (src ?? fallbackSrc ?? null);
  if (!resolvedSrc) return null;
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      onError={() => {
        // src → fallback と一段ずつ進める。両方揃わなければ画像を省略する
        setStage((prev) => (prev === "src" && fallbackSrc ? "fallback" : "none"));
      }}
      className={`shrink-0 rounded-full object-cover ${className}`}
    />
  );
}

/** 1〜3位のシンプルなメダル (金・銀・銅のフラットな円 + 番号) */
const MEDAL_STYLES = [
  { base: "#E6B94E", text: "#7A5410" },
  { base: "#C6CCD4", text: "#525A66" },
  { base: "#D19A66", text: "#6B4520" },
] as const;

function RankMedal({ rank }: { rank: 1 | 2 | 3 }) {
  const c = MEDAL_STYLES[rank - 1];
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" role="img" aria-label={`${rank}位`}>
      <circle cx="12" cy="12" r="10" fill={c.base} />
      <text
        x="12"
        y="12.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="11"
        fontWeight="800"
        fill={c.text}
      >
        {rank}
      </text>
    </svg>
  );
}

export interface RankEntry extends DiscordIdentity {
  user_id: string;
  display_name: string;
  count: number;
}

export default function RankTopCard({
  title,
  note,
  unit = "回",
  items,
  max = 5,
  hrefBase,
  hrefQuery,
  emptyText = "データがありません",
  bare = false,
  loading = false,
}: {
  title: string;
  note?: string;
  unit?: string;
  items: RankEntry[];
  max?: number;
  /** 指定時は各行がこのパス (ユーザーIDを連結) へのリンクになる */
  hrefBase?: string;
  /** リンクに付けるクエリ (例: "m=2026-5")。期間を維持するために渡す */
  hrefQuery?: string;
  emptyText?: string;
  /** trueでカード枠なし (拡大ダイアログ内用) */
  bare?: boolean;
  /** trueで行をスケルトン表示 (タイトル・注記はそのまま出す) */
  loading?: boolean;
}) {
  return (
    <div className={`${bare ? "" : "app-card-padded app-tile"} flex h-full min-w-0 flex-col`}>
      <div>
        <p className="text-sm font-black text-foreground">{title}</p>
        {note && <p className="mt-0.5 text-xs font-bold text-muted-foreground">{note}</p>}
      </div>
      {loading ? (
        <ol className="mt-3 flex-1 space-y-1" aria-hidden="true">
          {Array.from({ length: max }, (_, i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <div className="skeleton h-6 w-6 shrink-0 rounded-md" />
              <div className="skeleton h-8 flex-1 rounded-lg" />
              <div className="skeleton h-4 w-16 shrink-0 rounded-md" />
            </li>
          ))}
        </ol>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ol className="data-in mt-3 flex-1 space-y-1">
          {items.slice(0, max).map((item, index) => {
            const rank = index + 1;
            const badge =
              rank <= 3 ? (
                <RankMedal rank={rank as 1 | 2 | 3} />
              ) : (
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-black text-muted-foreground">
                  {rank}
                </span>
              );
            const body = (
              <>
                {badge}
                <span className="flex min-w-0 flex-1 overflow-hidden">
                  <span
                    style={nameplateBackgroundStyle(item.nameplate)}
                    className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1.5 py-0.5"
                  >
                    {/* 日付などユーザー以外のエントリー (avatar/decoration未指定) はアイコンなしで表示 */}
                    {(item.avatar !== undefined || item.avatar_decoration !== undefined) && (
                      <UserAvatar user={item} size={32} />
                    )}
                    <NameplateText name={item.display_name} className="flex-1 text-sm" />
                    <ServerTagChip tag={item.primary_guild_tag} badge={item.primary_guild_badge} />
                  </span>
                </span>
                <span className="shrink-0 text-sm font-black text-foreground">
                  {item.count.toLocaleString("ja-JP")}
                  <span className="ml-0.5 text-xs font-bold text-muted-foreground">{unit}</span>
                </span>
              </>
            );
            return hrefBase ? (
              <li key={item.user_id}>
                <a
                  href={`${hrefBase}${item.user_id}${hrefQuery ? `?${hrefQuery}` : ""}`}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-muted"
                >
                  {body}
                </a>
              </li>
            ) : (
              <li key={item.user_id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                {body}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
