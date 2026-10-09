// loadSession の窓と本文の遅延をサーバー越しに確かめる（ADR 0182）。300 発言・大きい提示 12 件の会話で、
//   - 窓の頼み（lazy・tail）は末尾の窓だけを運び、大きい提示の本文は印（lazy）にする。応答は全量よりずっと小さい
//   - 遡り（older）を base が 0 になるまで繰り返すと、全量と同じ並びになる（手前が書き換わったら stale）
//   - 窓から出す差分は、窓の中だけを数えた署名で合う
//   - GET /present-body が本文を長く覚えさせる形で返す（時刻で指した分だけ。通し番号だけの分は覚えさせない）。頼みの無い古い画面は今までどおりの全量
//   - 窓の手前のサブエージェントの呼び出しは earlierCalls で運ぶ。遡りは特定の発言（reach）まで 1 回で届く
//   - 走っているターンで開いた窓（印を付ける前）に続けて、印を付けた読み出しから遡っても stale にならない（anchorSig）
// 純粋な計算の確認は tests/unit/history-window.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { syncRequest, joinReply, joinOlder, messageSig, anchorSig, stubPresent, WINDOW_MESSAGES, WINDOW_BYTES } from "../../web/history-sync.mjs";

export const name = "server-history-window";
export const title = "loadSession の窓: 末尾だけを運び、本文は印、遡りでつなぐと全量と同じ。本文は /present-body から";

const ID = "window-300";
const start = Date.parse("2026-09-20T09:00:00+09:00");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = x => JSON.stringify(x).length;

async function seed(dir, cwd) {
  await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
  await fs.mkdir(path.join(dir, "presents"), { recursive: true });
  const messages = [];
  for (let i = 0; messages.length < 300; i++) {
    const at = k => new Date(start + (i * 4 + k) * 60_000).toISOString();
    messages.push({ role: "user", text: `質問 ${i}: ${"この部分を直してください。".repeat(5)}`, uuid: `claude:${ID}:u${i}`, at: at(0), backend: "claude" });
    messages.push({ role: "assistant", text: `調べます（${i}）。`, uuid: `claude:${ID}:a${i}`, at: at(1), backend: "claude",
      toolCalls: [{ id: `t${i}`, name: "Read", input: { file_path: `src/module${i}.mjs` }, result: { text: `行 ${i}\n`.repeat(40), isError: false, truncated: false } },
        ...(i === 0 ? [{ id: "sub0", name: "Task", input: { description: "窓の外で走らせた調査\n詳しい依頼" }, result: { text: "調べ終わりました", isError: false, truncated: false } }] : [])] });
    messages.push({ role: "assistant", text: `答え ${i}\n\n${"説明の文です。".repeat(30)}`, uuid: `claude:${ID}:c${i}`, at: at(2), backend: "claude" });
  }
  const info = { sessionId: ID, title: "Window 300", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
  await fs.writeFile(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
  await fs.writeFile(path.join(dir, "conversations.json"), JSON.stringify({
    [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: null, base: messages.length },
  }));
  await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify({
    // 送信予定で送った発言の記録。窓の頭になる人の発言には、読み出しの経路によって scheduledFor の印が付く
    [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified,
      scheduledSends: messages.filter(m => m.role === "user").map(m => ({ text: m.text, planned: Date.parse(m.at) - 1000 })) },
  }));
  // 提示 13 件: 12 件は大きい本文（約 20KB）・1 件は小さい本文（印にしない）。メッセージ 24 件ごと（窓の外にも中にも）に置く
  const rows = Array.from({ length: 13 }, (_, i) => JSON.stringify({
    at: messages[i * 23 + 2].at, kind: "html", caption: `図 ${i}`, path: null, by: "ai",
    content: i === 12 ? "<p>小さい図</p>" : `<div>${`図の中身 ${i} `.repeat(1500)}</div>`,
  }));
  await fs.writeFile(path.join(dir, "presents", `${ID}.jsonl`), rows.join("\n") + "\n");
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-window-"));
  const cwd = path.join(scratch, "work");
  await fs.mkdir(cwd, { recursive: true });
  await seed(scratch, cwd);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: scratch });
  let client;
  try {
    client = await open(server);
    const http = (url, init) => fetch(`http://127.0.0.1:${server.port}${url}${url.includes("?") ? "&" : "?"}token=${server.token}`, init);

    const full = await client.cmd("loadSession", { sessionId: ID });
    t.ok("（前提）頼みの無い読み出し（古い画面）は全量で、窓の印（base）が無く、提示は本文のまま",
      full.messages.length === 300 && full.presents.length === 13 && !("base" in full) && full.presents.every(p => typeof p.content === "string" && !p.lazy));
    const fullSize = size(full);

    // ---------------------------------------------------------------- 窓
    const win = await client.cmd("loadSession", { sessionId: ID, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES });
    t.ok("窓: 末尾の窓だけを運ぶ（base + 件数 = 通し 300）", Number.isInteger(win.base) && win.base > 0 && win.base + win.messages.length === 300 && win.total === 300
      && win.messages.length >= 6 && win.messages.length <= WINDOW_MESSAGES + 20, `base ${win.base}・${win.messages.length} 件`);
    t.ok("窓: 窓の発言は全量の末尾と同じ", same(win.messages, full.messages.slice(win.base)));
    t.ok("窓: 窓の最初の発言は人の発言（続きの形が窓の頭で変わらない）", win.messages[0].role === "user");
    t.ok("窓: 提示は presentBase からの分だけ", Number.isInteger(win.presentBase) && win.presentBase + win.presents.length === 13 && win.presentTotal === 13);
    const bigs = win.presents.filter(p => p.lazy);
    t.ok("窓: 大きい提示の本文は印（lazy: { i, content: 長さ }）で、本文は運ばない", bigs.length > 0 && bigs.every(p => !("content" in p) && typeof p.lazy.content === "number" && p.lazy.content >= 2048));
    t.ok("窓: 印の i は提示の通し番号で、長さは本文の長さ", bigs.every(p => full.presents[p.lazy.i].content.length === p.lazy.content));
    t.ok("窓: 小さい本文は印にせずそのまま運ぶ", win.presents.filter(p => p.content === "<p>小さい図</p>").length === 1);
    t.ok("窓: 応答は全量の 20% 未満", size(win) < fullSize * 0.2, `${(size(win) / fullSize * 100).toFixed(1)}%`);

    // ---------------------------------------------------------------- 遡り
    let have = { messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase };
    let loads = 0, stale = false;
    while (have.base > 0 && loads < 20) {
      const request = { before: have.base, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(have.messages[0]), presentBefore: have.presentBase };
      const older = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: request });
      const joined = joinOlder(have, older, request);
      if (!joined) { stale = true; break; }
      have = joined;
      loads++;
    }
    t.ok("遡り: base が 0 になるまで続けて取れる", !stale && have.base === 0 && have.presentBase === 0 && loads >= 2, `${loads} 回`);
    t.ok("遡り: つないだ発言は全量と同じ", same(have.messages, full.messages));
    t.ok("遡り: つないだ提示は、全量の提示を印にしたものと同じ", same(have.presents, full.presents.map((p, i) => stubPresent(p, i))));

    const wrong = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { before: win.base, count: 50, bytes: 0, check: 1, presentBefore: win.presentBase } });
    t.ok("遡り: 手前の発言の署名が合わなければ stale", wrong.stale === true && !wrong.messages);
    const bad = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { before: -1, presentBefore: "x" } });
    t.ok("遡り: 壊れた頼みは stale（エラーにしない）", bad.stale === true);

    // reach: 特定の発言（会話の最初）まで 1 回で届く。見つからない uuid はいつもの件数だけ
    const reachRequest = { before: win.base, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(win.messages[0]), presentBefore: win.presentBase };
    const reached = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { ...reachRequest, reach: full.messages[0].uuid } });
    const reachedJoin = joinOlder({ messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase }, reached, reachRequest);
    t.ok("遡り（reach）: 手前の発言を 1 回で運び、会話の最初までつながる（50 件ずつの往復にならない）",
      reachedJoin && reached.base === 0 && reachedJoin.messages.length === 300 && same(reachedJoin.messages, full.messages), `base ${reached.base}`);
    const unknown = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { ...reachRequest, reach: "claude:nothing:here" } });
    t.ok("遡り（reach）: 見つからない uuid はいつもの 1 まとまりだけ（古い頼みと同じ）", unknown.base > 0 && unknown.base === (await client.cmd("loadSession", { sessionId: ID, lazy: true, older: reachRequest })).base);
    const afterWindow = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { ...reachRequest, reach: win.messages[2].uuid } });
    t.ok("遡り（reach）: 窓の中の uuid なら広げない", afterWindow.base === unknown.base);

    // ---------------------------------------------------------------- 窓の手前のサブエージェント
    const said = [{ id: "sub0", said: "窓の外で走らせた調査", done: true, failed: false, at: full.messages[1].at }];
    t.ok("窓の手前: 窓の外のサブエージェントの呼び出しを earlierCalls で運ぶ（作業ダイアログの過去の一覧のため）", same(win.earlierCalls, said), JSON.stringify(win.earlierCalls));
    t.ok("窓の手前: 全量（窓の無い読み出し）には付けない", !("earlierCalls" in full));
    const sub = await client.cmd("loadSession", { sessionId: ID, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES, ...syncRequest(win.messages, win.presents, { base: win.base, presentBase: win.presentBase }) });
    t.ok("窓の手前: 窓の差分にも付く", same(sub.earlierCalls, said));
    t.ok("窓の手前: 会話の最初まで読めば、窓の手前は無い（遡りの応答には付けない）", !("earlierCalls" in reached));

    // ---------------------------------------------------------------- 窓の差分
    const request = syncRequest(win.messages, win.presents, { base: win.base, presentBase: win.presentBase });
    const diff = await client.cmd("loadSession", { sessionId: ID, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES, ...request });
    const joinedDiff = joinReply({ messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase }, diff, request);
    t.ok("窓の差分: 窓の中だけを数えた署名で合い、つなぐと窓と同じ（base も同じ）",
      joinedDiff && same(joinedDiff.messages, win.messages) && same(joinedDiff.presents, win.presents) && joinedDiff.base === win.base && diff.base === win.base);
    const changed = syncRequest(win.messages.map((m, i) => i === 3 ? { ...m, text: "手元だけ違う" } : m), win.presents, { base: win.base, presentBase: win.presentBase });
    const mismatch = await client.cmd("loadSession", { sessionId: ID, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES, ...changed });
    t.ok("窓の差分: 窓の中が違えば差分にせず、窓を返す", !("from" in mismatch) && mismatch.base === win.base && mismatch.messages.length === win.messages.length);

    // ---------------------------------------------------------------- 本文
    const target = bigs[0];
    const urlOf = (extra = {}) => {
      const q = new URLSearchParams({ sessionId: ID, i: String(target.lazy.i), at: target.at, field: "content", ...extra });
      return `/present-body?${q}`;
    };
    const body = await http(urlOf());
    const text = await body.text();
    t.ok("本文: GET /present-body が本文をそのまま返す", body.status === 200 && text === full.presents[target.lazy.i].content, `${body.status}`);
    t.ok("本文: 長く覚えさせ（immutable）、直に開かれても実行されない形（nosniff・sandbox）",
      /max-age=31536000/.test(body.headers.get("cache-control") ?? "") && /immutable/.test(body.headers.get("cache-control") ?? "")
      && body.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(body.headers.get("content-security-policy") ?? "")
      && /^text\/plain/.test(body.headers.get("content-type") ?? ""));
    const byIndex = await http(urlOf({ at: "" }));
    t.ok("本文: 通し番号だけで指した本文は覚えさせない（巻き戻しの後に同じ番号へ別の提示が来るので）",
      byIndex.status === 200 && /no-store/.test(byIndex.headers.get("cache-control") ?? "") && !/immutable/.test(byIndex.headers.get("cache-control") ?? "")
      && (await byIndex.text()) === full.presents[target.lazy.i].content);
    const moved = await http(urlOf({ i: String(target.lazy.i + 1) }));
    t.ok("本文: i がずれていても at が合う提示を返す", (await moved.text()) === full.presents[target.lazy.i].content);
    const missing = await http(urlOf({ i: "9999", at: "2000-01-01T00:00:00.000Z" }));
    t.ok("本文: 見つからなければ 404（覚えさせない）", missing.status === 404 && /no-store/.test(missing.headers.get("cache-control") ?? ""));
    const noField = await http(urlOf({ field: "bogus" }));
    t.ok("本文: field が content・dataUri 以外なら 400", noField.status === 400);
    const image = await http(urlOf({ field: "dataUri" }));
    t.ok("本文: 画像の本文が無い提示の dataUri は 404", image.status === 404);
    const noToken = await fetch(`http://127.0.0.1:${server.port}${urlOf()}`);
    t.ok("本文: トークンが無ければ返さない", noToken.status !== 200 && !(await noToken.text()).includes("図の中身"), `${noToken.status}`);

    // ---------------------------------------------------------------- 走っているターンで開いた窓から遡る
    // 走っているターンの読み出し（live）は印を付ける前の発言を返し、遡りは印（送信予定の時刻）を付けた発言から切る。
    // 署名に印を含めると、同じ発言でも合わず、遡るたびに読み直しになっていた
    const before = client.mark();
    await client.cmd("runTurn", { sessionId: ID, prompt: "slow", cwd, backend: "fake" });
    await client.waitFor(e => e.type === "text.delta" || e.type === "tool.start" || e.type === "session", { from: before, ms: 15000 }).catch(() => {});
    const liveWin = await client.cmd("loadSession", { sessionId: ID, lazy: true, live: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES });
    if (!liveWin.stream) t.note("（ターンが走っていない状態だった。live の窓の確認は印を付けた経路と同じ）");
    const marked = await client.cmd("loadSession", { sessionId: ID, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES });
    const head = liveWin.messages[0];
    const headMarked = marked.messages.find(m => m.uuid === head.uuid);
    t.ok("（前提）走っているターンの窓の頭には印が無く、印を付けた読み出しの同じ発言には送信予定の時刻がある",
      head.role === "user" && head.scheduledFor === undefined && Number.isFinite(headMarked?.scheduledFor) && messageSig(head) !== messageSig(headMarked));
    const liveRequest = { before: liveWin.base, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(head), presentBefore: liveWin.presentBase };
    const fromLive = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: liveRequest });
    const joinedLive = joinOlder({ messages: liveWin.messages, presents: liveWin.presents, base: liveWin.base, presentBase: liveWin.presentBase }, fromLive, liveRequest);
    t.ok("走っているターンの窓から遡っても stale にならず、窓の読み直しにならない", fromLive.stale !== true && joinedLive && joinedLive.base < liveWin.base, `base ${fromLive.base}・stale ${fromLive.stale}`);
    await client.cmd("abort", { sessionId: ID }).catch(() => {});
  } finally {
    client?.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
