// テスト用に core/server.mjs を別プロセスで起動する。
//
// ポートは 0 を渡して OS に空きを選ばせる。だから 7420 が塞がっていても、
// 普段使いのサーバが動いたままでも衝突しない。実際のポートは起動メッセージから読む。
// sidecar（AGENT_HOST_DATA）も使い捨ての場所へ逃がし、普段の ~/.agent-host を汚さない。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotGuarded } from "../../core/test-guard.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");


const LAUNCHED = /http:\/\/(localhost|[\d.]+|\[[\da-f:]+\]):(\d+)\/\?token=(\S+)/i;

/**
 * サーバを起動し、ready になるまで待つ。
 * @param env サーバプロセスに足す環境変数（AGENT_HOST_GRACE_MS など）
 * @param dataDir sidecar の置き場。使い捨ての場所を渡すこと
 * @param entry 起動するスクリプト（既定は core/server.mjs。parentPort の身代わりを置く tests/lib/parent-port-server.mjs など）
 */
export async function startServer({ env = {}, dataDir, timeoutMs = 90_000, entry = path.join(ROOT, "core", "server.mjs") } = {}) {
  const token = crypto.randomBytes(12).toString("hex");
  // 夜の記憶整理（core/memory/learn.mjs）は、起動のときに一度「追いつく」実行をし、そのときの会話・投稿を読んで隠れた learner 会話を作る。
  // 負荷で起動直後の読み取りが遅れると、テストが投稿した直後や runTurn の最中にその会話が走り、その session イベントを
  // ws-client.runTurn が自分の会話と取り違える（会話が control-info の返事でなく {"memories":[]} になる）。テストの server は止めておく。
  // 確かめるテストは prefs.json に memoryLearnPaused: false を置いてから起動する
  // 本物のデータ置き場（PLEIAD_TEST_GUARD_HOME。tests/lib/test-env.mjs）には、prefs.json を置くことも、サーバーを立てることもしない
  if (dataDir) assertNotGuarded(dataDir, "start a test server on", { ...process.env, ...env });
  if (dataDir) {
    const file = path.join(dataDir, "prefs.json");
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 無ければ空から */ }
    if (prefs.memoryLearnPaused === undefined) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...prefs, memoryLearnPaused: true }));
    }
  }
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_HOST_PORT: "0",
      AGENT_HOST_TOKEN: token,
      // Claude のトークンの持ち主の確認（api.anthropic.com）へは送らない。確かめるテストは偽の送り先を渡す
      AGENT_HOST_ANTHROPIC_API: "off",
      // 委譲の振り分け用の使用量を定期的に取らない（agy などの子プロセスを勝手に起こさない）。確かめるテストは "on" を渡す
      AGENT_HOST_ROUTING_USAGE: "off",
      // 判定器（OpenRouter の Jev・Cerebras）へは送らない。キーを登録するテストは偽の判定器を渡す
      AGENT_HOST_OPENROUTER_API: "http://127.0.0.1:9",
      AGENT_HOST_CEREBRAS_API: "http://127.0.0.1:9",
      // ターンの始まりと終わりの git の撮影（refs/pleiad/）はしない。作業場所が開発中のリポジトリのテストが .git に ref を残さないため。
      // 確かめるテスト（server-git）は "on" を渡す
      AGENT_HOST_GIT_SNAPSHOTS: "off",
      // worktree（git worktree。ADR 0089）は作らない。cwd がこのリポジトリのテストが <リポジトリ>.pleiad に作業場所を残すため。
      // 確かめるテスト（server-worktree）は一時のリポジトリを cwd にして "on" を渡す
      AGENT_HOST_WORKTREES: "off",
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
