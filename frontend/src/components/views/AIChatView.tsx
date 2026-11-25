"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BarChart3,
  Clock,
  Database,
  Globe,
  Hash,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { API_URL, fetchAPI } from "@/lib/api";
import AiMarkdown from "./AiMarkdown";

interface ToolRun {
  name: string;
  summary: string;
}

interface ChatMessageState {
  role: "user" | "assistant";
  content: string;
  toolRuns?: ToolRun[];
  streaming?: boolean;
  failed?: boolean;
}

interface ThreadSummary {
  id: string;
  title: string;
}

const SUGGESTIONS = [
  { Icon: BarChart3, title: "今月の発言ランキングを教えて", detail: "DBの実データから集計" },
  { Icon: Clock, title: "一番アクティブな時間帯はいつ？", detail: "時間帯別のヒートマップ分析" },
  { Icon: TrendingUp, title: "最近伸びてる人・減ってる人を分析して", detail: "メンバーごとの推移" },
  { Icon: Hash, title: "チャンネルごとの活動量を比較して", detail: "カテゴリ別の分布" },
];

function ToolIcon({ name, className }: { name: string; className?: string }) {
  if (name === "db_query") return <Database className={className} aria-hidden="true" />;
  if (name === "web_search") return <Globe className={className} aria-hidden="true" />;
  return <Terminal className={className} aria-hidden="true" />;
}

function ToolChip({ run }: { run: ToolRun }) {
  return (
    <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-sidebar-border bg-muted/60 px-3 py-1 text-xs font-bold text-muted-foreground">
      <ToolIcon name={run.name} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{run.summary}</span>
    </div>
  );
}

/** nani.now風の入力カード (ヒーロー表示 / チャット中で共通) */
function InputCard({
  input,
  setInput,
  onSend,
  onStop,
  busy,
  compact,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  compact?: boolean;
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
        rows={compact ? 2 : 3}
        className="w-full resize-none rounded-t-3xl bg-transparent px-5 pt-4 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <div className="flex items-center justify-between gap-3 px-4 pb-3.5 pt-1">
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground/80">
          <Database className="h-3.5 w-3.5" aria-hidden="true" />
          DB参照
          <span className="text-muted-foreground/40">/</span>
          <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
          コマンド実行
          <span className="text-muted-foreground/40">/</span>
          <Globe className="h-3.5 w-3.5" aria-hidden="true" />
          Web検索
        </p>
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
          >
            <Square className="h-4 w-4" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!input.trim()}
            aria-label="送信"
            className="flex h-10 items-center gap-1.5 rounded-full bg-accent-data px-5 text-sm font-black text-white transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            送る
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** 管理者ログインゲート (/admin/login) */
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

export default function AIChatView() {
  const [phase, setPhase] = useState<"checking" | "gate" | "unavailable" | "ready">("checking");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessageState[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetchAPI("/ai/threads", { retries: 0, quiet: true });
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

  // ストリーミング中・メッセージ追加時に最下部へ追従
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const openThread = async (id: string) => {
    if (busy) return;
    try {
      const res = await fetchAPI(`/ai/threads/${id}`, { retries: 0, quiet: true });
      if (!res.ok) return;
      const body = (await res.json()) as {
        thread: ThreadSummary;
        messages: Array<{ role: string; content: string; tool_runs: ToolRun[] | null }>;
      };
      setThreadId(body.thread.id);
      setThreadTitle(body.thread.title);
      setMessages(
        body.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", toolRuns: [], streaming: true },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: threadId ?? undefined }),
        credentials: "include",
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (res.status === 403) {
          setPhase("gate");
        }
        const body = await res.json().catch(() => ({ detail: "" }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith("data:")) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }
          handleEvent(payload);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
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
      setBusy(false);
      abortRef.current = null;
      void loadThreads();
    }

    function handleEvent(payload: Record<string, unknown>) {
      const type = payload.type as string;
      if (type === "start") {
        setThreadId(String(payload.threadId));
        setThreadTitle(String(payload.title ?? ""));
      } else if (type === "delta") {
        const text = String(payload.text ?? "");
        if (!text) return;
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? { ...m, content: m.content + text }
              : m,
          ),
        );
      } else if (type === "tool") {
        const run = { name: String(payload.name), summary: String(payload.summary ?? "") };
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? { ...m, toolRuns: [...(m.toolRuns ?? []), run] }
              : m,
          ),
        );
      } else if (type === "done") {
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      } else if (type === "error") {
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? {
                  ...m,
                  streaming: false,
                  failed: true,
                  content: m.content || String(payload.message ?? "エラー"),
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      {/* チャット中の上部バー */}
      {!isEmpty && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-black text-foreground">
            {threadTitle || "チャット"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {threadId && (
              <button
                type="button"
                onClick={() => void deleteThread(threadId)}
                aria-label="このチャットを削除"
                className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-delta-down"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={newThread}
              className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-black text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-text-strong"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              新しいチャット
            </button>
          </div>
        </div>
      )}

      {/* メッセージ列 or ヒーロー */}
      {isEmpty ? (
        <div className="pt-10 md:pt-16">
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-accent-data to-[#7ea0ff] shadow-md">
              <Sparkles className="h-8 w-8 text-white" aria-hidden="true" />
            </div>
            <h1
              className="mt-4 text-4xl font-black tracking-tight text-foreground"
              style={{ fontFamily: "'Google Sans', 'Outfit', Arial, sans-serif" }}
            >
              AI
            </h1>
            <p className="mt-1 text-sm font-bold text-muted-foreground">
              サーバーのことを、なんでも聞いてみよう
            </p>
          </div>

          <InputCard
            input={input}
            setInput={setInput}
            onSend={() => void send()}
            onStop={stop}
            busy={busy}
          />

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AIがデータベースを調べて、実際の数値で答えます
          </p>

          {/* 質問例 */}
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {SUGGESTIONS.map(({ Icon, title, detail }) => (
              <button
                key={title}
                type="button"
                onClick={() => {
                  setInput(title);
                }}
                className="rounded-2xl border border-sidebar-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <span className="flex items-center gap-2 text-sm font-black text-foreground">
                  <Icon className="h-4 w-4 text-accent-data" aria-hidden="true" />
                  {title}
                </span>
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
                    className="max-w-xs truncate rounded-full border border-sidebar-border bg-card px-3.5 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-sidebar-text-strong"
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
          <div className="flex flex-col gap-5 pb-4">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div key={index} className="flex justify-end">
                  <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-accent-data px-4 py-2.5 text-sm leading-relaxed text-white">
                    {message.content}
                  </div>
                </div>
              ) : (
                <div key={index} className="flex flex-col gap-2">
                  {(message.toolRuns?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {message.toolRuns!.map((run, i) => (
                        <ToolChip key={i} run={run} />
                      ))}
                    </div>
                  )}
                  <div
                    className={`min-w-0 rounded-2xl px-4 py-3 ${
                      message.failed
                        ? "bg-destructive/10 text-delta-down"
                        : "bg-card text-foreground"
                    }`}
                  >
                    {message.content ? (
                      <AiMarkdown text={message.content} />
                    ) : message.streaming ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        考え中…
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">応答がありませんでした。</p>
                    )}
                    {message.streaming && message.content && (
                      <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-accent-data align-middle" />
                    )}
                  </div>
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>

          {/* 下部固定の入力カード */}
          <div className="sticky bottom-4 z-10">
            <InputCard
              input={input}
              setInput={setInput}
              onSend={() => void send()}
              onStop={stop}
              busy={busy}
              compact
            />
          </div>
        </>
      )}
    </div>
  );
}
