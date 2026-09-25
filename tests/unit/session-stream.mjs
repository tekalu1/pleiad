import fs from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { createSessionLoads } from "../../web/session-stream.mjs";
import { createCompletionNotifications } from '../../web/notifications.mjs';
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "session-stream";
export const title = "途中で開いたセッションを履歴と受信イベントから欠落なく復元する";

export default async function (t) {
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const functions = ["onEvent", "isMine", "appendText", "openTurnEl", "closeTurnEl", "clearThread", "paintSession", "select", "loadAndPaint"].map(name => {
    let start = source.indexOf(`function ${name}(`);
    if (source.slice(start - 6, start) === "async ") start -= 6;
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n");
  const noop = () => {};
  const notices = [];
  const completionNotifications = createCompletionNotifications({ host: { plyDesktop: { notifyCompletion: notice => notices.push(notice) } }, openSession: noop });
  let bodies = [], releaseHistory, releaseBranches, syncs = 0;
  const state = { current: "other", sessions: [], drafts: new Map(), toolCards: new Map(), runningIds: new Set(["target"]), stopping: new Set(), pendingPerms: new Map() };
  const loads = createSessionLoads();
  const context = vm.createContext({
    setTimeout: () => 1, clearTimeout: noop,
    completionNotifications,
    // ヘッダーの使用量のチップ（web/header-usage.mjs）。ターンの終わりで取り直す。このテストの対象外
    headerUsage: { turnEnded: noop },
    filePreview: { sessionChanged: noop },
    // 狭い画面の引き出し（client.mjs の setDrawer）。会話を開くと閉じる。このテストの対象外
    setDrawer: noop,
    // 入力欄の待ち（web/composer-wait.mjs）。tests/unit/composer-wait.mjs が見る。このテストの対象外
    composerWait: { busy: noop, idle: noop, failed: noop, cancel: noop, queued: false }, freshSessionId: null,
    promptPlaceholder: () => "chat.composer.placeholder",
    state, sessionLoads: loads, outboxes: new Map(), paintOutbox: noop, syncOutboxRows: noop, refreshOutbox: async () => [],
    displayedCompletions: new Map(), document: { visibilityState: "visible" },
    // 承認カードはこのテストの対象外（tests/unit/server-fake.mjs の reopenCase が見ている）
    paintPendingPerms: noop,
    readCompletions: { mark: noop }, renderSessions: noop, acknowledgeDisplayed: noop, el: () => ({ dataset: {} }), renderMarkdown: x => x, renderAssistantMarkdown: x => x,
    closeThink: noop, activity: { show: noop, hide: noop }, atBottom: () => false,
    ensureTurnEl: () => ({ append: x => bodies.push(x) }),
    thread: { replaceChildren: () => { bodies = []; }, classList: { toggle: noop, remove: noop }, querySelectorAll: () => [] },
    spine: noop, branchSnapshots: () => [], localStorage: { setItem: noop },
    branches: { load: () => new Promise(r => { releaseBranches = r; }), has: () => false },
    $: () => ({}), syncRunState: noop, syncTopbar: noop, log: { scrollTop: 0, scrollHeight: 0 },
    loadDraft: noop, saveDraft: async () => {}, settingsFailure: null, sys: noop,
    paintHistory: () => [], placeJunctions: () => [], isRunningHere: () => false, behindHere: () => null,
    relayoutBranches: noop, branchIsFresh: () => false, setUuid: noop,
    paintContextLine: noop, paintContextEntry: noop, refreshContextEntry: async () => null, isManagedContext: () => false,
    syncHistory: () => { syncs++; }, refresh: async () => {},
    cmd: () => new Promise(r => { releaseHistory = r; }),
    // 文言（web/i18n.mjs の t と client.mjs の html.t・ACTIVITY_LABEL）。このテストは文言を見ない
    t: key => key, html: { t: key => key }, ACTIVITY_LABEL: {},
  });
  vm.runInContext(functions, context);
  const event = (text, streamSeq) => ({ type: "text.delta", sessionId: "target", text, streamSeq });
  const deliver = ev => { context.event = ev; vm.runInContext("onEvent(event)", context); };
  deliver(event("先頭", 1)); // Not viewing this session yet.
  const selection = vm.runInContext("select('target')", context);
  deliver(event("・取得中", 2));
  t.ok("履歴読み込み中の本文は描画を保留する", bodies.length === 0);
  releaseHistory({ messages: [], presents: [], stream: { events: [event("先頭", 1), event("・取得中", 2)] }, streamCursor: 2 });
  await new Promise(setImmediate);
  deliver(event("・分岐読込中", 3));
  releaseBranches();
  await selection;
  deliver(event("・続き", 4));
  t.ok("先頭・取得中・描画待ち・続きが一度ずつ同じ本文に入る", bodies.length === 1 && bodies[0].dataset.raw === "先頭・取得中・分岐読込中・続き");

  // A completion during the async layout must run after snapshot reconstruction.
  state.current = "other";
  const next = vm.runInContext("select('target')", context);
  releaseHistory({ messages: [], presents: [], stream: { events: [event("全文", 5)] }, streamCursor: 5 });
  await new Promise(setImmediate);
  deliver({ type: "text.end", sessionId: "target", streamSeq: 6 });
  deliver({ type: "turnEnd", sessionId: "target", streamSeq: 7, outcome: 'ok', completedAt: 100 });
  t.ok("読込中の終了による同期は復元まで待つ", syncs === 0);
  releaseBranches();
  await next;
  t.ok("読込中に終了しても全文を残して履歴同期する", bodies[0]?.dataset.raw === "全文" && syncs === 1);
  t.ok('履歴読込中の完了も一度だけ通知する', notices.length === 1 && notices[0].sessionId === 'target');

  const cancelled = loads.begin("target");
  loads.cancel(cancelled);
  t.ok("中止した読込は以後の受信を保留しない", !loads.capture(event("次", 8), "target"));
  const branchLoad = loads.begin("target");
  t.ok("分岐先を読み込む間も現在のセッションは動く", !loads.capture({ ...event("別", 9), sessionId: "other" }, "other"));
  loads.capture(event("枝", 10), "other");
  t.ok("まだ選択されていない分岐先の受信も保持する", loads.finish(branchLoad, { streamCursor: 9 })[0]?.text === "枝");

  state.current = "other";
  const oldSelection = vm.runInContext("select('target')", context);
  const oldReply = releaseHistory;
  const otherSelection = vm.runInContext("select('other')", context);
  const otherReply = releaseHistory;
  const latestSelection = vm.runInContext("select('target')", context);
  releaseHistory({ messages: [], presents: [], stream: { events: [event("最新", 11)] }, streamCursor: 11 });
  await new Promise(setImmediate);
  releaseBranches();
  await latestSelection;
  deliver(event("の続き", 12));
  otherReply({ messages: [], presents: [], streamCursor: 9 });
  oldReply({ messages: [], presents: [], streamCursor: 8 });
  await Promise.all([oldSelection, otherSelection]);
  t.ok("A→B→Aを素早く開いても古い応答が上書き・受信妨害しない", bodies.length === 1 && bodies[0].dataset.raw === "最新の続き");

  const serverSource = await fs.readFile(new URL("../../core/server.mjs", import.meta.url), "utf8");
  const loadCase = serverSource.slice(serverSource.indexOf('case "loadSession": {') + 'case "loadSession": {'.length,
    serverSource.indexOf('// Allocate the host identity')).trim().replace(/\}\s*$/, "");
  let resolveTranscript;
  const liveReads = new Set();
  const turn = { stream: { messages: [], presents: [], user: { role: "user", text: "input" }, initialMessageId: 'msg-initial', events: [event("先頭", 1)] } };
  const turns = new Map([["target", turn]]);
  const serverContext = vm.createContext({
    msg: { args: { sessionId: "target", live: true } }, runtime: { turns, waiting: new Map() }, liveReads,
    resolveBackendForSession: async () => ({}), store: { get: async () => ({}) },
    history: { loadTranscript: () => new Promise(r => { resolveTranscript = r; }) },
    reply: (ok, data) => data, streamSequence: 3,
  });
  const loading = vm.runInContext(`(async () => { ${loadCase} })()`, serverContext);
  await new Promise(setImmediate);
  turn.stream.events.push(event("末尾", 2), { type: "turnEnd", sessionId: "target", streamSeq: 3 });
  turns.delete("target");
  resolveTranscript({ messages: [], presents: [] });
  const completedDuringRead = await loading;
  t.ok("サーバーの履歴取得中に終了しても保持したターンから末尾まで返す", completedDuringRead.stream.events.length === 3 && completedDuringRead.stream.events.at(-1).type === "turnEnd");
  t.ok('初回発言の ID は userMessage より前の履歴取得でも保つ', completedDuringRead.initialMessageId === 'msg-initial');
  t.ok("サーバーの読込待ち参照を解放する", liveReads.size === 0);

  // Real server and a fresh socket: no browser-side cache can supply the prefix.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-stream-"));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: scratch });
  let client, viewer;
  try {
    client = await open(server);
    const first = await client.runTurn({ prompt: "echo:前の発言", cwd: ROOT, backend: "fake" });
    const id = first.sessionId;
    const from = client.mark();
    const text = "先頭から最後まで🌸".repeat(300);
    await client.cmd("runTurn", { sessionId: id, prompt: `echo:${text}`, cwd: ROOT });
    await client.waitFor(e => e.type === "text.delta", { from, ms: 10000 });
    viewer = await open(server);
    const received = [];
    // open() keeps all events, including events before the response.
    const snapshot = await viewer.cmd("loadSession", { sessionId: id, live: true });
    t.ok("実行中の履歴は開始前の履歴と今回の入力だけ", snapshot.messages.length === 3 && snapshot.messages[1].text === "前の発言" && snapshot.messages[2].text === `echo:${text}`);
    t.ok("後から接続しても既受信の先頭を取得できる", snapshot.stream?.events.some(e => e.type === "text.delta" && e.text.startsWith("先頭")));
    await viewer.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { ms: 10000 });
    received.push(...snapshot.stream.events, ...viewer.turnResult(0).events.filter(e => e.streamSeq > snapshot.streamCursor && e.sessionId === id));
    const full = received.filter(e => e.type === "text.delta").map(e => e.text).join("");
    t.ok("スナップショット境界の重複を除いて全文を復元できる", full === text);
    const done = await viewer.cmd("loadSession", { sessionId: id, live: true });
    t.ok("終了後は保存済み履歴だけを返す", !done.stream && done.messages.at(-1).text === text);
  } finally {
    viewer?.close(); client?.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
