// codex バックエンドを server 越しに通すテスト。**本物の codex は起動しない。**
//
// AGENT_HOST_CODEX_BIN に `node tests/lib/fake-codex.mjs` を渡すと、
// core/backends/codex-rpc.mjs は「app-server の形を真似た子プロセス」と話す。
// つまり測っているのは JSON-RPC の張り方と、通知 -> 正規化イベントの写し替えと、
// 承認の decision の戻し方であって、codex そのものではない。
//
// 本物との差が出るのは「スキーマに書いてあるが fake が出さない通知」だけなので、
// fake の method 名・フィールド名・enum は temporary/codex-schema/ から取っている。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-codex";
export const title = "codex バックエンドが app-server 越しに往復する";

const textOf = (turn) => turn.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-codex-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-codex.mjs");

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "codex",
      FAKE_CODEX_CHECK_TITLE: "1",
      // 空白を含むパスでも壊れないよう、クォート付きで渡す（codex-rpc の parseCommand が外す）
      AGENT_HOST_CODEX_BIN: `node "${fake}"`,
    },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });

  const asked = [];
  const c = await open({
    port: server.port,
    token: server.token,
    onEvent: async (ev, self) => {
      if (ev.type !== "permission") return;
      asked.push(ev);
      if (ev.kind === "question") {
        const answers = Object.fromEntries((ev.questions ?? []).map((q) => [q.question, q.options?.[0]?.label ?? ""]));
        await self.cmd("resolvePermission", { id: ev.id, allow: true, answers }).catch(() => {});
      } else {
        await self.cmd("resolvePermission", { id: ev.id, allow: true, always: true }).catch(() => {});
      }
    },
  });

  try {
    // ---- 申告
    const backends = await c.cmd("backends");
    const b = backends[0];
    t.ok("codex だけが有効になる", backends.length === 1 && b.id === "codex",
         backends.map((x) => x.id).join(",") || "(なし)");
    t.ok("状態タグは持てないと申告する", b.capabilities?.tag === false && b.capabilities?.title === true,
         JSON.stringify({ tag: b.capabilities?.tag, title: b.capabilities?.title }));
    t.ok("分岐とログインができると申告する", b.capabilities?.fork === true && b.capabilities?.login === true);
    t.ok("host ツールは持たない", b.capabilities?.hostTools === false);
    t.ok('バックグラウンド端末の詳細と停止を提供する', b.capabilities.backgroundDetails === true && b.capabilities.stopBackground === true);
    t.ok("アイテム名の表示ヒントが付く", b.toolHints?.commandExecution?.shape === "shell",
         JSON.stringify(b.toolHints?.commandExecution ?? null));

    // ---- 語彙（approvalPolicy × sandbox の4つ / model/list）
    const modes = await c.cmd("modes", { backend: "codex" });
    t.ok("承認モードが5つ出る",
      ["ask", "auto", "full", "yolo", "readonly"].every((k) => modes[k]?.label),
      Object.keys(modes).join(","));

    const models = await c.cmd("models", { backend: "codex" });
    t.ok("model/list からモデルが来る", "" in models && "fake-model-1" in models, Object.keys(models).join(","));
    t.ok("model/list の 2 ページ目（nextCursor の先）も読む", "gpt-5.6-luna" in models, Object.keys(models).join(","));
    t.ok("hidden なモデルは出さない", !("fake-hidden" in models), Object.keys(models).join(","));
    t.ok("既定（''）は config/read の model に解決され、その段と既定の段を持つ",
      models[""].resolvesTo === "fake-model-1" && models[""].defaultEffort === "medium" && models[""].efforts?.includes("high"),
      JSON.stringify(models[""]));

    // ---- 1ターン目（新規）。承認を1往復する
    const before = asked.length;
    const first = await c.runTurn(
      { prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "codex", mode: "ask" },
      { ms: 30_000 },
    );
    const sid = first.sessionId;
    t.ok("thread/start の id が session イベントで来る", Boolean(sid), sid ?? "(なし)");
    const sessionEvents = first.events.filter((e) => e.type === "session");
    t.ok("id 確定の session は first 付きで1本だけ",
      sessionEvents.length === 1 && sessionEvents[0].first === true && Boolean(sessionEvents[0].sessionId),
      JSON.stringify(sessionEvents));
    t.ok("本文が text.delta で流れる", textOf(first) === "了解: こんにちは", JSON.stringify(textOf(first)));
    t.ok("思考が thinking.start / delta に写る",
      first.events.some((e) => e.type === "thinking.start")
        && first.events.some((e) => e.type === "thinking.delta" && e.text === "考えている"));

    t.ok("item/started が tool.start になる", first.tools.join(",") === "commandExecution",
         first.tools.join(",") || "(なし)");
    t.ok("承認が1件来る", asked.length - before === 1, `${asked.length - before} 件`);
    t.ok("承認は kind:tool で常に許可も選べる",
      asked.at(-1)?.kind === "tool" && asked.at(-1)?.canAlways === true,
      JSON.stringify({ kind: asked.at(-1)?.kind, canAlways: asked.at(-1)?.canAlways }));
    t.ok("承認カードにコマンドが載る", asked.at(-1)?.input?.command === "echo hi",
         JSON.stringify(asked.at(-1)?.input ?? null));
    // acceptForSession が codex まで届いたなら、コマンドは走って exit=0 が返る
    t.ok("acceptForSession が届いて item/completed が tool.result になる",
      first.events.some((e) => e.type === "tool.result" && e.text.includes("hi") && e.isError === false),
      JSON.stringify(first.events.find((e) => e.type === "tool.result") ?? null));
    t.ok("turn/completed が turnResult ok になる", first.outcome === "ok", String(first.outcome));
    t.ok("costUsd は出さない（codex は token しか返さない）",
      first.events.find((e) => e.type === "turnResult")?.costUsd === undefined);

    const countBeforeTitle = (await c.cmd("listSessions")).length;
    const approvalsBeforeTitle = asked.length;
    const suggestion = await c.cmd("suggestTitle", { sessionId: sid });
    // Luna は model/list の 2 ページ目にだけ居る。fake（FAKE_CODEX_CHECK_TITLE）が Luna / low 以外を撥ねる
    t.ok("Codex generates a title with Luna/low, independently of the conversation and native defaults", b.capabilities.suggestTitle && Boolean(suggestion.title));
    t.ok("Title does not add sessions", (await c.cmd("listSessions")).length === countBeforeTitle);
    t.ok("Title does not ask user permission", asked.length === approvalsBeforeTitle);
    await c.cmd("setPref", { key: "backend", value: "codex" });
    await c.cmd("setPref", { key: "mode", value: "readonly", backend: "codex" });
    await c.cmd("setPref", { key: "model", value: "", backend: "codex" });
    const prefs = await c.cmd("prefs");
    t.ok("Backend preferences are persisted", prefs.backend === "codex" && prefs.backends.codex.mode === "readonly" && prefs.backends.codex.model === "");

    // ---- 一覧と履歴
    const row = (await c.cmd("listSessions")).find((s) => s.id === sid);
    t.ok("一覧に backend が付く", row?.backend === "codex", row?.backend ?? "(なし)");
    t.ok("一覧に cwd が乗る", row?.cwd === ROOT, row?.cwd ?? "(なし)");
    // codex の Thread の時刻は**秒**（スキーマは int64 としか言わない）。
    // ms として読むと一覧が全部 1970 年になり、並び順も日付表示も壊れる
    t.ok("秒で来る時刻を ms に直す",
      Math.abs((row?.lastModified ?? 0) - Date.now()) < 60_000
        && new Date(row?.createdAt ?? 0).getUTCFullYear() > 2020,
      `lastModified=${row?.lastModified} createdAt=${row?.createdAt}`);

    const loaded = await c.cmd("loadSession", { sessionId: sid });
    const user = loaded.messages.find((m) => m.role === "user");
    const assistant = loaded.messages.find((m) => m.role === "assistant" && m.text);
    t.ok("thread/read の turns が履歴になる",
      user?.text === "こんにちは" && assistant?.text === "了解: こんにちは",
      `${loaded.messages.length} 件`);
    t.ok("履歴にツール呼び出しが畳まれる",
      assistant?.toolCalls?.[0]?.name === "commandExecution" && Boolean(assistant?.toolCalls?.[0]?.result),
      JSON.stringify(assistant?.toolCalls?.[0] ?? null));
    t.ok("履歴に思考が残る", assistant?.thinking === "考えている", JSON.stringify(assistant?.thinking ?? null));

    // ---- 質問（承認ではなく回答）。再開ターンなので session イベントは出ない
    const q = await c.runTurn({ prompt: "question", sessionId: sid, cwd: ROOT }, { ms: 30_000 });
    t.ok("再開ターンは session を出さない",
      q.events.every((e) => e.type !== "session"),
      JSON.stringify(q.events.filter((e) => e.type === "session")));
    const qEv = asked.at(-1);
    t.ok("requestUserInput が kind:question になる", qEv?.kind === "question", String(qEv?.kind));
    t.ok("選択肢がそのまま乗る", qEv?.questions?.[0]?.options?.[0]?.label === "A",
         JSON.stringify(qEv?.questions?.[0]?.options ?? null));
    t.ok("回答が質問 id 付きで codex へ戻る", textOf(q) === "回答: A", JSON.stringify(textOf(q)));

    // ---- サブエージェント（子スレッド）の承認。子の threadId で来るが、親の会話に出る
    const beforeSub = asked.length;
    const sub = await c.runTurn({ prompt: "subagent", sessionId: sid, cwd: ROOT }, { ms: 30_000 });
    const subEv = asked.at(-1);
    t.ok("子の承認が親の会話に 1 件出る",
      asked.length - beforeSub === 1 && subEv?.sessionId === sid, JSON.stringify({ n: asked.length - beforeSub, sessionId: subEv?.sessionId }));
    t.ok("子の承認カードにサブエージェントの名前が付く",
      subEv?.title === "サブエージェント csv_fixture_research" && subEv?.input?.command === "npm test",
      JSON.stringify({ title: subEv?.title, input: subEv?.input }));
    t.ok("子への答えが codex へ戻る", textOf(sub) === "子の承認: acceptForSession", JSON.stringify(textOf(sub)));
    // 親の筋に出るのは親の items（委譲の記録）だけ。子の commandExecution はカードにならない
    t.ok("子の本文とツールは親の会話に混ざらない",
      !textOf(sub).includes("子の本文")
        && sub.tools.every((name) => name === "subAgentActivity" || name === "collabAgentToolCall"),
      JSON.stringify(sub.tools));

    // ---- サブエージェント一覧（running.subagents / loadSubagent）
    t.ok("サブエージェントを持てると申告し、委譲の 2 種を委譲カードで描く",
      b.capabilities?.subagents === true
        && b.toolHints?.subAgentActivity?.shape === "delegate" && b.toolHints?.collabAgentToolCall?.shape === "delegate",
      JSON.stringify({ subagents: b.capabilities?.subagents, hints: [b.toolHints?.subAgentActivity, b.toolHints?.collabAgentToolCall] }));
    const card = sub.events.find((e) => e.type === "tool.start" && e.name === "subAgentActivity");
    t.ok("委譲カードの見出しは agent_path から /root/ を外したもの",
      card?.input?.description === "csv_fixture_research", JSON.stringify(card?.input ?? null));
    const spawnCard = sub.events.find((e) => e.type === "tool.start" && e.name === "collabAgentToolCall");
    t.ok("collabAgentToolCall のカードには渡した指示（prompt）が載る",
      spawnCard?.input?.prompt === "CSV を調べて" && Boolean(spawnCard?.input?.description), JSON.stringify(spawnCard?.input ?? null));
    const doneCard = sub.events.filter((e) => e.type === "tool.start" && e.name === "subAgentActivity").at(-1);
    t.ok("完了の記録は見出しに（完了）が付く",
      doneCard?.input?.description === "csv_fixture_research（完了）", JSON.stringify(doneCard?.input ?? null));

    const slowMark = c.mark();
    c.cmd("runTurn", { prompt: "subagent-slow", sessionId: null, cwd: ROOT, backend: "codex", mode: "ask" }).catch(() => {});
    const slowSession = (await c.waitFor((e) => e.type === "session", { ms: 30_000, from: slowMark })).sessionId;
    // 行は子が生まれた時点で載り、子の発言はその後に書き足される。3 件そろうまで待つ
    let subRow = null;
    for (let i = 0; i < 200 && subRow?.messages !== 3; i += 1) {
      subRow = (await c.cmd("running")).subagents?.find((a) => a.sessionId === slowSession) ?? null;
      if (subRow?.messages !== 3) await new Promise((r) => setTimeout(r, 25));
    }
    t.ok("走っている子が running.subagents に 1 件載る", Boolean(subRow), JSON.stringify(subRow));
    t.ok("行の見出しは生んだ委譲カードの description（子の発言ではない）",
      subRow?.description === "csv_fixture_research", String(subRow?.description));
    t.ok("行に子のメッセージ数と最終時刻が付く",
      subRow?.messages === 3 && Boolean(subRow?.lastAt), JSON.stringify({ messages: subRow?.messages, lastAt: subRow?.lastAt }));
    const subLoaded = await c.cmd("loadSubagent", { sessionId: slowSession, agentId: subRow?.id });
    t.ok("loadSubagent で子の会話が読める",
      subLoaded.messages.map((m) => m.text).join("|") === "受け取った|子の本文|報告: ok"
        && subLoaded.messages[1]?.toolCalls?.[0]?.name === "commandExecution",
      JSON.stringify(subLoaded.messages.map((m) => m.text)));
    const badId = await c.cmd("loadSubagent", { sessionId: slowSession, agentId: "../th_1" });
    t.ok("形の違う agentId は読まない", badId.messages.length === 0, JSON.stringify(badId.messages));
    await c.cmd("abort", { sessionId: slowSession });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === slowSession, { ms: 30_000, from: slowMark });
    const afterRun = await c.cmd("running");
    t.ok("親のターンが終われば一覧から消える",
      !(afterRun.subagents ?? []).some((a) => a.sessionId === slowSession), JSON.stringify(afterRun.subagents));

    // ---- タイトル（ネイティブ）と状態（sidecar が正本）
    await c.cmd("setTitle", { sessionId: sid, title: "codex の会話", reason: "手動" });
    await c.cmd("setStatus", { sessionId: sid, status: "進行中", reason: "手動" });
    const after = (await c.cmd("listSessions")).find((s) => s.id === sid);
    t.ok("thread/name/set が一覧に反映される", after?.title === "codex の会話", after?.title ?? "(なし)");
    t.ok("状態は sidecar から読める", after?.status === "進行中", after?.status ?? "(なし)");

    // ---- 分岐
    const forked = await c.cmd("fork", { sessionId: sid });
    const child = (await c.cmd("listSessions")).find((s) => s.id === forked.sessionId);
    t.ok("共通 fork で分岐先ができる", Boolean(child), forked.sessionId ?? "(なし)");
    t.ok("分岐の親が記録される", child?.parent?.sessionId === sid, child?.parent?.sessionId ?? "(なし)");

    // ---- 中断（turn/interrupt -> status interrupted）
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "slow", sessionId: null, cwd: ROOT, backend: "codex" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session", { ms: 30_000, from: mark });
    const stopped = await c.cmd("abort", { sessionId: started.sessionId });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 30_000, from: mark });
    t.ok("中断を受け付ける", stopped.aborted === 1, JSON.stringify(stopped));
    t.ok("interrupted が turnResult aborted になる",
      c.since(mark).some((e) => e.type === "turnResult" && e.outcome === "aborted"),
      JSON.stringify(c.since(mark).filter((e) => e.type === "turnResult")));

    // ---- 認証
    const auth = await c.cmd("authStatus", { backend: "codex" });
    t.ok("account/read がログイン状態を返す",
      auth.supported === true && auth.loggedIn === true && auth.account === "tester@example.invalid",
      JSON.stringify(auth));

    const out = await c.cmd("authLogout", { backend: "codex" });
    t.ok("ログアウトできる", out.loggedIn === false, JSON.stringify(out));

    const at = c.mark();
    const logged = await c.cmd("authLogin", { backend: "codex" });
    t.ok("authUrl が auth イベントでリンクとして出る",
      c.since(at).some((e) => e.type === "auth" && e.phase === "url"
        && String(e.url).startsWith("https://") && e.backend === "codex"),
      JSON.stringify(c.since(at).filter((e) => e.type === "auth")));
    t.ok("login/completed を待ってから応答が返る", logged.loggedIn === true, JSON.stringify(logged));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
