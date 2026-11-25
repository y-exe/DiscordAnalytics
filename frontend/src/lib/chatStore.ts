"use client";

import type { AiMentionUser } from "@/components/views/AiMarkdown";

/** ツール実行の記録 (UI表示用) */
export interface ToolRun {
  name: string;
  summary: string;
  /** ツールが取得した実際のデータ (展開表示用) */
  output?: string;
}

/**
 * AIチャットの会話履歴をlocalStorageに保存する (サーバーには保存しない)。
 * 同一ブラウザの本人しか見れない。ギルド単位で分離する。
 */

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  toolRuns?: ToolRun[];
}

export interface StoredThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

const MAX_THREADS = 30;
const MAX_MESSAGES = 100;

function storageKey(guildId: string): string {
  return `dwai-chat:${guildId || "default"}`;
}

export function listThreads(guildId: string): StoredThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(guildId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { threads?: StoredThread[] };
    const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
    return threads
      .filter((t) => t && typeof t.id === "string" && Array.isArray(t.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function getThread(guildId: string, id: string): StoredThread | null {
  return listThreads(guildId).find((t) => t.id === id) ?? null;
}

/** スレッドを保存 (新規 or 上書き)。容量超過時は古いスレッドを捨てる */
export function saveThread(guildId: string, thread: StoredThread): void {
  if (typeof window === "undefined") return;
  const cleaned: StoredThread = {
    ...thread,
    messages: thread.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_MESSAGES),
  };
  const threads = [cleaned, ...listThreads(guildId).filter((t) => t.id !== thread.id)];
  const trimmed = threads.slice(0, MAX_THREADS);
  try {
    window.localStorage.setItem(storageKey(guildId), JSON.stringify({ threads: trimmed }));
  } catch {
    // 容量超過 → 古い半分を捨てて一度だけ再試行
    try {
      window.localStorage.setItem(
        storageKey(guildId),
        JSON.stringify({ threads: trimmed.slice(0, Math.ceil(trimmed.length / 2)) }),
      );
    } catch {
      // それでも失敗したら諦める (履歴が消えるだけで動作には影響しない)
    }
  }
}

export function deleteThread(guildId: string, id: string): void {
  if (typeof window === "undefined") return;
  const threads = listThreads(guildId).filter((t) => t.id !== id);
  try {
    window.localStorage.setItem(storageKey(guildId), JSON.stringify({ threads }));
  } catch {
    // 失敗時は次回保存時に整理される
  }
}
