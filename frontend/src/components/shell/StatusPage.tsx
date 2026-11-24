"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/** 指定した数字1文字のポップアート */
function Digit({ digit }: { digit: string }) {
  return (
    <span
      className="font-black leading-none text-foreground/80"
      style={{ fontSize: "clamp(4.5rem, 18vw, 6.5rem)" }}
    >
      {digit}
    </span>
  );
}

/**
 * エラー/データなしの統一デザインページ。ステータスコードのポップアート、
 * タイトル、パスチップ、メッセージ、戻る/アクションボタンを置く。
 * inline=true でダッシュボード内埋め込み (全画面背景を握らない)。
 */
export default function StatusPage({
  code,
  title,
  message,
  extra,
  actions,
  inline = false,
  showChip = true,
  chipPath,
}: {
  code: number | string;
  title: string;
  message?: ReactNode;
  /** メッセージとボタンの間に差し込む追加コンテンツ (グラフ等) */
  extra?: ReactNode;
  /** [<] 戻るボタンの後に並べるアクション */
  actions?: Array<{ label: string; href?: string; onClick?: () => void }>;
  /** チップに表示するパス。省略時は現在のpathname */
  chipPath?: string;
  inline?: boolean;
  showChip?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const digits = String(code).split("");

  const body = (
    <div
      className={`flex flex-col items-center justify-center gap-5 px-6 text-center ${
        inline ? "min-h-[70vh] py-16" : "min-h-dvh"
      }`}
    >
      <div aria-hidden="true" className="flex items-center gap-1.5 sm:gap-2">
        {digits.map((digit, i) => (
          <Digit key={i} digit={digit} />
        ))}
      </div>
      <p className="text-lg font-bold text-muted-foreground">{title}</p>
      {showChip && (chipPath ?? pathname) && (
        <p className="rounded-lg bg-muted px-3 py-1 font-mono text-xs font-bold text-muted-foreground">
          {chipPath ?? pathname}
        </p>
      )}
      {message && (
        <p className="max-w-md text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
          {message}
        </p>
      )}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="前のページに戻る"
          onClick={() => router.back()}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-border"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {(actions ?? []).map((action) =>
          action.href ? (
            <Link
              key={action.label}
              href={action.href}
              className="rounded-xl bg-muted px-4 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-border"
            >
              {action.label}
            </Link>
          ) : (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="rounded-xl bg-muted px-4 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-border"
            >
              {action.label}
            </button>
          ),
        )}
      </div>
      {extra && <div className="w-full max-w-md rounded-xl bg-muted p-4">{extra}</div>}
    </div>
  );

  if (inline) return body;
  return <main className="flex min-h-dvh items-center justify-center bg-background">{body}</main>;
}
