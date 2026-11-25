"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * カードクリックで開く拡大ダイアログ (ネイティブ <dialog>)。
 * ESCキー・パネル外クリック・閉じるボタンで閉じられる。
 * 中身は開いた後にマウントする (非表示中のグラフ計測や無駄なレンダーを避ける)。
 */
export default function TileDialog({
  open,
  onClose,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** アクセシビリティ用のラベル (カードタイトル等) */
  label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [contentVisible, setContentVisible] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openRef = useRef(open);
  openRef.current = open;

  // DOMとopen propsを毎レンダーで同期する (depsなし)。
  // useEffect (passive) は背景タブ等で実行が遅延し、2回目以降のopenが
  // 反映されないことがあるため、コミットに必ず同期させる。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setContentVisible(true);
      // クリックdispatch中にshowModalすると、そのクリックがtop-layer
      // retargetingでダイアログ自身に届き、開いた直後に閉じ処理が走る。
      // そのためdispatch完了後 (マイクロタスク) まで開くのを遅らせる。
      queueMicrotask(() => {
        if (openRef.current && !el.open) el.showModal();
      });
    } else if (!open && el.open) {
      el.close();
    }
  });

  // ネイティブのcloseイベント (ESCキー等) を確実にReactの状態へ同期する。
  // closeイベントはバブリングしないため、ルート委譲されるReactのonCloseでは
  // 拾えないケースがあり、直接addEventListenerする。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => {
      setContentVisible(false);
      onCloseRef.current();
    };
    el.addEventListener("close", handleClose);
    return () => el.removeEventListener("close", handleClose);
  }, []);

  // パネル外クリックで閉じる。top-layer内ではReactのイベント委譲が
  // 発火しないため、ネイティブリスナーで直接処理する。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClick = (e: MouseEvent) => {
      if (e.target === el) onCloseRef.current();
    };
    el.addEventListener("click", handleClick);
    return () => el.removeEventListener("click", handleClick);
  }, []);

  return (
    <dialog ref={ref} aria-label={label ?? "カードの拡大表示"} className="tile-dialog">
      <div className="tile-panel custom-scrollbar relative max-h-[85dvh] w-full max-w-[780px] overflow-y-auto rounded-lg bg-canvas p-5 shadow-xl ring-1 ring-border">
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        {contentVisible ? children : null}
      </div>
    </dialog>
  );
}

/** クリックでダイアログを開くラッパー。内部のリンク・ボタンは除外する。 */
export function TileExpandable({
  dialog,
  label,
  className = "",
  children,
}: {
  dialog: ReactNode;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
      }}
      className={`h-full cursor-pointer ${className}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        setOpen(true);
      }}
    >
      {children}
      <TileDialog open={open} onClose={() => setOpen(false)} label={label}>
        {dialog}
      </TileDialog>
    </div>
  );
}
