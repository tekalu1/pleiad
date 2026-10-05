// サーバを立てて実際に LLM を呼ぶテスト。CI では回さない。手元で明示的に叩く用。
//
//   npm run test:e2e                 全部
//   npm run test:e2e -- mode model   名前で絞る（部分一致）
//
// サーバの起動・停止はこちらで面倒を見る。ポートは OS に空きを選ばせるので、
// 7420 が塞がっていても普段のサーバが動いたままでも衝突しない。
// sidecar と作業用ファイルは使い捨ての一時ディレクトリへ逃がす。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCase, summarize, pick } from "./lib/harness.mjs";
import { startServer, ROOT } from "./lib/server.mjs";
import { open } from "./lib/ws-client.mjs";

// 言語は日本語に固定する（tests/run.mjs と同じ理由）。起動するサーバーへも引き継がれる
process.env.AGENT_HOST_LOCALE ||= "ja";

const cases = [
  await import('./e2e/agent-delegation.mjs'),
  await import('./e2e/usage.mjs'),
  await import('./e2e/antigravity-usage.mjs'),
  await import('./e2e/effort.mjs'),
  await import('./e2e/context-runtime.mjs'),
  await import('./e2e/message-steer.mjs'),
  await import('./e2e/message-steer-claude.mjs'),
  await import('./e2e/visualize-claude.mjs'),
  await import('./e2e/visualize-codex.mjs'),
  await import("./e2e/fork.mjs"),
  await import("./e2e/rewind.mjs"),   // 同じ会話で巻き戻した先のモデルは、捨てた発言を覚えていない（Claude・Codex）
  await import("./e2e/ux.mjs"),
  await import("./e2e/title.mjs"),
  await import("./e2e/acceptance.mjs"),
  await import("./e2e/mode.mjs"),
  await import("./e2e/model.mjs"),
  await import("./e2e/livemode.mjs"),
  await import("./e2e/prefs.mjs"),
  await import("./e2e/groups.mjs"),
  await import("./e2e/running.mjs"),
  await import('./e2e/control.mjs'),   // ply_control（操作の一覧）の search_sessions・get_setting を Claude が呼ぶ
  await import('./e2e/control-delegated-approval.mjs'), // 委譲の子が承認待ちで終わった後の許可は、依頼元の Claude に届く
  await import('./e2e/control-stage3.mjs'), // Codex から sessions.setTitle を呼ぶ
  await import('./e2e/control-conversations.mjs'), // Codex から会話の一覧・別の会話の発言・送信待ち・委譲の一覧を call_op で読む
  await import('./e2e/control-human-only.mjs'), // Codex から worktrees.check を読み、廃止した設定操作は見えない
  await import('./e2e/control-mcp-hooks.mjs'), // Codex から MCP の登録を読む（秘密は伏せ字）・mcp.save の承認待ちを許可する（ADR 0095）
  await import('./e2e/control-send.mjs'), // Codex から sessions.send で別の会話へ送り、宛先が答える。強い宛先へは承認待ち（ADR 0104）
  await import('./e2e/control-ui-internal.mjs'), // Codex からコンテキストの中身を読み、別の会話のエージェントの切り替えとシェルの実行を承認待ち → 許可（ADR 0105）
  await import("./e2e/disconnect.mjs"),   // 猶予を短くした専用サーバが要るので最後
];

const selected = pick(cases, process.argv.slice(2));
if (!selected.length) process.exit(1);

console.log("これは実際に LLM を呼ぶ。時間と使用量がかかる。");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-e2e-")));
const dataDir = path.join(scratch, "data");
console.log(`作業場所  ${scratch}`);

const suites = [];
let server = null;
let sig = null;
const t0 = Date.now();

try {
  for (const mod of selected) {
    // 同じ設定のサーバは使い回し、要るときだけ立て直す
    const serverEnv = mod.serverEnv ?? {};
    const next = JSON.stringify(serverEnv);
    if (next !== sig) {
      if (server) await server.stop();
      server = await startServer({ env: serverEnv, dataDir });
      sig = next;
      console.log(`\nサーバ起動  port=${server.port}${Object.keys(serverEnv).length ? `  ${next}` : ""}`);
    }

    const work = path.join(scratch, "work", mod.name);
    await fs.mkdir(work, { recursive: true });

    const ctx = {
      server, root: ROOT, work, serverEnv,
      /** このサーバへ1本つなぐ。port と token は埋めてある。 */
      open: (opts = {}) => open({ port: server.port, token: server.token, ...opts }),
    };

    const suite = await runCase(mod, ctx);
    if (suite.failed) suite.serverLog = server.tail(12);
    suites.push(suite);
  }
} finally {
  if (server) await server.stop();
}

const code = summarize(suites);
for (const s of suites.filter((x) => x.serverLog)) {
  console.log(`\n  [${s.name}] のときのサーバ出力（末尾）:\n${s.serverLog.replace(/^/gm, "    ")}`);
}
console.log(`\n  ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分`);

// 落ちたときだけ現場を残す。通ったなら片付ける
if (code === 0) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
else console.log(`  作業場所を残した: ${scratch}`);

process.exit(code);
