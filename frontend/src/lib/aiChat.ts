"use client";

import { API_URL } from "@/lib/api";

/** /ai/chat のイベント (SSE・WebSocket共通形式) */
export type AIChatEvent =
  | { type: "start"; threadId: string; title: string; userMessageId: number }
  | { type: "delta"; text: string }
  | { type: "tool_start" }
  | { type: "tool"; name: string; summary: string; output?: string }
  | { type: "done"; threadId?: string; title?: string }
  | { type: "error"; message: string };

export interface AIChatRequest {
  message: string;
  threadId?: string;
  /** 編集再送信: このai_messages.id以降を削り直す */
  editOf?: number;
}

/** /ai/chat がHTTPエラーを返したときの例外 (403判定などに使う) */
export class AIChatHttpError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.status = status;
  }
}

interface ChatParams extends AIChatRequest {
  signal: AbortSignal;
  onEvent: (event: AIChatEvent) => void;
}

/**
 * AIチャットのストリーム送受信。
 * まずWebSocket (/api/ai/ws) でリアルタイム受信を試み、失敗したらSSE (POST /ai/chat)
 * にフォールバックする。両transportとも同じAIChatEventを推送する。
 */
export async function streamAIChat(params: ChatParams): Promise<void> {
  if (typeof window !== "undefined" && !params.signal.aborted) {
    try {
      return await streamViaWebSocket(params);
    } catch (error) {
      // ユーザーによる中断、または生成開始後の切断はフォールバックせず伝える
      if (params.signal.aborted || (error as Error).name === "FallbackError") {
        if (params.signal.aborted) return;
        throw error;
      }
      // サーバーがWS未対応 / 認証エラーなど → SSEへフォールバック
    }
  }
  return streamViaSSE(params);
}

/** WebSocket版: 1チャット=1接続。開けなかったらフォールバック判定用にthrowする */
async function streamViaWebSocket(params: ChatParams): Promise<void> {
  const { signal, onEvent } = params;
  await new Promise<void>((resolve, reject) => {
    const wsUrl = `${window.location.origin.replace(/^http/, "ws")}/api/ai/ws`;
    let ws: WebSocket;
    let started = false;
    const openTimer = window.setTimeout(() => {
      cleanup();
      ws?.close();
      reject(new Error("ws-open-timeout"));
    }, 4000);

    const cleanup = () => {
      window.clearTimeout(openTimer);
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      ws?.close();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    ws.onopen = () => {
      window.clearTimeout(openTimer);
      ws.send(
        JSON.stringify({
          type: "chat",
          message: params.message,
          threadId: params.threadId,
          editOf: params.editOf,
        }),
      );
    };
    ws.onmessage = (raw) => {
      let event: AIChatEvent & { status?: number };
      try {
        event = JSON.parse(String(raw.data)) as AIChatEvent & { status?: number };
      } catch {
        return;
      }
      started = true;
      onEvent(event);
      if (event.type === "done" || event.type === "error") {
        cleanup();
        // 認証エラー (403) はそのまま伝えてゲートを出させる
        if (event.type === "error" && event.status === 403) {
          ws.close();
          reject(new AIChatHttpError(403, event.message));
          return;
        }
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      if (!started) {
        cleanup();
        reject(new Error("ws-error"));
      }
    };
    ws.onclose = () => {
      if (!started) {
        cleanup();
        reject(new Error("ws-closed-before-start"));
      } else if (signal.aborted) {
        resolve();
      } else {
        // 生成開始後の切断はフォールバックで再送すると二重投稿になるためそのまま終わる
        cleanup();
        reject(new FallbackError("ws-closed-mid-stream"));
      }
    };
  });
}

/** 生成開始後の切断 (フォールバック再送してはいけないケース) */
class FallbackError extends Error {}

/** SSE版 (POST /ai/chat) */
async function streamViaSSE(params: ChatParams): Promise<void> {
  const { signal, onEvent, ...body } = params;
  const res = await fetch(`${API_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res
      .json()
      .then((j) => (j as { detail?: string }).detail)
      .catch(() => "")
      .then((d) => d ?? "");
    throw new AIChatHttpError(res.status, detail);
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
      let payload: AIChatEvent;
      try {
        payload = JSON.parse(line.slice(5).trim()) as AIChatEvent;
      } catch {
        continue;
      }
      onEvent(payload);
    }
  }
}
