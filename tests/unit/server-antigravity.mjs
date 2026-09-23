// antigravity バックエンドを server 越しに通すテスト。**本物の agy は起動しない。**
//
// AGENT_HOST_AGY_BIN に `node tests/lib/fake-agy.mjs` を渡すと、
// core/backends/antigravity-cli.mjs は「ヘッドレスの stream-json を真似た子プロセス」と話す。
// つまり測っているのは NDJSON の張り方と、step_update -> 正規化イベントの写し替えと、
// 控えの書き出しであって、agy そのものではない。
//
// このバックエンドは**持てないものが多い**ので、持てないことも測る:
// 対話承認が無い / 思考が流れない。
//
// 実機で踏んだ穴（docs/multi-backend.md §2.8）もここで塞いだままにする:
// ツールの ACTIVE / DONE を分けること、出力の打ち切りを成功と取り違えないこと、
// 打ち切った agy を残さないこと、`--print-timeout` を渡すこと。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { checkFork } from "../lib/fork-contract.mjs";

export const name = "server-antigravity";
export const title = "antigravity バックエンドが agy のヘッドレス越しに往復する";

const textOf = (turn) => turn.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const dataDir = path.join(scratch, "data");
  const argsFile = path.join(scratch, "agy-args.json");
  const pidFile = path.join(scratch, "agy-pids.json");

  const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, "utf8").catch(() => fallback));
  /** 身代わりが起きた順の pid（fake-agy.mjs が控える）。 */
  const spawned = () => readJson(pidFile, "[]");
  /** Pleiad が「生かしている」と控えた pid（孤児の掃除に使う控え）。 */
  const recorded = async () => (await readJson(path.join(dataDir, "antigravity", "pids.json"), "[]")).map((e) => e.pid);
  /** その pid が居なくなるまで待つ（落とすのは非同期）。 */
  const gone = async (pid) => {
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      AGENT_HOST_AGY_BIN: `node "${fake}"`,
      FAKE_AGY_ARGS_FILE: argsFile,
      FAKE_AGY_PID_FILE: pidFile,
    },
    dataDir,
    timeoutMs: 30_000,
  });

  const asked = [];
  const c = await open({
    port: server.port,
    token: server.token,
    onEvent: async (ev, self) => {
      if (ev.type !== "permission") return;
      asked.push(ev);
      await self.cmd("resolvePermission", { id: ev.id, allow: true }).catch(() => {});
    },
  });

  try {
    // ---- 申告。持てないものを「持てない」と言う
    const backends = await c.cmd("backends");
    const b = backends[0];
    t.ok("antigravity だけが有効になる", backends.length === 1 && b.id === "antigravity",
         backends.map((x) => x.id).join(",") || "(なし)");
    t.ok("タイトルも状態タグも持てないと申告する",
      b.capabilities?.title === false && b.capabilities?.tag === false,
      JSON.stringify({ title: b.capabilities?.title, tag: b.capabilities?.tag }));
    // agy には対話承認そのものが無い。「常に許可」も出せない
    t.ok("常に許可は出せないと申告する", b.capabilities?.alwaysAllow === false, String(b.capabilities?.alwaysAllow));
    t.ok("実行中のモード・モデル切り替えはできないと申告する",
      b.capabilities?.liveMode === false && b.capabilities?.liveModel === false,
      JSON.stringify({ liveMode: b.capabilities?.liveMode, liveModel: b.capabilities?.liveModel }));
    t.ok("ログインはできると申告する", b.capabilities?.login === true, String(b.capabilities?.login));

    // ---- 語彙。**選べるのは「全部自動」だけ。**
    // agy のヘッドレスは --dangerously-skip-permissions 以外だとツールを soft-deny するので、
    // plan / accept-edits を出すと「選んだのに黙って何もできない」になる
    const modes = await c.cmd("modes", { backend: "antigravity" });
    t.ok("承認モードは全部自動の1つだけ",
      Object.keys(modes).join(",") === "yolo" && Boolean(modes.yolo?.label),
      Object.keys(modes).join(","));

    // ---- ログイン判定。`agy models` に聞く（資格情報は OS の資格情報ストアにあって読めない）
    const auth = await c.cmd("authStatus", { backend: "antigravity" });
    t.ok("models が引けたらログイン済みと分かる",
      auth.supported === true && auth.installed === true && auth.loggedIn === true,
      JSON.stringify(auth));

    // 引けたモデルは models 一覧にも出る
    const models = await c.cmd("models", { backend: "antigravity" });
    t.ok("agy models の結果がモデル一覧になる",
      "" in models && "fake-antigravity-1" in models, Object.keys(models).join(","));
    // 表示名を使い、段違い（-high / -low）は 1 つの系統にまとめる。既定は agy のログ（--log-file）から読む
    t.ok("表示名がモデルの名前になり、段違いは系統の名前になる",
      models["fake-antigravity-1"]?.label === "Fake Antigravity 1" && models["fake-flash-high"]?.label === "Fake Flash"
        && models["fake-flash-low"]?.hidden === true && !models["fake-flash-high"]?.hidden,
      JSON.stringify(models));
    t.ok("agy の既定のモデルに解決される", models[""]?.resolvesTo === "fake-flash-high", JSON.stringify(models[""]));
    const agyEfforts = await c.cmd("efforts", { backend: "antigravity", model: "" });
    t.ok("既定のモデルの段が選べ、その段に既定の印が付く",
      JSON.stringify(Object.keys(agyEfforts)) === '["","low","high"]' && agyEfforts[""].resolvesTo === "high" && agyEfforts.high?.isDefault === true,
      JSON.stringify(agyEfforts));
    const lowEfforts = await c.cmd("efforts", { backend: "antigravity", model: "fake-flash-low" });
    t.ok("段違いの id を選んでいれば、その id の段が今の段", lowEfforts[""].resolvesTo === "low", JSON.stringify(lowEfforts[""]));
    const single = await c.cmd("efforts", { backend: "antigravity", model: "fake-antigravity-2" });
    t.ok("段違いの無いモデルは段を選べない", JSON.stringify(Object.keys(single)) === '[""]', JSON.stringify(single));

    // ---- 1ターン目（新規）
    const first = await c.runTurn(
      { prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" },
      { ms: 60_000 },
    );
    const sid = first.sessionId;
    t.ok("init の conversation_id が session イベントで来る", Boolean(sid), sid ?? "(なし)");
    const argvList = JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]"));
    const sessionArgs = argvList.find((args) => args.some((a) => a.startsWith("--print"))) ?? [];
    const addDirIdx = sessionArgs.indexOf("--add-dir");
    t.ok("agy 起動引数に --add-dir で作業ディレクトリが渡される",
      addDirIdx >= 0 && sessionArgs[addDirIdx + 1] === ROOT,
      JSON.stringify(sessionArgs));
    // 既定の 5m0s は長いターンを空の SUCCESS で打ち切る。明示的に長い値を渡す
    const timeoutIdx = sessionArgs.indexOf("--print-timeout");
    t.ok("agy 起動引数に --print-timeout が渡される",
      timeoutIdx >= 0 && /^\d/.test(String(sessionArgs[timeoutIdx + 1] ?? "")),
      JSON.stringify(sessionArgs.slice(timeoutIdx, timeoutIdx + 2)));
    t.ok("既定のモデル・段のままなら --model も --effort も渡さない",
      !sessionArgs.includes("--model") && !sessionArgs.includes("--effort"), JSON.stringify(sessionArgs));
    const sessionEvents = first.events.filter((e) => e.type === "session");
    t.ok("id 確定の session は first 付きで1本だけ",
      sessionEvents.length === 1 && sessionEvents[0].first === true,
      JSON.stringify(sessionEvents));

    // 本文は真のデルタで流れる（ここが agy を選ぶ理由）
    t.ok("text_delta が text.delta で流れる", textOf(first) === "了解: こんにちは", JSON.stringify(textOf(first)));
    t.ok("デルタが複数回に分かれて届く",
      first.events.filter((e) => e.type === "text.delta").length > 1,
      `${first.events.filter((e) => e.type === "text.delta").length} 回`);

    // 持てないもの
    t.ok("思考は流れない（agy は逐次の reasoning を出さない）",
      first.events.every((e) => e.type !== "thinking.start" && e.type !== "thinking.delta"));
    t.ok("承認は聞かれない（agy に対話承認が無い）", asked.length === 0, `${asked.length} 件`);

    // ツールは同じ step_index で ACTIVE -> DONE の 2 回来る。**分けて 1 件にする**
    t.ok("tool_name が tool.start になる", first.tools.join(",") === "run_command",
         first.tools.join(",") || "(なし)");
    const starts = first.events.filter((e) => e.type === "tool.start");
    const results = first.events.filter((e) => e.type === "tool.result");
    t.ok("ACTIVE と DONE でツールが二重にならない",
      starts.length === 1 && results.length === 1,
      `start ${starts.length} 件 / result ${results.length} 件`);
    t.ok("開始が先、完了が後に出る",
      first.events.indexOf(starts[0]) < first.events.indexOf(results[0]),
      `${first.events.indexOf(starts[0])} -> ${first.events.indexOf(results[0])}`);
    t.ok("開始と完了は同じ id で結びつく", starts[0]?.id && starts[0].id === results[0]?.id,
         `${starts[0]?.id} / ${results[0]?.id}`);
    // ACTIVE の時点で「実行中」が出る（他のバックエンドと同じ見た目になる）
    t.ok("ツールの開始で実行中が出る",
      first.events.some((e) => e.type === "activity" && e.state === "running"),
      JSON.stringify(first.events.filter((e) => e.type === "activity").map((e) => e.state)));
    t.ok("DONE の出力が tool.result になる",
      results[0]?.text?.includes("hello") && results[0]?.isError === false,
      JSON.stringify(results[0] ?? null));
    t.ok("ツールのパラメータが tool.start に載る",
      starts[0]?.input?.CommandLine === "echo hello",
      JSON.stringify(starts[0]?.input ?? null));

    t.ok("status SUCCESS が turnResult ok になる", first.outcome === "ok", String(first.outcome));
    t.ok("result の usage がトークン数になる",
      first.events.some((e) => e.type === "usage" && e.inputTokens === 11 && e.outputTokens === 7),
      JSON.stringify(first.events.find((e) => e.type === "usage") ?? null));

    // ---- 控え。**agy に一覧も履歴も無いので Pleiad が書く**
    const rows = await c.cmd("listSessions");
    const row = rows.find((s) => s.id === sid);
    t.ok("控えから一覧に出る", Boolean(row), sid ?? "(なし)");
    // 同じ置き場に pid の控え（pids.json）も入る。会話として拾わない
    t.ok("控えでないファイルは会話にしない", rows.every((s) => s.id !== "pids"),
         rows.map((s) => s.id).join(",") || "(なし)");
    t.ok("一覧に backend が付く", row?.backend === "antigravity", row?.backend ?? "(なし)");
    t.ok("一覧に cwd が乗る", row?.cwd === ROOT, row?.cwd ?? "(なし)");

    const stored = JSON.parse(
      await fs.readFile(path.join(dataDir, "antigravity", `${sid}.json`), "utf8"),
    );
    t.ok("控えは Pleiad の置き場に入る", stored.conversationId === sid && stored.messages.length === 2,
         `${stored.messages?.length} 件`);

    const loaded = await c.cmd("loadSession", { sessionId: sid });
    const user = loaded.messages.find((m) => m.role === "user");
    const assistant = loaded.messages.find((m) => m.role === "assistant" && m.text);
    t.ok("控えが履歴になる",
      user?.text === "こんにちは" && assistant?.text === "了解: こんにちは",
      `${loaded.messages.length} 件`);
    t.ok("履歴にツール呼び出しが畳まれる",
      assistant?.toolCalls?.length === 1 && assistant.toolCalls[0].name === "run_command"
        && assistant.toolCalls[0].result?.text.includes("hello"),
      JSON.stringify(assistant?.toolCalls ?? null));

    // ---- 2ターン目。**同じプロセスを使い回す**（1 プロセス = 1 会話）
    const second = await c.runTurn({ prompt: "つづき", sessionId: sid, cwd: ROOT }, { ms: 60_000 });
    t.ok("再開ターンは session を出さない",
      second.events.every((e) => e.type !== "session"),
      JSON.stringify(second.events.filter((e) => e.type === "session")));
    t.ok("同じ会話で続きが流れる", textOf(second) === "了解: つづき", JSON.stringify(textOf(second)));
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "antigravity", `${sid}.json`), "utf8"));
    t.ok("控えが積み増される", after.messages.length === 4, `${after.messages.length} 件`);

    // ---- 時刻。ユーザー発言は送信時、AI の発言は完了時（理由は core/backends/antigravity.mjs）。
    // 提示の並び、ひいては分岐の切り口に効くので番人を置く
    const sentBefore = Date.now();
    await c.runTurn({ prompt: "delay400", sessionId: sid, cwd: ROOT }, { ms: 60_000 });
    const timed = await c.cmd("loadSession", { sessionId: sid });
    const askedAt = new Date(timed.messages.at(-2).at).getTime();
    const repliedAt = new Date(timed.messages.at(-1).at).getTime();
    // 完了時刻でないことは下の repliedAt との差（delay400）で見る。ここで上限を置くと混んだ CI の起動遅れで揺れる
    t.ok("ユーザー発言は送信の時刻で残る", askedAt >= sentBefore, `送信から ${askedAt - sentBefore}ms`);
    t.ok("AI の発言は完了の時刻で残る", repliedAt - askedAt >= 300, `${repliedAt - askedAt}ms 後`);

    // ---- 分岐。**agy に分岐の口が無いので、ホストの写しで分ける**（docs/message-fork.md）。
    // 汎用経路に相乗りしているだけなので、他のバックエンドと同じ契約で測る
    await checkFork(t, c, { id: sid, cwd: ROOT, firstText: "こんにちは", laterText: "つづき" });

    // ---- 失敗
    const failed = await c.runTurn({ prompt: "fail", sessionId: sid, cwd: ROOT }, { ms: 60_000 })
      .catch((err) => ({ outcome: "error", error: String(err?.message ?? err) }));
    t.ok("status ERROR が turnResult error になる", failed.outcome === "error", String(failed.outcome));

    // ---- 出力の打ち切り（--print-timeout）。
    // 実機の agy は stderr に文言を出し、**本文が空のまま status:"SUCCESS"** を返す。
    // そのまま写すと「正常に終わったのに何も言わない」ターンになるので、失敗として畳む。
    // しかも agy は裏でターンを回し続けるので、そのプロセスは落とす
    const before = await spawned();
    const truncated = await c.runTurn({ prompt: "timeout", sessionId: null, cwd: ROOT, backend: "antigravity" }, { ms: 60_000 })
      .catch((err) => ({ outcome: "error", error: String(err?.message ?? err), events: [] }));
    const timedPid = (await spawned()).filter((p) => !before.includes(p)).at(-1) ?? null;
    t.ok("打ち切りのターンで agy が起きる", Number.isInteger(timedPid), String(timedPid));
    t.ok("空の SUCCESS を ok にしない", truncated.outcome === "error", String(truncated.outcome));
    t.ok("打ち切りだと分かる文面が出る",
      /打ち切/.test(truncated.events.find((e) => e.type === "turnResult")?.error ?? ""),
      JSON.stringify(truncated.events.find((e) => e.type === "turnResult")?.error ?? null));
    t.ok("打ち切った agy は落とす", await gone(timedPid), `pid ${timedPid}`);
    t.ok("落とした agy は pid の控えから消える",
      !(await recorded()).includes(timedPid), JSON.stringify(await recorded()));
    // 生きている agy は控えに残る（次の起動が孤児を掃除するため）
    t.ok("生きている agy の pid を控える", (await recorded()).length > 0, JSON.stringify(await recorded()));

    // ---- 段。agy の --effort は段違いの id を選ぶことと同じ。--model と同時に渡さず、段違いの id に解決する
    const beforeEffort = JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]")).length;
    const low = await c.runTurn({ prompt: "段", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", effort: "low" }, { ms: 60_000 });
    const lowArgs = JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]")).slice(beforeEffort).find((a) => a.some((x) => x.startsWith("--print"))) ?? [];
    t.ok("段を選ぶと、既定のモデルの段違いの id を --model に渡す（--effort は渡さない）",
      low.outcome === "ok" && lowArgs[lowArgs.indexOf("--model") + 1] === "fake-flash-low" && !lowArgs.includes("--effort"),
      JSON.stringify(lowArgs));

    // ---- 中断。プロトコルに中断が無いのでプロセスを落とす
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "slow", sessionId: null, cwd: ROOT, backend: "antigravity" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session", { ms: 60_000, from: mark });
    const stopped = await c.cmd("abort", { sessionId: started.sessionId });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 60_000, from: mark });
    t.ok("中断を受け付ける", stopped.aborted === 1, JSON.stringify(stopped));
    t.ok("落として aborted になる",
      c.since(mark).some((e) => e.type === "turnResult" && e.outcome === "aborted"),
      JSON.stringify(c.since(mark).filter((e) => e.type === "turnResult")));
  } finally {
    c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
