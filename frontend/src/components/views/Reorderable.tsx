"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MotionConfig, motion } from "framer-motion";
import { GripVertical } from "lucide-react";
import TileDialog from "./TileDialog";

export interface ReorderableItem {
  id: string;
  node: ReactNode;
  /** グリッドアイテムへの追加クラス (col-span等) */
  className?: string;
  /** 指定時はカードクリックでこの内容を拡大ダイアログに表示する */
  dialog?: ReactNode;
}

/**
 * カードを1枚ずつドラッグで並べ替えられるグリッド (Cloudflareダッシュボード風)。
 * 並び替え時はreact-grid-layoutのように他のカードが滑らかに流れる。
 * 並び順はlocalStorageに保存され、再訪時も維持される。
 * dialogを指定したカードはクリックで拡大ダイアログが開く。
 */
export default function Reorderable({
  storageKey,
  items,
  className = "grid grid-cols-1 grid-flow-dense gap-4 md:grid-cols-2 xl:grid-cols-4",
  resetToken = 0,
  replayKey = "",
}: {
  storageKey: string;
  items: ReorderableItem[];
  className?: string;
  /** 値を変えると保存済み並び順を破棄してデフォルト順に戻す */
  resetToken?: number;
  /** 値を変えるとカードを再マウントし、出現アニメーションを再生する (期間切替など) */
  replayKey?: string;
}) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // 初回マウント時の並び順復元ではアニメーションさせない (ドラッグ開始時から有効化)
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as string[];
        const ids = new Set(items.map((item) => item.id));
        const valid = saved.filter((id) => ids.has(id));
        const rest = items.map((item) => item.id).filter((id) => !valid.includes(id));
        setOrder([...valid, ...rest]);
        return;
      }
    } catch {
      // 破損した保存値は無視
    }
    setOrder(items.map((item) => item.id));
    // itemsのid構成は安定している前提
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // resetTokenが変化したら保存済み並び順を破棄してデフォルト順へ戻す
  const lastResetRef = useRef(resetToken);
  useEffect(() => {
    if (lastResetRef.current === resetToken) return;
    lastResetRef.current = resetToken;
    if (resetToken === 0) return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // 保存できない環境では無視
    }
    setOrder(items.map((item) => item.id));
    // itemsは最新のレンダーのものを使うため依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken, storageKey]);

  const ordered = useMemoOrder(items, order);

  const persist = (next: string[]) => {
    setOrder(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 保存できない環境では無視
    }
  };

  const handleDragOver = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const current = ordered.map((item) => item.id);
    const from = current.indexOf(draggingId);
    const to = current.indexOf(targetId);
    if (from === -1 || to === -1) return;
    current.splice(to, 0, ...current.splice(from, 1));
    persist(current);
  };

  const openItem = openId ? ordered.find((item) => item.id === openId) : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className={className}>
        {ordered.map((item, index) => (
          <motion.div
            key={replayKey ? `${item.id}:${replayKey}` : item.id}
            layout={animated}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              layout: { duration: 0.2, ease: "easeOut" },
              opacity: {
                duration: 0.3,
                delay: Math.min(index * 0.04, 0.4),
                ease: "easeOut",
              },
              y: {
                duration: 0.35,
                delay: Math.min(index * 0.04, 0.4),
                ease: [0.23, 1, 0.32, 1],
              },
            }}
            draggable
            onDragStart={(e) => {
              // framer-motionのハンドラ型だが、draggable属性のネイティブDnDイベントとして扱う
              const de = e as unknown as React.DragEvent<HTMLDivElement>;
              setDraggingId(item.id);
              setAnimated(true);
              de.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDraggingId(null)}
            onDragOver={(e) => {
              e.preventDefault();
              handleDragOver(item.id);
            }}
            onClick={(e) => {
              if (!item.dialog) return;
              if ((e.target as HTMLElement).closest("a,button")) return;
              setOpenId(item.id);
            }}
            onKeyDown={(e) => {
              if (!item.dialog) return;
              if ((e.target as HTMLElement).closest("a,button")) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpenId(item.id);
              }
            }}
            role={item.dialog ? "button" : undefined}
            tabIndex={item.dialog ? 0 : undefined}
            aria-haspopup={item.dialog ? "dialog" : undefined}
            className={`group/reorder relative h-full ${item.className ?? ""} ${item.dialog ? "cursor-pointer" : ""} ${draggingId === item.id ? "z-20 opacity-50" : ""}`}
          >
            <button
              type="button"
              aria-label="カードを移動"
              onClick={(e) => e.stopPropagation()}
              className="absolute right-1 top-1 z-10 hidden h-6 w-6 cursor-grab place-items-center rounded-md text-muted-foreground/50 hover:bg-muted hover:text-foreground group-hover/reorder:grid active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
            {item.node}
          </motion.div>
        ))}
      </div>
      {/* 常設 (openトグル): 条件付きマウントだとclose後の再openでshowModalが失敗するため */}
      <TileDialog open={openId !== null} onClose={() => setOpenId(null)}>
        {openItem?.dialog ?? null}
      </TileDialog>
    </MotionConfig>
  );
}

function useMemoOrder(items: ReorderableItem[], order: string[] | null): ReorderableItem[] {
  if (!order) return items;
  const map = new Map(items.map((item) => [item.id, item]));
  const result: ReorderableItem[] = [];
  for (const id of order) {
    const item = map.get(id);
    if (item) {
      result.push(item);
      map.delete(id);
    }
  }
  for (const item of map.values()) result.push(item);
  return result;
}
