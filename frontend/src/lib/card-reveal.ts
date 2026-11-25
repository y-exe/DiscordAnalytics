"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** データが同時に揃っても、カードが1枚ずつめくられて見えるようにする間隔 */
const REVEAL_INTERVAL_MS = 90;

/** 保存したカード順 (Reorderableと同じlocalStorage)。見つからないidは無視し、
 *  足りない分は既定順で補う */
export function savedCardOrder(storageKey: string, defaults: string[]): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(raw)) return defaults;
    const saved = raw.filter((x): x is string => typeof x === "string");
    return [...saved, ...defaults.filter((id) => !saved.includes(id))];
  } catch {
    return defaults;
  }
}

/**
 * データが揃ったカードを、到着順 (同着なら表示順) に1枚ずつめくる。
 * isReady は「そのカードのデータが揃った (または失敗済み) か」を返す。
 * reset は期間切替時などに呼んでめくり状態を初期化する。
 */
export function useSequentialReveal(
  order: string[],
  isReady: (id: string) => boolean,
): { ready: (id: string) => boolean; reset: () => void } {
  // 初回レンダリング (SSR含む) 時点でデータが揃っているカードは即表示とする。
  // SSR事前取得済みのKPI等がスケルトン→ハイドレート後の数字差し替えになるのを防ぐ。
  const [revealed, setRevealed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const id of order) {
      if (isReady(id)) initial[id] = true;
    }
    return initial;
  });
  const queueRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const id = queueRef.current.shift();
    if (id === undefined) {
      timerRef.current = null;
      return;
    }
    setRevealed((r) => ({ ...r, [id]: true }));
    if (queueRef.current.length > 0) {
      timerRef.current = setTimeout(flush, REVEAL_INTERVAL_MS);
    } else {
      timerRef.current = null;
    }
  }, []);

  // データが揃ったカードを表示順に沿ってキューに入れる (描画のたびに軽く点検)
  useEffect(() => {
    const newly = order.filter(
      (id) => isReady(id) && revealed[id] !== true && !queueRef.current.includes(id),
    );
    if (newly.length === 0) return;
    queueRef.current.push(...newly);
    if (timerRef.current === null) {
      timerRef.current = setTimeout(flush, REVEAL_INTERVAL_MS);
    }
  });

  // アンマウント時にタイマーを掃除
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const reset = useCallback(() => {
    queueRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRevealed({});
  }, []);

  return { ready: (id: string) => isReady(id) && revealed[id] === true, reset };
}
