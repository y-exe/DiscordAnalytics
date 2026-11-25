/**
 * 統合コンテナのエントリポイント。
 * Next.js (standalone server.js) を起動しつつ、AIチャット用WebSocketサーバー
 * (Bun native, /api/ai/ws) を同じコンテナ内の別ポートで起動する。
 * Ingressは /api/ai/ws のみWSサーバーへ振り向け、それ以外はNextへ流す。
 */
import { startWsServer } from "../backend/src/wsServer";

startWsServer();

const next = Bun.spawn(["bun", "./frontend/server.js"], {
  cwd: "/app",
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

const code = await next.exited;
process.exit(code);
