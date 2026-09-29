// loadSession の差分をサーバー越しに確かめる（ADR 0062）。2000 発言・提示 20 件（各 20KB 前後）の会話で、
//   - 応答の量が増えた分に比例する（全量との比）。提示（Visualize の HTML の写し）も差分に入る
//   - つないだ結果は全量と同じ。合わない材料（途中の発言・提示が違う・件数が足りない）なら全量に戻る
//   - 実行中のターンの読み出し（live）も同じ
// 時間ではなく、応答の文字数と中身で判定する。純粋な計算の確認は tests/unit/history-sync.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { syncRequest, joinReply } from "../../web/history-sync.mjs";

export const name = "server-history-diff";
export const title = "loadSession { from }: 応答の量は増えた分に比例し（提示も差分）、合わなければ全量に戻る";

const ID = "diff-2000";
const start = Date.parse("2026-09-20T09:00:00+09:00");
const clone = x => JSON.parse(JSON.stringify(x));
const size = x => JSON.stringify(x).length;

/** 2000 発言（ツール入り）と提示 20 件の会話を、切り替え済みの会話の保存分として置く */
async function seed(dir, cwd) {
  await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
  await fs.mkdir(path.join(dir, "presents"), { recursive: true });
  const messages = [];
  for (let i = 0; messages.length < 2000; i++) {
    const at = k => new Date(start + (i * 4 + k) * 60_000).toISOString();
    messages.push({ role: "user", text: `質問 ${i}: ${"この部分を直してください。".repeat(5)}`, uuid: `claude:${ID}:u${i}`, at: at(0), backend: "claude" });
    messages.push({ role: "assistant", text: `調べます（${i}）。`, uuid: `claude:${ID}:a${i}`, at: at(1), backend: "claude",
      toolCalls: [{ id: `t${i}`, name: "Read", input: { file_path: `src/module${i}.mjs` }, result: { text: `行 ${i}\n`.repeat(60), isError: false, truncated: false } }] });
    messages.push({ role: "assistant", text: `答え ${i}\n\n${"説明の文です。".repeat(30)}`, uuid: `claude:${ID}:c${i}`, at: at(2), backend: "claude" });
  }
  messages.length = 2000;
  const info = { sessionId: ID, title: "Diff 2000", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
  await fs.writeFile(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
  await fs.writeFile(path.join(dir, "conversations.json"), JSON.stringify({
    [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: null, base: messages.length },
  }));
  await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify({
    [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified },
  }));
  // 提示は、それを出した発言の後に置く（visualize の印の行を持つ AI の発言と対応する）
  const rows = Array.from({ length: 20 }, (_, i) => JSON.stringify({
    at: messages[i * 100 + 2].at, kind: "html", caption: `図 ${i}`, path: null, by: "ai", content: `<div>${`図の中身 ${i} `.repeat(1500)}</div>`,
  }));
  await fs.writeFile(path.join(dir, "presents", `${ID}.jsonl`), rows.join("\n") + "\n");
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-diff-"));
  const cwd = path.join(scratch, "work");
  await fs.mkdir(cwd, { recursive: true });
  await seed(scratch, cwd);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: scratch });
  let client;
  try {
    client = await open(server);
    const full = await client.cmd("loadSession", { sessionId: ID });
    t.ok("（前提）全量は 2000 発言・提示 20 件", full.messages.length === 2000 && full.presents.length === 20, `${full.messages.length} / ${full.presents.length}`);
    const fullSize = size(full);
    t.note(`全量 ${(fullSize / 1e6).toFixed(2)}M 字`);

    /** 画面が n 発言・k 提示まで持っている状態で頼み、差分の応答とつないだ結果を返す */
    const ask = async (n, k, edit = x => x) => {
      const prev = edit({ messages: clone(full.messages.slice(0, n)), presents: clone(full.presents.slice(0, k)) });
      const request = syncRequest(prev.messages, prev.presents);
      const answer = await client.cmd("loadSession", { sessionId: ID, ...request });
      return { prev, request, answer, joined: joinReply(prev, answer, request) };
    };

    // 量は増えた分に比例する。提示（1 件約 20KB）も差分に入るので、増えた提示の分だけが載る
    const ratios = [];
    for (const [n, k] of [[1000, 10], [1500, 15], [1900, 19], [1990, 20], [2000, 20]]) {
      const r = await ask(n, k);
      const ratio = size(r.answer) / fullSize;
      ratios.push(ratio);
      const grown = (2000 - n + 2) / 2000;
      t.ok(`${n} 発言・提示 ${k} 件から: 差分の量は全量の ${(grown * 100).toFixed(1)}% 前後（増えた分 + 末尾の 2 発言）`,
        "from" in r.answer && ratio < grown * 1.3 + 0.01 && ratio > grown * 0.5, `${(ratio * 100).toFixed(2)}%`);
      t.ok(`${n} 発言・提示 ${k} 件から: つないだ結果は全量と同じ（発言・提示・その他の欄）`,
        r.joined && JSON.stringify(r.joined.messages) === JSON.stringify(full.messages) && JSON.stringify(r.joined.presents) === JSON.stringify(full.presents)
        && r.answer.completedAt === full.completedAt && r.answer.total === 2000 && r.answer.presentTotal === 20);
    }
    t.ok("増えた分が少ないほど応答は小さい（単調）", ratios.every((r, i) => i === 0 || r <= ratios[i - 1]), ratios.map(r => r.toFixed(3)).join(" > "));
    t.ok("増えていなければ全量の 1% 未満", ratios.at(-1) < 0.01, `${(ratios.at(-1) * 100).toFixed(2)}%`);
    const presentsOnly = await ask(2000, 10);
    t.ok("提示だけが増えていても、その提示だけが載る（発言は末尾の 2 件）",
      presentsOnly.answer.messages.length === 2 && presentsOnly.answer.presents.length === 10 && size(presentsOnly.answer) < fullSize * 0.4, `${(size(presentsOnly.answer) / fullSize * 100).toFixed(1)}%`);

    // 合わない材料は全量
    const mismatch = async (what, n, k, edit) => {
      const r = await ask(n, k, edit);
      t.ok(`合わなければ全量: ${what}`, !("from" in r.answer) && r.answer.messages.length === 2000 && r.answer.presents.length === 20 && r.joined === null, `${size(r.answer)} 字`);
    };
    await mismatch("途中の発言の本文が違う", 1500, 15, p => { p.messages[700].text = "手元だけ違う"; return p; });
    await mismatch("途中の発言のツールの結果が違う", 1500, 15, p => { p.messages[703].toolCalls[0].result.text = "手元だけ違う"; return p; });
    await mismatch("途中の提示が違う", 1500, 15, p => { p.presents[3].caption = "手元だけ違う"; return p; });
    await mismatch("手元の方が件数が多い（サーバーの履歴が短くなった）", 2000, 20, p => { p.messages.push(...clone(p.messages.slice(0, 10))); return p; });
    const oldClient = await client.cmd("loadSession", { sessionId: ID });
    t.ok("頼みの無い読み出し（古い画面）は今までどおり全量", !("from" in oldClient) && JSON.stringify(oldClient.messages) === JSON.stringify(full.messages));
    const broken = await client.cmd("loadSession", { sessionId: ID, from: "x", check: 1, presentFrom: 0, presentCheck: 1 });
    t.ok("壊れた頼みは全量を返す（エラーにしない）", !("from" in broken) && broken.messages.length === 2000);
    const outline = await client.cmd("loadSession", { sessionId: ID, outline: true, from: 10, check: 1, presentFrom: 0, presentCheck: 1 });
    t.ok("系譜の照合用（outline）は差分の対象外", outline.messages.length === 2000 && !("from" in outline));

    // 実行中のターンの読み出し（live）も同じ切り方
    const before = client.mark();
    await client.cmd("runTurn", { sessionId: ID, prompt: "slow", cwd, backend: "fake" });
    await client.waitFor(e => e.type === "text.delta" || e.type === "tool.start" || e.type === "session", { from: before, ms: 15000 }).catch(() => {});
    const liveFull = await client.cmd("loadSession", { sessionId: ID, live: true });
    if (!liveFull.stream) t.note("（ターンが走っていない状態だった。live の確認は全量と同じ経路）");
    const liveRequest = syncRequest(clone(liveFull.messages.slice(0, liveFull.messages.length - 5)), clone(liveFull.presents));
    const prevLive = { messages: clone(liveFull.messages.slice(0, liveFull.messages.length - 5)), presents: clone(liveFull.presents) };
    const liveDiff = await client.cmd("loadSession", { sessionId: ID, live: true, ...liveRequest });
    const joinedLive = joinReply(prevLive, liveDiff, liveRequest);
    t.ok("走っているターンの読み出しも、差分をつなぐと全量と同じ（流れの出来事は全量のときと同じ）",
      joinedLive && JSON.stringify(joinedLive.messages) === JSON.stringify(liveFull.messages)
      && liveDiff.streamCursor >= liveFull.streamCursor && Array.isArray(liveDiff.stream?.events) === Array.isArray(liveFull.stream?.events)
      && liveDiff.messages.length < 20, `${liveDiff.messages.length} 件`);
    await client.cmd("abort", { sessionId: ID }).catch(() => {});
  } finally {
    client?.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
