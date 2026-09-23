// Codex のバックグラウンド端末を、runTurn の attach / detach をまたいで拾えるか（issue #6）。
//
// 本物の codex は起こさない。tests/lib/scripted-codex.mjs がテストの渡した frame をそのまま
// stdout に流すので、codex-rpc は本物と同じ経路（子プロセスの stdio・改行区切り）で受ける。
// frame の形は JSON Schema に合わせた（ItemStarted/CompletedNotification の threadId / turnId / item、
// CommandExecutionThreadItem の processId / source / status）。
// `thread/backgroundTerminals/list` の応答は、codex-cli 0.154.0-alpha.6.2 で実際に端末を 1 本起こして
// 確かめた形（2026-09-16、issue #6 の着手条件 1）:
//   { data: [{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }], nextCursor: 数字の文字列|null }
// そのとき見えた並び: item/started（status: inProgress、processId は数字の文字列、source: unifiedExecStartup）
//   -> 端末はターン中から list に載る -> thread/status/changed(idle) -> turn/completed（端末は inProgress のまま）
//
// **ここで測れないこと**: 本物の codex が遅れて `item/completed` を出すまでの間合い（数分〜数十時間）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rpc as shared } from "../../core/backends/codex-rpc.mjs";
import { backend } from "../../core/backends/codex.mjs";

export const name = "codex-terminals";
export const title = "Codex のバックグラウンド端末が、ターンの外でも会話の印として残る";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "tests", "lib", "scripted-codex.mjs");

const THREAD = "01a09da1-1111-7000-8000-00000000000a";

/** dev サーバのような、ターンをまたいで生きる端末（unified_exec） */
const terminal = (id, command, extra = {}) => ({
  id, type: "commandExecution", command, commandActions: [], cwd: ROOT,
  status: "inProgress", source: "unifiedExecStartup", processId: "pty_1", ...extra,
});

/** その場で終わる普通のコマンド */
const plain = (id, command, extra = {}) => ({
  id, type: "commandExecution", command, commandActions: [], cwd: ROOT, status: "inProgress", ...extra,
});

/** thread/backgroundTerminals/list の要素（実機で確かめた形そのまま） */
const term = (itemId, processId) => ({
  itemId, processId, command: "Start-Sleep -Seconds 900", cwd: ROOT,
  osPid: null, cpuPercent: null, rssKb: null,
});

async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("待ちきれなかった");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export default async function (t) {
  const previousBin = process.env.AGENT_HOST_CODEX_BIN;
  const previousMs = process.env.AGENT_HOST_CODEX_RECONCILE_MS;
  process.env.AGENT_HOST_CODEX_BIN = `node "${SCRIPT}"`;
  // 照合を速く回す。タイマーは端末を数え始めた時点で張られるので、最初のターンより前に決めておく
  process.env.AGENT_HOST_CODEX_RECONCILE_MS = "40";
  shared.stop();   // 他のテストが起こしていたら止める

  // server が渡す口（docs/multi-backend.md §2.7）を身代わりで受ける
  const reported = [];   // [sessionId, tasks]
  const outside = [];    // [sessionId, event]
  backend.attachHost({
    background: (sessionId, tasks) => reported.push([sessionId, tasks]),
    externalTurn: () => {},
    event: (sessionId, event) => outside.push([sessionId, event]),
  });
  const lastTasks = () => reported.at(-1)?.[1] ?? null;
  const taskIds = () => (lastTasks() ?? []).map((x) => x.id).sort().join(",");

  const push = (...frames) => shared.request("test/push", { frames });
  const state = () => shared.request("test/state");

  /** ターンを 1 本始め、codex が払い出した turn id が分かるまで待つ。 */
  async function startTurn(prompt, emit = () => {}) {
    const before = (await state()).turns.length;
    const run = backend.runTurn({
      prompt, sessionId: THREAD, cwd: ROOT, mode: "full", emit,
      askPermission: async () => ({ allow: true }),
    });
    const s = await until(async () => {
      const x = await state();
      return x.turns.length > before ? x : null;
    });
    return { run, turnId: s.turns.at(-1) };
  }

  const turnStarted = (turnId) =>
    ({ method: "turn/started", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } } });
  const turnCompleted = (turnId) =>
    ({ method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } } });
  const itemStarted = (turnId, item) =>
    ({ method: "item/started", params: { threadId: THREAD, turnId, startedAtMs: Date.now(), item } });
  const itemCompleted = (turnId, item) =>
    ({ method: "item/completed", params: { threadId: THREAD, turnId, completedAtMs: Date.now(), item } });

  try {
    // ---- 1 本目のターン: 端末を起こしたまま終わる
    const events = [];
    const first = await startTurn("dev サーバを立てて", (e) => events.push(e));
    await push(
      turnStarted(first.turnId),
      itemStarted(first.turnId, terminal("call_dev", "npm run dev")),
      // 同じターンの中で終わる普通のコマンド。裏には残らない
      itemStarted(first.turnId, plain("call_ls", "ls")),
      itemCompleted(first.turnId, plain("call_ls", "ls", { status: "completed", exitCode: 0, aggregatedOutput: "core web" })),
      { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: first.turnId, itemId: "it_msg", delta: "立てた" } },
      turnCompleted(first.turnId),
    );
    await first.run;

    t.ok("ターンは普通に ok で終わる（端末の終了を待たない）",
      events.some((e) => e.type === "turnResult" && e.outcome === "ok"));
    t.ok("ターンが終わった時点で、走ったままの端末が会話の裏の作業として出る",
      reported.at(-1)?.[0] === THREAD && lastTasks()?.length === 1
        && lastTasks()[0].id === "call_dev" && lastTasks()[0].kind === "terminal"
        && lastTasks()[0].label === "npm run dev",
      JSON.stringify(reported.at(-1) ?? null));
    t.ok("ターンの中で終わったコマンドは裏に残らない",
      !lastTasks().some((x) => x.id === "call_ls"), JSON.stringify(lastTasks()));
    t.ok("端末のツールカードはこの時点では結果を持たない（走っている）",
      !events.some((e) => e.type === "tool.result" && e.id === "call_dev"),
      JSON.stringify(events.filter((e) => e.type === "tool.result").map((e) => e.id)));

    await push({ method: 'item/commandExecution/outputDelta', params: {
      threadId: THREAD, turnId: first.turnId, itemId: 'call_dev', delta: 'Listening on 5191\n',
    } });
    t.ok('ターン終了後も端末の出力を詳細で読める', backend.getBackgroundTask(THREAD, 'call_dev')?.output === 'Listening on 5191\n');
    t.ok('別の会話から端末の出力を取得できない', backend.getBackgroundTask('other-session', 'call_dev') === null);
    t.ok('閲覧では終了要求を送らない', (await state()).terminated.length === 0);

    // ---- ターンの外に遅れて届く item/completed（turnId は終わったターンのまま）
    const before = reported.length;
    await push(itemCompleted(first.turnId,
      terminal("call_dev", "npm run dev", { status: "completed", exitCode: 0, aggregatedOutput: "shutting down" })));
    await until(async () => reported.length > before);

    t.ok("遅れて届いた完了で、会話の裏の作業が空になる（印が消える）",
      reported.at(-1)?.[0] === THREAD && lastTasks()?.length === 0, JSON.stringify(reported.at(-1) ?? null));
    const patch = outside.find(([, e]) => e.type === "tool.result" && e.id === "call_dev");
    t.ok("終わったターンのツールカードへ、結果がターンの外から差し込まれる",
      patch?.[0] === THREAD && /shutting down/.test(String(patch[1].text)) && patch[1].isError === false,
      JSON.stringify(patch ?? null));

    // ---- 次のターンの最中に、さらに遅れた完了が届く
    const second = [];
    const two = await startTurn("様子を見て", (e) => second.push(e));
    await push(
      turnStarted(two.turnId),
      // 1 本目のターンで起きた別の端末が、いまごろ終わった（turnId は古いまま）
      itemCompleted(first.turnId, terminal("call_old", "python -m http.server", { status: "completed", exitCode: 0 })),
      turnCompleted(two.turnId),
    );
    await two.run;

    t.ok("古いターンのアイテムが、いま走っているターンのカードとして生えない",
      !second.some((e) => e.type === "tool.start" && e.id === "call_old"),
      JSON.stringify(second.filter((e) => e.type === "tool.start").map((e) => e.id)));
    t.ok("数えていない端末の完了では、ターンの外へも何も出さない",
      !outside.some(([, e]) => e.id === "call_old"), JSON.stringify(outside.map(([, e]) => e.id)));

    // ---- thread/backgroundTerminals/list との照合（取りこぼした終了を引く）
    //
    // 実機（codex 0.154.0-alpha.6.2）の応答は `{ data: [...], nextCursor: 数字の文字列 | null }`。
    // 台本役はページを積んだときだけ答え、尽きたら実機と同じ `thread not found` を返す
    // （= 照合は積んだときにだけ動く。他の判定が照合に揺さぶられない）。
    const three = await startTurn("サーバを 2 本立てて");
    await push(
      turnStarted(three.turnId),
      itemStarted(three.turnId, terminal("call_a", "npm run dev")),
      itemStarted(three.turnId, terminal("call_b", "python -m http.server", { processId: "pty_2" })),
      turnCompleted(three.turnId),
    );
    await three.run;
    t.ok("2 本の端末を数えている", taskIds() === "call_a,call_b", JSON.stringify(lastTasks()));

    // 1 ページ目に call_a だけ・続きあり。読み切れないので消してはいけない
    await shared.request("test/terminals", { pages: [{ data: [term("call_a", "pty_1")], nextCursor: "1" }] });
    const calls = (await state()).terminalCalls;
    await until(async () => (await state()).terminalCalls > calls + 1);
    t.ok("続きのあるページだけでは引かない（生きている端末の印を落とさない）",
      taskIds() === "call_a,call_b", JSON.stringify(lastTasks()));

    // 2 ページに分かれた完全な一覧。どちらも生きているので、やはり引かない
    await shared.request("test/terminals", { pages: [
      { data: [term("call_a", "pty_1")], nextCursor: "1" },
      { data: [term("call_b", "pty_2")], nextCursor: null },
    ] });
    const calls2 = (await state()).terminalCalls;
    await until(async () => (await state()).terminalCalls > calls2 + 2);
    t.ok("cursor を追って全ページ読めば、両方とも残る", taskIds() === "call_a,call_b", JSON.stringify(lastTasks()));

    // 片方がもう居ない。取りこぼした終了として引く
    const beforePrune = reported.length;
    await shared.request("test/terminals", { pages: [{ data: [term("call_a", "pty_1")], nextCursor: null }] });
    await until(async () => reported.length > beforePrune);
    t.ok("一覧に無くなった端末は引く（item/completed を取りこぼしても印が消える）",
      taskIds() === "call_a", JSON.stringify(lastTasks()));

    // ---- 止める（thread/backgroundTerminals/terminate）
    //
    // codex が求めるのは itemId ではなく processId（数字の文字列）。見張りが覚えているものへ引き直す。
    // 止めた後は codex に数え直させる（先回りして印を消さない）
    await shared.request("test/terminals", { pages: [{ data: [], nextCursor: null }] });
    const stopped = await backend.stopBackground(THREAD, "call_a");
    t.ok("止めたと返る", stopped?.stopped === true, JSON.stringify(stopped));
    const asked = (await state()).terminated.at(-1);
    t.ok("itemId ではなく processId で止めに行く",
      asked?.processId === "pty_1" && asked.threadId === THREAD, JSON.stringify(asked ?? null));
    t.ok("止めた後は codex に数え直させて印を消す", taskIds() === "", JSON.stringify(lastTasks()));

    await (async () => {
      let err = null;
      await backend.stopBackground(THREAD, "知らない端末").catch((e) => { err = e; });
      t.ok("知らない端末は止めに行かず、理由を返す", /processId/.test(String(err?.message)), String(err?.message));
    })();

    // ---- backgroundTerminals を持たない古い codex（0.147.0）
    //
    // 端末を数えること自体は遅れて届く item/completed だけでできるので、印は出る。
    // 止められないことだけを、直し方の分かる言い方で断る（生のプロトコルエラーを見せない）
    const five = await startTurn("古い codex で立てて");
    await push(
      turnStarted(five.turnId),
      itemStarted(five.turnId, terminal("call_old_cli", "npm run dev")),
      turnCompleted(five.turnId),
    );
    await five.run;
    t.ok("古い codex でも端末は数えられる（印は出る）", taskIds() === "call_old_cli", JSON.stringify(lastTasks()));

    await shared.request("test/oldCodex", { on: true });
    let oldErr = null;
    await backend.stopBackground(THREAD, "call_old_cli").catch((e) => { oldErr = e; });
    t.ok("古い codex では、直し方の分かる言い方で断る",
      /codex update/.test(String(oldErr?.message)) && !/unknown variant/.test(String(oldErr?.message)),
      String(oldErr?.message));
    await shared.request("test/oldCodex", { on: false });
    await push(itemCompleted(five.turnId,
      terminal("call_old_cli", "npm run dev", { status: "completed", exitCode: 0 })));
    await until(async () => taskIds() === "");

    // ---- app-server が落ちたら、走っていた端末は道連れ。印を残さない
    const four = await startTurn("もう一度立てて");
    await push(
      turnStarted(four.turnId),
      itemStarted(four.turnId, terminal("call_dev2", "npm run dev")),
      turnCompleted(four.turnId),
    );
    await four.run;
    t.ok("止めた後でも、新しい端末はまた数える", taskIds() === "call_dev2", JSON.stringify(lastTasks()));

    const beforeDown = reported.length;
    shared.proc?.kill();
    await until(async () => reported.length > beforeDown);
    t.ok("app-server が落ちたら、数えていた端末を全部消す",
      reported.at(-1)?.[0] === THREAD && reported.at(-1)[1].length === 0, JSON.stringify(reported.at(-1) ?? null));
  } finally {
    shared.stop();
    if (previousBin === undefined) delete process.env.AGENT_HOST_CODEX_BIN;
    else process.env.AGENT_HOST_CODEX_BIN = previousBin;
    if (previousMs === undefined) delete process.env.AGENT_HOST_CODEX_RECONCILE_MS;
    else process.env.AGENT_HOST_CODEX_RECONCILE_MS = previousMs;
  }
}
