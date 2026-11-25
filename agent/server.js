// agent/server.js — コマンド実行専用コンテナのサーバー
//
// DiscordWebAnalyticsのAI機能用。AIを動かすバックエンド (秘密あり) とは
// 別コンテナ / 別PID namespace で動くため:
// - バックエンドの環境変数・/proc は絶対に見えない (シークレット分離)
// - ここには秘密の env を渡さない (envFrom なし)
// - DB はマウントされない
// - このPID namespace内の全プロセスは自分と同UIDなので、オーファンも含めて
//   全部killできる (スイーパーで掃除)
//
// プロトコル: 1接続1コマンド。1行JSONリクエスト → 1行JSONレスポンス
//   req:  { id, command, timeoutSeconds? }
//   res:  { ok: true, output } | { ok: false, error }
//
// 参考実装: glm-ai-chat の src/agent/server.js

import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";

const SOCKET_PATH = process.env.AGENT_SOCKET ?? "/agent-sock/agent.sock";
const WORKDIR = process.env.AGENT_WORKDIR ?? "/work";
const MAX_OUTPUT_BYTES = 200_000; // 内部保持上限 (最終的にさらに切り詰める)
const MAX_CONCURRENT = 4;

const safeEnv = {
  PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: WORKDIR,
  USER: "node",
  SHELL: "/bin/sh",
  LANG: "C.UTF-8",
  TERM: "dumb",
  NODE_ENV: "production",
};

/** 実行中リクエストの管理: id → { child, timer, done } */
const running = new Map();

function truncateOutput(buf) {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf;
  const half = Math.floor(MAX_OUTPUT_BYTES / 2);
  return Buffer.concat([buf.subarray(0, half), buf.subarray(buf.length - half)]);
}

/** 自分のPID namespace内のオーファンプロセスを掃除する */
function sweepOrphans() {
  let entries;
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return;
  }
  const ppid = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = String(fs.readFileSync(`/proc/${entry.name}/stat`));
      // statの形式: pid (comm) state ppid ... — commに空白が入るため最後の ) で分割
      const rest = stat.slice(stat.lastIndexOf(")") + 2);
      const parent = Number(rest.split(" ")[1]);
      ppid.set(Number(entry.name), parent);
    } catch {
      /* 既に消えている */
    }
  }

  // allowed = 自分 + 稼働中リクエストの子とその全子孫
  const allowed = new Set([process.pid]);
  const roots = [];
  for (const { child } of running.values()) {
    if (child.pid) roots.push(child.pid);
  }
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    if (allowed.has(pid)) continue;
    allowed.add(pid);
    for (const [p, parent] of ppid) {
      if (parent === pid && !allowed.has(p)) stack.push(p);
    }
  }

  for (const pid of ppid.keys()) {
    if (pid === process.pid || allowed.has(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 既に消えている */
    }
  }
}

setInterval(sweepOrphans, 15_000).unref();

function runCommand(req, reply) {
  const timeoutSec = Math.min(
    Math.max(Number(req.timeoutSeconds) * 1000 || 60_000, 1_000),
    300_000,
  );
  // NULバイトを含むコマンドはspawnに渡せないため除去
  const command = String(req.command ?? "").replaceAll("\0", "");

  let child;
  try {
    child = spawn("/bin/sh", ["-c", command], {
      cwd: WORKDIR,
      env: safeEnv,
      detached: true, // プロセスグループリーダーにしてgroup killを可能に
    });
  } catch (err) {
    reply({ id: req.id, ok: false, error: `spawn failed: ${err.message}` });
    return;
  }

  const entry = { child, timer: null, done: false };
  running.set(req.id, entry);

  const out = [];
  let outBytes = 0;
  child.stdout.on("data", (d) => {
    if (outBytes < MAX_OUTPUT_BYTES) {
      outBytes += d.length;
      out.push(d);
    } else d.resume?.();
  });
  child.stderr.on("data", (d) => {
    if (outBytes < MAX_OUTPUT_BYTES) {
      outBytes += d.length;
      out.push(d);
    } else d.resume?.();
  });

  const finish = (payload) => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    running.delete(req.id);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* 終了済み */
    }
    reply(payload);
  };

  entry.timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* 終了済み */
    }
  }, timeoutSec);

  child.on("error", (err) => {
    finish({ id: req.id, ok: false, error: err.message });
  });

  child.on("close", (code, signal) => {
    const buf = truncateOutput(Buffer.concat(out)).toString("utf8").trim() || "(no output)";
    const exitInfo = signal ? `signal ${signal} (timeout or killed)` : `exit code: ${code}`;
    finish({ id: req.id, ok: true, output: `${buf}\n(${exitInfo})` });
  });
}

fs.mkdirSync(WORKDIR, { recursive: true });
fs.rmSync(SOCKET_PATH, { force: true });

const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    const idx = buf.indexOf("\n");
    if (idx === -1) return;
    socket.end();
    let req;
    try {
      req = JSON.parse(buf.slice(0, idx));
    } catch {
      socket.write(`${JSON.stringify({ id: null, ok: false, error: "protocol error" })}\n`);
      return;
    }
    if (running.size >= MAX_CONCURRENT) {
      socket.write(`${JSON.stringify({ id: req.id, ok: false, error: "server busy" })}\n`);
      return;
    }
    runCommand(req, (payload) => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
  socket.on("error", () => {});
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o666);
  console.log(`agent server listening on ${SOCKET_PATH} (workdir: ${WORKDIR})`);
});
