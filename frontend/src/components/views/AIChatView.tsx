"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Database,
  Globe,
  KeyRound,
  Pencil,
  RefreshCw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { API_URL, fetchAPI } from "@/lib/api";
import { getLoggedInUser } from "@/components/shell/UserArea";
import { AIChatEvent, AIChatHttpError, streamAIChat } from "@/lib/aiChat";
import AiMarkdown, { type AiMentionUser } from "./AiMarkdown";

export interface AIChatGuild {
  iconUrl: string | null;
}

interface ToolRun {
  name: string;
  summary: string;
  /** ツールが取得した実際のデータ (展開表示用) */
  output?: string;
}

interface ChatMessageState {
  role: "user" | "assistant";
  content: string;
  /** userメッセージのai_messages.id (編集再送信に使う) */
  id?: number;
  toolRuns?: ToolRun[];
  streaming?: boolean;
  failed?: boolean;
}

interface ThreadSummary {
  id: string;
  title: string;
}

const SUGGESTIONS = [
  { title: "今月の発言ランキングを教えて", detail: "DBの実データから集計" },
  { title: "一番アクティブな時間帯はいつ？", detail: "時間帯別のヒートマップ分析" },
  { title: "最近伸びてる人・減ってる人を分析して", detail: "メンバーごとの推移" },
  { title: "チャンネルごとの活動量を比較して", detail: "カテゴリ別の分布" },
];

function ToolIcon({ name, className }: { name: string; className?: string }) {
  if (name === "db_query") return <Database className={className} aria-hidden="true" />;
  if (name === "web_search") return <Globe className={className} aria-hidden="true" />;
  return <Terminal className={className} aria-hidden="true" />;
}

/** 三点のバウンスタイピング表示 */
function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-end gap-1 ${className}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70"
          style={{ animationDelay: `${i * 160}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

/** ツール実行の縦一列アコーディオン。開くと実際に取得したデータを表示する */
function ToolList({ runs }: { runs: ToolRun[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {runs.map((run, i) => (
        <details key={i} className="group/tool min-w-0">
          <summary className="flex w-full cursor-pointer list-none items-center gap-1.5 rounded-xl bg-muted/50 px-3 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
            <ToolIcon name={run.name} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{run.summary}</span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 transition-transform group-open/tool:rotate-180"
              aria-hidden="true"
            />
          </summary>
          {run.output && (
            <pre className="mt-1 max-h-72 overflow-auto rounded-xl bg-background px-3.5 py-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">
              {run.output}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

/** ヒーロー状態の入力カード */
function InputCard({
  input,
  setInput,
  onSend,
  busy,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-3xl border border-sidebar-border bg-card shadow-sm">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="何でもきいて…"
        rows={3}
        className="w-full resize-none rounded-t-3xl bg-transparent px-5 pt-4 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <div className="flex items-center justify-end gap-3 px-4 pb-3.5 pt-1">
        <button
          type="button"
          onClick={onSend}
          disabled={!input.trim() || busy}
          aria-label="送信"
          className="flex h-10 items-center gap-1.5 rounded-full bg-foreground px-5 text-sm font-black text-background transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          送る
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** 管理者ログインゲート (/admin/login)。AI_REQUIRE_ADMIN=trueのときのみ表示 */
function AdminGate({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchAPI("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "include",
        retries: 0,
      });
      if (res.ok) onLogin();
      else if (res.status === 429)
        setError("試行回数が多すぎます。しばらく待ってから再試行してください。");
      else setError("パスワードが違います。");
    } catch {
      setError("ログインに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-card-padded mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-muted">
        <KeyRound className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="text-base font-black text-foreground">AIは管理者ログイン中のみ利用できます</p>
      <p className="mt-1 text-sm text-muted-foreground">管理者パスワードでログインしてください。</p>
      <form onSubmit={handleLogin} className="mt-5 space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="管理者パスワード"
          autoComplete="current-password"
          className="h-10 w-full rounded-xl border border-input bg-background px-4 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        {error && <p className="text-xs font-bold text-delta-down">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="h-10 w-full rounded-xl bg-foreground text-sm font-black text-background transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "確認中..." : "ログイン"}
        </button>
      </form>
    </div>
  );
}

/** チャット下部の追加質問入力 */
function FollowUpInput({
  input,
  setInput,
  onSend,
  busy,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  /** 生成中は入力欄ごと非表示 (停止ボタンは別で出す) */
  busy: boolean;
}) {
  if (busy) return null;
  return (
    <div className="ai-dots flex items-end gap-2 rounded-3xl p-2 pl-5">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="追加の質問…"
        rows={1}
        className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={!input.trim()}
        aria-label="送信"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-30"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4.5 w-4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** 汎用確認ポップアップ (削除・ホームに戻るなど) */
function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-xs rounded-2xl border border-border bg-canvas p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <p className="text-base font-black text-foreground">{title}</p>
        {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-muted px-3 py-2 text-sm font-bold text-foreground transition-colors hover:bg-muted/80"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              destructive
                ? "flex-1 rounded-xl bg-destructive px-3 py-2 text-sm font-black text-destructive-foreground transition-opacity hover:opacity-90"
                : "flex-1 rounded-xl bg-foreground px-3 py-2 text-sm font-black text-background transition-opacity hover:opacity-90"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AIChatView({ guildIcon = null }: { guildIcon?: string | null }) {
  const [phase, setPhase] = useState<"checking" | "gate" | "unavailable" | "ready">("checking");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessageState[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // 再生成は直前の会話を削り直すため確認する
  const [regenTarget, setRegenTarget] = useState<{
    text: string;
    editOf?: number;
    replaceFrom: number;
  } | null>(null);
  // 一番下までスクロールしているか (外れているときは↓ボタンを出す)
  const [isNearBottom, setIsNearBottom] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef<HTMLDivElement>(null);
  // ストリーミング差分のフラッシュ (React再描画を50ms間隔に間引いて滑らかに表示)
  const pendingText = useRef("");
  const flushTimer = useRef<number | null>(null);

  const flushDelta = useCallback(() => {
    const text = pendingText.current;
    if (!text) return;
    pendingText.current = "";
    setMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.role === "assistant" ? { ...m, content: m.content + text } : m,
      ),
    );
  }, []);

  const startFlush = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setInterval(flushDelta, 50);
  }, [flushDelta]);

  const stopFlush = useCallback(() => {
    if (flushTimer.current !== null) {
      clearInterval(flushTimer.current);
      flushTimer.current = null;
    }
    flushDelta();
  }, [flushDelta]);

  // ヒーローの呼びかけ名 (ログイン中ユーザーの表示名)
  const [userName, setUserName] = useState("");
  useEffect(() => {
    setUserName(getLoggedInUser()?.name ?? "");
  }, []);

  // AI応答内のメンション (<@id>) のプロフィールを遅延取得してチップに使う
  const [mentionUsers, setMentionUsers] = useState<Record<string, AiMentionUser>>({});
  const mentionTimer = useRef<number | null>(null);
  useEffect(() => {
    const missing = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const match of m.content.matchAll(/<@(\d{1,20})>/g)) {
        if (!mentionUsers[match[1]]) missing.add(match[1]);
      }
    }
    if (missing.size === 0) return;
    // ストリーミング中にIDが断片的に出るため、少し待ってから一括取得する
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/ai/mentions?ids=${[...missing].join(",")}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { users: AiMentionUser[] };
        setMentionUsers((prev) => ({
          ...prev,
          ...Object.fromEntries(body.users.map((u) => [u.user_id, u])),
        }));
      } catch {
        // 取得失敗時はチップがIDフォールバック表示になる
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [messages, mentionUsers]);

  const loadThreads = useCallback(async (): Promise<boolean> => {
    try {
      // 503 (AI無効) 等も状態判定に使うためfetchAPI (非okでthrow) ではなく素のfetchを使う
      const res = await fetch(`${API_URL}/ai/threads`, { credentials: "include" });
      if (res.ok) {
        const body = (await res.json()) as { threads: ThreadSummary[] };
        setThreads(body.threads ?? []);
        setPhase("ready");
        return true;
      }
      if (res.status === 403) setPhase("gate");
      else if (res.status === 503) setPhase("unavailable");
      else setPhase("gate");
    } catch {
      setPhase("gate");
    }
    return false;
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // ストリーミング中・メッセージ追加時に最下部 (入力欄まで) へ追従
  useEffect(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 下部から外れたら↓ボタンを出す
  useEffect(() => {
    const onScroll = () => {
      // 追加質問の入力欄が画面下に入っているかで判定する
      const inputEl = followUpRef.current;
      if (!inputEl) return;
      const rect = inputEl.getBoundingClientRect();
      setIsNearBottom(rect.top < window.innerHeight - 96 && rect.bottom > 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const openThread = async (id: string) => {
    if (busy) return;
    try {
      const res = await fetchAPI(`/ai/threads/${id}`, { retries: 0, quiet: true });
      if (!res.ok) return;
      const body = (await res.json()) as {
        thread: ThreadSummary;
        messages: Array<{
          id: number;
          role: string;
          content: string;
          tool_runs: Array<{ name: string; summary: string; output?: string }> | null;
        }>;
      };
      setThreadId(body.thread.id);
      setThreadTitle(body.thread.title);
      setMessages(
        body.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          id: m.id,
          toolRuns: m.tool_runs ?? [],
        })),
      );
    } catch {
      // 読込失敗時は何もしない
    }
  };

  const newThread = () => {
    if (busy) return;
    setThreadId(null);
    setThreadTitle("");
    setMessages([]);
    setInput("");
    setEditingIdx(null);
  };

  const deleteThread = async (id: string) => {
    try {
      await fetchAPI(`/ai/threads/${id}`, { method: "DELETE", retries: 0, quiet: true });
    } catch {
      // 削除失敗は無視
    }
    if (threadId === id) newThread();
    void loadThreads();
  };

  const send = async (text: string, opts?: { editOf?: number; replaceFrom?: number }) => {
    if (!text || busy) return;
    setInput("");
    setEditingIdx(null);
    setMessages((prev) =>
      opts?.replaceFrom !== undefined ? prev.slice(0, opts.replaceFrom) : prev,
    );
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", toolRuns: [], streaming: true },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAIChat({
        message: text,
        threadId: threadId ?? undefined,
        editOf: opts?.editOf,
        signal: controller.signal,
        onEvent: handleEvent,
      });
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        if (err instanceof AIChatHttpError && err.status === 403) setPhase("gate");
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? {
                  ...m,
                  streaming: false,
                  failed: true,
                  content: m.content || (err as Error).message,
                }
              : m,
          ),
        );
      } else {
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      }
    } finally {
      stopFlush();
      setBusy(false);
      abortRef.current = null;
      void loadThreads();
    }

    function handleEvent(event: AIChatEvent) {
      if (event.type === "start") {
        setThreadId(String(event.threadId));
        setThreadTitle(String(event.title ?? ""));
        const userMessageId = Number(event.userMessageId ?? 0);
        if (userMessageId > 0) {
          setMessages((prev) => {
            const lastUser = [...prev].reverse().find((m) => m.role === "user");
            if (!lastUser) return prev;
            return prev.map((m) => (m === lastUser ? { ...m, id: userMessageId } : m));
          });
        }
      } else if (event.type === "delta") {
        if (!event.text) return;
        pendingText.current += event.text;
        startFlush();
      } else if (event.type === "tool") {
        const run = {
          name: event.name,
          summary: event.summary ?? "",
          output: event.output,
        };
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? { ...m, toolRuns: [...(m.toolRuns ?? []), run] }
              : m,
          ),
        );
      } else if (event.type === "done") {
        stopFlush();
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      } else if (event.type === "error") {
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? {
                  ...m,
                  streaming: false,
                  failed: true,
                  content: m.content || String(event.message ?? "エラー"),
                }
              : m,
          ),
        );
      }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  /** アシスタント回答の再生成 (直前のユーザーメッセージを送り直す。確認後に実行) */
  const regenerate = (assistantIdx: number) => {
    if (busy) return;
    let userIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMessage = messages[userIdx];
    setRegenTarget({
      text: userMessage.content,
      editOf: userMessage.id,
      replaceFrom: userIdx,
    });
  };

  const copyMessage = async (index: number) => {
    try {
      await navigator.clipboard.writeText(messages[index].content);
      setCopiedIdx(index);
      setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1500);
    } catch {
      // コピー失敗は無視
    }
  };

  if (phase === "checking") {
    return <div className="h-64 animate-pulse rounded-2xl bg-muted" />;
  }

  if (phase === "gate") {
    return <AdminGate onLogin={() => void loadThreads()} />;
  }

  if (phase === "unavailable") {
    return (
      <div className="app-card-padded mx-auto max-w-md text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-muted">
          <Sparkles className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-base font-black text-foreground">AI機能は現在有効ではありません</p>
        <p className="mt-1 text-sm text-muted-foreground">
          サーバーに DEEPSEEK_API_KEY が設定されていません。
        </p>
      </div>
    );
  }

  const isEmpty = messages.length === 0 && !threadId;
  const subText = userName
    ? `${userName}さんはいつよくしゃべってるの?! / 昼間ばっか喋ってる社不は?!`
    : "いつよくしゃべってるの?! / 昼間ばっか喋ってる社不は?!";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      {/* チャット中の上部バー: ← (AIホームに戻る) / タイトル / 削除 */}
      {!isEmpty && (
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={newThread}
            aria-label="AIホームに戻る"
            title="AIホームに戻る"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-text-strong"
          >
            <ArrowLeft className="h-4.5 w-4.5" />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-black text-foreground">
            {threadTitle || "チャット"}
          </p>
          {threadId && (
            <button
              type="button"
              onClick={() => setDeleteConfirmOpen(true)}
              aria-label="このチャットを削除"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-delta-down"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* メッセージ列 or ヒーロー */}
      {isEmpty ? (
        <div className="pt-10 md:pt-16">
          <div className="mb-8 flex flex-col items-center text-center">
            {guildIcon ? (
              <img
                src={guildIcon}
                alt=""
                className="h-16 w-16 rounded-2xl object-cover shadow-md"
              />
            ) : (
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-muted shadow-md">
                <Sparkles className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              </div>
            )}
            <h1
              className="mt-4 text-4xl font-black tracking-tight text-foreground"
              style={{ fontFamily: "'Google Sans', 'Outfit', Arial, sans-serif" }}
            >
              AIになんでも聞いてみよう
            </h1>
            <p className="mt-1 text-sm font-bold text-muted-foreground">{subText}</p>
          </div>

          <InputCard
            input={input}
            setInput={setInput}
            onSend={() => void send(input.trim())}
            busy={busy}
          />

          {/* 質問例 */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {SUGGESTIONS.map(({ title, detail }) => (
              <button
                key={title}
                type="button"
                onClick={() => setInput(title)}
                className="app-card app-tile px-4 py-3 text-left"
              >
                <span className="block text-sm font-black text-foreground">{title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
              </button>
            ))}
          </div>

          {/* 最近のチャット */}
          {threads.length > 0 && (
            <div className="mt-8">
              <p className="mb-2 px-1 text-xs font-black text-muted-foreground">最近のチャット</p>
              <div className="flex flex-wrap gap-2">
                {threads.slice(0, 8).map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => void openThread(thread.id)}
                    className="max-w-xs truncate rounded-full bg-muted px-3.5 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:text-sidebar-text-strong"
                    title={thread.title}
                  >
                    {thread.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-6 pb-4">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div key={index} className="group flex flex-col items-end gap-1">
                  {editingIdx === index ? (
                    <div className="w-full max-w-[85%] rounded-3xl bg-card p-3 shadow-sm">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (editDraft.trim())
                              void send(editDraft.trim(), {
                                editOf: message.id,
                                replaceFrom: index,
                              });
                          }
                        }}
                        rows={3}
                        autoFocus
                        className="w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none"
                      />
                      <div className="mt-1 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingIdx(null)}
                          className="flex h-8 items-center rounded-full px-3 text-xs font-black text-muted-foreground transition-colors hover:bg-muted"
                        >
                          キャンセル
                        </button>
                        <button
                          type="button"
                          disabled={!editDraft.trim() || busy}
                          onClick={() =>
                            void send(editDraft.trim(), { editOf: message.id, replaceFrom: index })
                          }
                          className="flex h-8 items-center rounded-full bg-foreground px-4 text-xs font-black text-background transition-opacity hover:opacity-90 disabled:opacity-30"
                        >
                          送り直す
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex max-w-[85%] items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (busy) return;
                          setEditingIdx(index);
                          setEditDraft(message.content);
                        }}
                        aria-label="編集して再送信"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <div className="rounded-3xl rounded-br-lg bg-foreground/85 px-4 py-2.5 text-sm leading-relaxed text-background">
                        {message.content}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div key={index} className="group flex flex-col gap-2">
                  {/* 回答ヘッダー: サーバーアイコン (角丸四角) + ラベル */}
                  <div className="flex items-center gap-2.5">
                    {guildIcon ? (
                      <img src={guildIcon} alt="" className="h-8 w-8 rounded-[10px] object-cover" />
                    ) : (
                      <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-muted">
                        <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      </span>
                    )}
                    <p className="text-sm font-bold text-muted-foreground">
                      {message.streaming ? "回答中…" : "回答しました"}
                    </p>
                  </div>
                  {(message.toolRuns?.length ?? 0) > 0 && <ToolList runs={message.toolRuns!} />}
                  <div
                    className={`ai-dots min-w-0 rounded-2xl px-5 py-4 ${
                      message.failed ? "bg-destructive/10" : ""
                    }`}
                  >
                    {message.content ? (
                      <AiMarkdown text={message.content} mentions={mentionUsers} />
                    ) : message.streaming ? (
                      <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
                        <TypingDots />
                        考えています…
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">応答がありませんでした。</p>
                    )}
                    {message.streaming && message.content && (
                      <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-foreground align-middle" />
                    )}
                  </div>
                  {/* アクション: コピー / 再生成 */}
                  {!message.streaming && message.content && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void copyMessage(index)}
                        aria-label="コピー"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {copiedIdx === index ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => regenerate(index)}
                        disabled={busy}
                        aria-label="再生成"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>

          {/* 最後の回答カードと入力欄を中央の線で結ぶ */}
          {busy ? (
            <>
              {/* 生成中は入力欄の代わりに↓ボタンの位置に停止ボタンを出す */}
              <div className="h-8" aria-hidden="true" />
              <button
                type="button"
                onClick={stop}
                aria-label="生成を停止"
                className="fixed bottom-8 left-1/2 z-20 flex h-10 -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-black text-background shadow-lg transition-opacity hover:opacity-90 md:left-[calc(50%+9rem)]"
              >
                <Square className="h-3.5 w-3.5" fill="currentColor" />
                停止
              </button>
            </>
          ) : (
            <>
              <div className="mx-auto h-6 w-px shrink-0 bg-sidebar-border" aria-hidden="true" />
              {/* 追加質問入力 (生成完了後のみ表示。フローの一番下に置く) */}
              <div ref={followUpRef} className="pb-4">
                <FollowUpInput
                  input={input}
                  setInput={setInput}
                  onSend={() => void send(input.trim())}
                  busy={busy}
                />
              </div>
            </>
          )}

          {/* 一番下から外れているときの↓ボタン (押すと入力欄までスクロール) */}
          {!isNearBottom && !busy && (
            <button
              type="button"
              onClick={() =>
                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
              }
              aria-label="一番下へ移動"
              className="fixed bottom-8 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-opacity hover:opacity-90 md:left-[calc(50%+9rem)]"
            >
              <ArrowDown className="h-5 w-5" />
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="このチャットを削除しますか?"
        message="削除すると元に戻せません。"
        confirmLabel="削除"
        destructive
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          if (threadId) void deleteThread(threadId);
        }}
      />
      <ConfirmDialog
        open={regenTarget !== null}
        title="この回答を再生成しますか?"
        message="この質問より後ろのやり取りは削除されます。"
        confirmLabel="再生成"
        onClose={() => setRegenTarget(null)}
        onConfirm={() => {
          const target = regenTarget;
          setRegenTarget(null);
          if (target)
            void send(target.text, { editOf: target.editOf, replaceFrom: target.replaceFrom });
        }}
      />
    </div>
  );
}
