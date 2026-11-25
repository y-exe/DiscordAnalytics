/**
 * AIチャット用WebSocketサーバー (Bun native)。
 * Next.js (standalone) はWebSocket upgradeを扱えないため、同じコンテナ内で
 * 別ポートで待ち、Ingressで /api/ai/ws のみこちらへ振り向ける。
 *
 * プロトコル:
 *   クライアント → { type: "chat", message, threadId?, editOf? }
 *   サーバー → SSEと同じイベント (start/delta/tool/done/error) を1メッセージずつJSONで推送
 *   同時に1チャットのみ (生成中の追加chatは拒否)。接続単位で送受信し、切断で中断。
 *
 * 認証・ギルド解決・レート制限はSSEルート (/ai/chat) と同一のパイプライン
 * (ai/chatService) を使う。クッキーはupgrade時のリクエストヘッダーから取る。
 */
import { getBackendRuntime, deriveMountedRequestEnv } from "./runtime";
import { ADMIN_COOKIE_NAME, verifyAdminSession } from "./adminAuth";
import { resolveGuildByHost } from "./guilds";
import { createReadOnlyPool } from "./db";
import { SafeDiskCache } from "./safeCache";
import { prepareAIChat, runAIChat, type ChatDeps, type ChatEvent } from "./ai/chatService";

interface WsData {
  guild: { guildId: string; name: string };
  clientIp: string;
  privileged: boolean;
  /** 生成中のチャットを中断するためのコントローラ */
  chat: AbortController | null;
}

/** クッキーヘッダーから管理セッションcookieを取り出す */
function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split("; ")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator) === name) return entry.slice(separator + 1);
  }
  return undefined;
}

export function startWsServer(): void {
  const port = Number(process.env.AI_WS_PORT || 4322);
  // 起動時にランタイム (DB接続) を用意してからlistenする (DB一時障害時は再試行)
  const runtimePromise = getBackendRuntime();
  // db_query用の読み取り専用プール (遅延接続)
  let readOnlyPool: import("pg").Pool | null = null;
  const chatDeps = async (): Promise<ChatDeps> => {
    const runtime = await getBackendRuntime();
    // ディスクキャッシュはNext側プロセスと別ディレクトリにする (同時書き込みの競合回避)
    const cache = new SafeDiskCache(
      "/tmp/discord_analytics_ws_cache",
      runtime.config.cacheSizeLimitBytes,
    );
    return {
      cfg: runtime.config,
      pool: runtime.pool,
      getReadOnlyPool: () => {
        if (!readOnlyPool) {
          try {
            readOnlyPool = createReadOnlyPool(runtime.config.dbDsn);
          } catch {
            return null;
          }
        }
        return readOnlyPool;
      },
      consumeLimit: (key, max, windowSec) => cache.consumeLimit(key, max, windowSec),
    };
  };

  const boot = async () => {
    await runtimePromise.catch(() => undefined);
    const server = Bun.serve<WsData>({
      hostname: "0.0.0.0",
      port,
      async fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          return new Response("ok", { headers: { "Content-Type": "text/plain" } });
        }
        if (url.pathname !== "/api/ai/ws" && url.pathname !== "/ai/ws") {
          return new Response("Not found", { status: 404 });
        }
        const runtime = await getBackendRuntime();
        const { config: cfg, pool } = runtime;
        if (!cfg.ai.apiKey) {
          return new Response("AI機能は無効です (DEEPSEEK_API_KEYが未設定)", { status: 503 });
        }
        const cookieHeader = request.headers.get("cookie");
        const privileged =
          verifyAdminSession(readCookie(cookieHeader, ADMIN_COOKIE_NAME), cfg.adminSessionSecret) ||
          false;
        if (cfg.ai.requireAdmin && !privileged) {
          return new Response("このページは管理者ログインが必要です", { status: 403 });
        }
        const guild = await resolveGuildByHost(
          pool,
          cfg,
          request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
        );
        if (!guild) return new Response("Unknown guild host.", { status: 404 });

        const mounted = deriveMountedRequestEnv(
          new Request("http://internal/", { headers: request.headers }),
        );
        const data: WsData = {
          guild: { guildId: guild.guildId, name: guild.name },
          clientIp: mounted.peerIp,
          privileged,
          chat: null,
        };
        const upgraded = bunServer.upgrade(request, { data });
        if (!upgraded) return new Response("Upgrade failed", { status: 400 });
        return undefined;
      },
      websocket: {
        async message(ws, raw) {
          const data = ws.data as WsData;
          if (data.chat) {
            ws.send(
              JSON.stringify({ type: "error", message: "生成中です。完了までお待ちください。" }),
            );
            return;
          }
          let message = "";
          let threadId = "";
          let editOf = 0;
          try {
            const parsed = JSON.parse(String(raw)) as {
              type?: string;
              message?: string;
              threadId?: string;
              editOf?: number | string;
            };
            if (parsed.type !== "chat") return;
            message = String(parsed.message ?? "");
            threadId = String(parsed.threadId ?? "");
            editOf = Number(parsed.editOf ?? 0);
          } catch {
            ws.send(JSON.stringify({ type: "error", message: "Invalid JSON body" }));
            return;
          }

          const deps = await chatDeps();
          const prepared = await prepareAIChat(deps, {
            guild: data.guild,
            clientIp: data.clientIp,
            privileged: data.privileged,
            message,
            threadId,
            editOf,
          });
          if (!prepared.ok) {
            ws.send(
              JSON.stringify({ type: "error", message: prepared.detail, status: prepared.status }),
            );
            return;
          }

          const controller = new AbortController();
          data.chat = controller;
          try {
            await runAIChat(deps, prepared, {
              signal: controller.signal,
              send: (event: ChatEvent) => {
                if (ws.readyState === 1) ws.send(JSON.stringify(event));
              },
            });
          } finally {
            data.chat = null;
          }
        },
        close(ws) {
          (ws.data as WsData).chat?.abort();
        },
      },
    });
    console.info(`[ws] AI WebSocket server listening on :${server.port} (/api/ai/ws)`);
  };

  void boot();
}
