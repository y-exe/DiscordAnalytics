/**
 * agentコンテナ (コマンド実行専用・秘密なし) のUnix socketクライアント。
 * socket未設定 (開発環境) の場合はローカルでフォールバック実行する。
 * 参考実装: glm-ai-chat の src/tools/exec.js
 */
import net from "node:net";
import fs from "node:fs";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface AgentConfig {
  /** Unix socketパス。空文字ならローカル実行 */
  agentSocket: string;
}

const AGENT_TIMEOUT_MARGIN_MS = 5_000;

/** agent serverにコマンドを投げる (1接続1コマンド) */
function execViaAgent(
  socketPath: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: net.Socket | null = null;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      socket?.destroy();
      resolve(result);
    };

    const watchdog = setTimeout(() => {
      socket?.destroy();
      finish("(no output)\n(exit code: timeout)");
    }, timeoutMs + AGENT_TIMEOUT_MARGIN_MS);

    if (signal) {
      if (signal.aborted) return finish("(no output)\n(exit code: aborted)");
      signal.addEventListener("abort", () => socket?.destroy(), { once: true });
    }

    socket = net.createConnection(socketPath, () => {
      socket?.write(
        `${JSON.stringify({ id: randomUUID(), command, timeoutSeconds: Math.round(timeoutMs / 1000) })}\n`,
      );
    });

    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      try {
        const resp = JSON.parse(buf.slice(0, idx)) as {
          ok: boolean;
          output?: string;
          error?: string;
        };
        finish(
          resp.ok ? (resp.output ?? "(no output)") : `(agent error) ${resp.error ?? "unknown"}`,
        );
      } catch {
        finish(`(agent protocol error) ${buf.slice(0, 200)}`);
      }
    });
    socket.on("error", (err) => finish(`(agent connection error) ${err.message}`));
  });
}

/** 開発環境フォールバック: ローカル実行。秘密は環境変数から除去 */
function execLocal(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        shell: process.platform === "win32" ? undefined : "/bin/sh",
        cwd: process.env.AI_EXEC_WORKDIR ?? process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          TERM: "dumb",
          NODE_ENV: "production",
        },
      },
      (
        err: (Error & { code?: string | number; signal?: string; killed?: boolean }) | null,
        stdout: string,
        stderr: string,
      ) => {
        const parts = [];
        if (stdout) parts.push(String(stdout).trimEnd());
        if (stderr) parts.push(`[stderr]\n${String(stderr).trimEnd()}`);
        const exitInfo = err
          ? `exit code: ${err.code ?? `signal ${err.signal ?? "?"}`}${err.killed ? " (timeout)" : ""}`
          : "exit code: 0";
        resolve(`${parts.join("\n").trim() || "(no output)"}\n(${exitInfo})`);
      },
    );
  });
}

export function agentAvailable(config: AgentConfig): boolean {
  return Boolean(config.agentSocket) && fs.existsSync(config.agentSocket);
}

/** Linux (agentコンテナ) 内でシェルコマンドを実行し、AIへ渡す結果テキストを返す */
export async function runAgentCommand(
  config: AgentConfig,
  command: string,
  { timeoutSeconds, signal }: { timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const requested = Number(timeoutSeconds) * 1000;
  const timeoutMs =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, 300_000) : 60_000;

  const output = agentAvailable(config)
    ? await execViaAgent(config.agentSocket, command, timeoutMs, signal)
    : await execLocal(command, timeoutMs);

  // 長すぎる出力は先頭+末尾を残して中間を省略する
  const maxChars = 8_000;
  if (output.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    return `${output.slice(0, half)}\n…(中略 ${output.length - half * 2}文字)…\n${output.slice(-half)}`;
  }
  return output;
}
