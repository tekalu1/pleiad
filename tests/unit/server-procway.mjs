// procway バックエンドを、**本物の procway-code serve を起こして**通す。
//
// LLM は使わない。使い捨ての cwd に `.procway/ai-agent/settings.json` を書き、
// provider を `cli-agent`（= tests/lib/echo-agent.mjs）にする。procway 側の
// serve / WS ブリッジ / セッション永続化・resume は本物のまま回るので、
// 「agent-host のクライアント実装が host-contract に合っているか」が測れる。
//
// **測れないもの**: cli-agent は「1 往復のテキスト生成器」で toolCalls を返さない
// （ai-agent/src/providers/cli-agent.mjs — toolCalls は常に []）。したがって
// ツール承認（approval.requested -> approve）と park の往復、`tool.start` /
// `tool.result` の正規化は、このテストでは 1 度も踏まない。そこは実機確認の担当。
//
// procway-code が無い環境では **skip ではなく失敗**にする。黙って通ると
// 「テストが緑なのにバックエンドが動かない」が起きる。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT, PROCWAY_CLI } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { checkFork } from "../lib/fork-contract.mjs";

export const name = "server-procway";
export const title = "本物の procway-code serve と往復する";

const CLI = PROCWAY_CLI;
const ECHO = path.join(ROOT, "tests", "lib", "echo-agent.mjs");

const textOf = (turn) => turn.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");

/** agent-host のログに出る `procway: serve を起動した pid=…` から孫プロセスを拾う。 */
function servePids(tailText) {
  return [...String(tailText).matchAll(/procway: serve を起動した pid=(\d+)/g)].map((m) => Number(m[1]));
}

export default async function (t) {
  const exists = await fs.stat(CLI).then((s) => s.isFile()).catch(() => false);
  if (!exists) {
    t.ok(`procway-code の cli.mjs がある: ${CLI}`, false,
      "AGENT_HOST_PROCWAY_CODE で procway-code の src/cli.mjs を指すか、temporary/procway-code に置くこと");
    return;
  }

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-pw-")));
  const home = path.join(scratch, "home");       // ~/.procway をここへ逃がす
  const cwd = path.join(scratch, "work");        // セッションの作業ディレクトリ
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(cwd, ".procway", "ai-agent"), { recursive: true });

  // provider は cli-agent。**stdinMode は既定（プロンプトを stdin に流す）**にする。
  // 付録 A.9 の例は args に "{prompt}" を置いて stdinMode:"none" にしているが、
  // Windows の cli-agent は cmd.exe 経由で叩くので、改行を含む flatten 済み
  // トランスクリプトをコマンドラインに載せられない（cmd がそこで切る）。
  await fs.writeFile(
    path.join(cwd, ".procway", "ai-agent", "settings.json"),
    JSON.stringify({
      defaultProvider: "test",
      approvalMode: "auto-readonly",
      providers: {
        test: { type: "cli-agent", command: process.execPath, args: [ECHO] },
      },
      agents: { defaultTimeoutMs: 60_000 },
      session: { autoCompact: { enabled: false } },
    }, null, 2),
    "utf8",
  );

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "procway,fake",
      AGENT_HOST_PROCWAY_CODE: CLI,
      AGENT_HOST_PROCWAY_HOME: home,
    },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });

  const c = await open({ port: server.port, token: server.token, autoAllow: true });

  try {
    // ---- バックエンドの申告
    const backends = await c.cmd("backends");
    t.ok("procway と引き継ぎ用 fake が有効になる", backends.length === 2 && backends[0].id === "procway",
      backends.map((b) => b.id).join(",") || "(なし)");
    t.ok("タイトル / 状態は sidecar が正本と申告する",
      backends[0].capabilities?.title === false && backends[0].capabilities?.tag === false,
      JSON.stringify(backends[0].capabilities));
    t.ok("ログインを持つと申告する", backends[0].capabilities?.login === true);
    t.ok("procway のツール名のヒントが付く", backends[0].toolHints?.run_shell?.shape === "shell",
      JSON.stringify(backends[0].toolHints?.run_shell ?? null));

    const modes = await c.cmd("modes", { backend: "procway" });
    t.ok("承認モードは procway の語彙",
      Boolean(modes["always-ask"] && modes["auto-readonly"] && modes["full-auto"]),
      Object.keys(modes).join(","));

    const models = await c.cmd("models", { backend: "procway" });
    t.ok("モデル一覧は既定だけでも返る", "" in models, Object.keys(models).join(",") || "(なし)");

    // ---- 未ログインの申告（ここではログインしない）
    const auth = await c.cmd("authStatus", { backend: "procway" });
    t.ok("authStatus が supported を返す", auth.supported === true, JSON.stringify(auth));
    t.ok("使い捨ての home では未ログイン", auth.loggedIn === false, JSON.stringify(auth));

    // ---- 1ターン目（新規）。ここで serve が起きる
    const { sessionId: autoId } = await c.cmd("newSession", { backend: "procway", cwd });
    await c.runTurn({ sessionId: autoId, prompt: "タイトル自動設定の確認", cwd }, { ms: 120_000 });
    const autoTitle = (await c.cmd("listSessions")).find(s => s.id === autoId)?.title;
    t.ok("procway も初回送信で仮タイトルを置き換える", autoTitle === "タイトル自動設定の確認", autoTitle);
    const first = await c.runTurn(
      { prompt: "こんにちは", sessionId: null, cwd, backend: "procway" },
      { ms: 120_000 },
    );
    const sid = first.sessionId;
    t.ok("新規セッションの id が session イベントで来る", Boolean(sid), sid ?? "(なし)");
    t.ok("id は agent-host が決めたもの", /^pw-[0-9a-z]+-[0-9a-f]{8}$/.test(String(sid)), String(sid));
    t.ok("新規の session には first が付く",
      first.events.some((e) => e.type === "session" && e.first === true));
    t.ok("本文が text.delta で流れる", textOf(first).includes("echo-agent: こんにちは"),
      JSON.stringify(textOf(first)));
    t.ok("turnResult が ok で終わる", first.outcome === "ok", String(first.outcome));
    t.ok("turnResult は 1 回だけ",
      first.events.filter((e) => e.type === "turnResult").length === 1,
      String(first.events.filter((e) => e.type === "turnResult").length));

    // ---- タイトル候補。会話の接続先（ここでは echo-agent）で生成し、fake には代行させない
    t.ok("タイトル生成に対応すると申告する", backends[0].capabilities?.suggestTitle === true,
      JSON.stringify(backends[0].capabilities));
    const before = (await c.cmd("listSessions")).length;
    const suggested = await c.cmd("suggestTitle", { sessionId: sid });
    t.ok("procway の接続先でタイトルを生成する", /^echo-agent: .*こんにちは/.test(suggested.title), suggested.title);
    t.ok("タイトル生成で会話を増やさない", (await c.cmd("listSessions")).length === before);

    // ---- 一覧（index.json を直接読んでいる）
    const list = await c.cmd("listSessions");
    const row = list.find((s) => s.id === sid);
    t.ok("自分が作ったセッションが一覧に出る", Boolean(row), sid ?? "(なし)");
    t.ok("一覧に backend が付く", row?.backend === "procway", row?.backend ?? "(なし)");
    t.ok("一覧に cwd が乗る", path.resolve(row?.cwd ?? "") === path.resolve(cwd), row?.cwd ?? "(なし)");
    t.ok("procway が付けたタイトルが読める", typeof row?.title === "string" && row.title !== "(no title)",
      row?.title ?? "(なし)");

    // ---- 履歴（snapshot.json の生メッセージ）
    const loaded = await c.cmd("loadSession", { sessionId: sid });
    t.ok("履歴が読み直せる", loaded.messages.length >= 2, `${loaded.messages.length} 件`);
    t.ok("system プロンプトは履歴に出さない",
      loaded.messages.every((m) => m.role === "user" || m.role === "assistant"),
      loaded.messages.map((m) => m.role).join(","));
    t.ok("人間の発言が残る", loaded.messages.some((m) => m.role === "user" && m.text === "こんにちは"));
    t.ok("応答が残る", loaded.messages.some((m) => m.role === "assistant" && m.text.includes("echo-agent:")));

    // ---- 2ターン目（再開）。同じ WS を使い回す
    const second = await c.runTurn({ prompt: "もう一度", sessionId: sid, cwd }, { ms: 120_000 });
    t.ok("再開ターンも通る", second.outcome === "ok", String(second.outcome));
    t.ok("再開ターンの本文", textOf(second).includes("echo-agent: もう一度"), JSON.stringify(textOf(second)));
    t.ok("再開ターンでは session イベントを出さない",
      !second.events.some((e) => e.type === "session"),
      second.events.filter((e) => e.type === "session").length + " 件");

    const grown = await c.cmd("loadSession", { sessionId: sid });
    t.ok("履歴が積み上がる", grown.messages.length > loaded.messages.length,
      `${loaded.messages.length} -> ${grown.messages.length}`);

    // ---- 別エンジンを経由して戻る。procway の保存と読み出しは実物。
    await checkFork(t, c, { id: sid, cwd, firstText: "こんにちは", laterText: "もう一度" });
    await c.cmd("switchBackend", { sessionId: sid, backend: "fake" });
    await c.runTurn({ sessionId: sid, prompt: "echo:via fake" });
    await c.cmd("switchBackend", { sessionId: sid, backend: "procway" });
    const back = await c.runTurn({ sessionId: sid, prompt: "戻って継続" }, { ms: 120_000 });
    t.ok("procway へ戻っても同じチャットで完了", back.outcome === "ok" && back.events.every(e => !e.sessionId || e.sessionId === sid));
    const continued = await c.cmd("loadSession", { sessionId: sid });
    t.ok("procway の往復でユーザー履歴を保つ", continued.messages.filter(m => m.role === "user").map(m => m.text).join("|") === "こんにちは|もう一度|echo:via fake|戻って継続");

    // ---- 中断
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "slow ずっと待つ", sessionId: null, cwd, backend: "procway" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session" && e.first, { ms: 60_000, from: mark });
    const stopped = await c.cmd("abort", { sessionId: started.sessionId });
    t.ok("中断を受け付ける", stopped.aborted === 1, JSON.stringify(stopped));
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 60_000, from: mark });
    t.ok("中断は turnResult aborted で伝わる",
      c.since(mark).some((e) => e.type === "turnResult" && e.outcome === "aborted"),
      JSON.stringify(c.since(mark).filter((e) => e.type === "turnResult")));
  } finally {
    c.close();
    const pids = servePids(server.tail(400));
    await server.stop();
    // Windows の kill() は TerminateProcess なので、agent-host が抱えていた
    // serve（孫）は残る。テストが自分で片付ける。
    for (const pid of pids) { try { process.kill(pid); } catch { /* もう居ない */ } }
    if (process.env.AGENT_HOST_KEEP_SCRATCH) t.note(`使い捨てを残した: ${scratch}`);
    else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
