// テスト用に core/server.mjs を別プロセスで起動する。
//
// ポートは 0 を渡して OS に空きを選ばせる。だから 7420 が塞がっていても、
// 普段使いのサーバが動いたままでも衝突しない。実際のポートは起動メッセージから読む。
// sidecar（AGENT_HOST_DATA）も使い捨ての場所へ逃がし、普段の ~/.agent-host を汚さない。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");


const LAUNCHED = /http:\/\/(localhost|[\d.]+|\[[\da-f:]+\]):(\d+)\/\?token=(\S+)/i;

/**
 * サーバを起動し、ready になるまで待つ。
 * @param env サーバプロセスに足す環境変数（AGENT_HOST_GRACE_MS など）
 * @param dataDir sidecar の置き場。使い捨ての場所を渡すこと
 */
export async function startServer({ env = {}, dataDir, timeoutMs = 90_000 } = {}) {
  const token = crypto.randomBytes(12).toString("hex");
  const child = spawn(process.execPath, [path.join(ROOT, "core", "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_HOST_PORT: "0",
      AGENT_HOST_TOKEN: token,
      // Claude のトークンの持ち主の確認（api.anthropic.com）へは送らない。確かめるテストは偽の送り先を渡す
      AGENT_HOST_ANTHROPIC_API: "off",
      // 言語は日本語に固定する。テストは日本語の文言に依存している（CI の OS の言語で変わらないように）
      AGENT_HOST_LOCALE: process.env.AGENT_HOST_LOCALE || "ja",
      ...(dataDir ? { AGENT_HOST_DATA: dataDir } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 落ちたときに何が起きていたか言えるよう、直近の出力だけ手元に残す
  const log = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      log.push(line);
      if (log.length > 200) log.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  const tail = (n = 20) => log.slice(-n).join("\n").replaceAll(token, "[redacted]");

  const port = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`サーバが ${timeoutMs}ms で起動しなかった\n${tail()}`)), timeoutMs);
    const look = (chunk) => {
      const m = LAUNCHED.exec(String(chunk));
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", look);
      res(Number(m[2]));
    };
    child.stdout.on("data", look);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`サーバが起動前に終了した (exit ${code})\n${tail()}`));
    });
  });

  return {
    port,
    token,
    root: ROOT,
    dataDir,
    tail,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      // 行儀よく終わらないなら諦めて落とす（SDK が子を抱えたままのことがある）
      const hard = setTimeout(() => child.kill("SIGKILL"), 5000);
      await done;
      clearTimeout(hard);
    },
  };
}
