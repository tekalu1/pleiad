// core/server.mjs を丸ごと通すテスト。**LLM もネットワークも要らない。**
//
// AGENT_HOST_BACKENDS=fake でサーバを立てると、実行エンジンは core/backends/fake.mjs
// （台本を流すだけ）になる。SDK はそもそも読み込まれないので、
// 「server.mjs がバックエンド非依存になっているか」自体がこのテストで担保される。
//
// v1 では server.mjs のロジックに触れる手段が e2e（本物の LLM）しか無かった。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "server-fake";
export const title = "サーバ全体が LLM 無しで往復する";

/** そのターンで流れた本文（text.delta の積み上げ）。web が組み立てるものと同じ。 */
const textOf = (turn) => turn.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-fake-")));
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake" },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });

  // 承認は「何を聞かれたか」で返し分ける。質問には回答を、ツールには許可を返す。
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
    t.ok("protocolVersion 3 で握手する", c.ready.protocolVersion === 3, String(c.ready.protocolVersion));
    const absentBackground = await c.cmd('loadBackground', { sessionId: 'no-session', taskId: 'no-task' });
    t.ok('終了済みまたは存在しない裏の作業を読むとnullを返す', absentBackground.task === null);

    // ---- バックエンドの申告
    const backends = await c.cmd("backends");
    t.ok("backends が1つ返る", backends.length === 1 && backends[0].id === "fake",
         backends.map((b) => b.id).join(",") || "(なし)");
    t.ok("capabilities が付く", backends[0].capabilities?.fork === true && backends[0].capabilities?.hostTools === false);
    t.ok("toolHints が付く", Boolean(backends[0].toolHints?.fake_shell?.label),
         "web/render.mjs の TOOL_LABEL をこれで補う");

    const modes = await c.cmd("modes", { backend: "fake" });
    const models = await c.cmd("models", { backend: "fake" });
    t.ok("語彙はバックエンドから来る", Boolean(modes.auto) && "fast" in models,
         `${Object.keys(modes).join(",")} / ${Object.keys(models).join(",")}`);

    // ---- cwd 未指定の新規ターンはホームディレクトリで自動開始する
    const defaultTurn = await c.runTurn(
      { prompt: "echo:ホーム", sessionId: null, backend: "fake", mode: "default" },
      { ms: 20_000 },
    );
    t.ok("cwd 未指定の新規ターンはホームディレクトリで受け付ける", defaultTurn.outcome === "ok");
    t.ok('完了通知に使う結果と完了時刻を turnEnd に含める', defaultTurn.events.some(e => e.type === 'turnEnd' && e.outcome === 'ok' && Number.isFinite(e.completedAt)));
    const list0 = await c.cmd("listSessions");
    const defaultRow = list0.find(s => s.id === defaultTurn.sessionId);
    t.ok("未指定時の cwd はホームディレクトリになる", defaultRow?.cwd === os.homedir(), defaultRow?.cwd);

    // ---- 1ターン目（新規）
    const first = await c.runTurn(
      { prompt: "echo:こんにちは", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" },
      { ms: 20_000 },
    );
    const sid = first.sessionId;
    t.ok("新規セッションの id が session イベントで来る", Boolean(sid), sid ?? "(なし)");
    t.ok("本文が text.delta で流れる", textOf(first) === "こんにちは", JSON.stringify(textOf(first)));
    t.ok("turnResult が ok で終わる", first.outcome === "ok", String(first.outcome));
    t.ok("text.end に発言の uuid が乗る",
      first.events.some((e) => e.type === "text.end" && typeof e.uuid === "string" && e.uuid),
      "走っている最中の発言から分岐する起点");

    // ---- 一覧と履歴
    const list = await c.cmd("listSessions");
    const row = list.find((s) => s.id === sid);
    const completedAt = first.events.find(e => e.type === "turnEnd")?.completedAt;
    t.ok("完了通知と一覧に同じ完了時刻がある", Number.isFinite(completedAt) && row?.completedAt === completedAt);
    const savedCompletion = JSON.parse(await fs.readFile(path.join(scratch, "data", "sessions.json"), "utf8"));
    t.ok("切断中の完了も復元できるよう永続化する", savedCompletion[sid]?.completedAt === completedAt);
    t.ok("一覧に backend が付く", row?.backend === "fake", row?.backend ?? "(なし)");
    t.ok("一覧に cwd が乗る", row?.cwd === ROOT, row?.cwd ?? "(なし)");

    const loaded = await c.cmd("loadSession", { sessionId: sid });
    t.ok("履歴が確認対象の完了時刻を返す", loaded.completedAt === completedAt);
    t.ok("履歴が読み直せる",
      loaded.messages.length === 2 && loaded.messages[0].role === "user"
        && loaded.messages[1].text === "こんにちは",
      `${loaded.messages.length} 件`);

    // ---- ツール
    const tool = await c.runTurn({ prompt: "tool", sessionId: sid, cwd: ROOT }, { ms: 20_000 });
    t.ok("tool.start が流れる", tool.tools.join(",") === "fake_shell", tool.tools.join(",") || "(なし)");
    t.ok("tool.result が対応する id で返る",
      tool.events.some((e) => e.type === "tool.result" && e.text === "hi"));

    // ---- 添付。置いただけでは会話に出ず、送信（runTurn の attachments）で present として載る
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const m0 = c.mark();
    const up = await c.cmd("attachFile", { sessionId: sid, name: "shot.png", mime: "image/png", data: png });
    t.ok("attachFile は置き場のパスを返す", typeof up.path === "string" && up.kind === "image", JSON.stringify(up));
    t.ok("置いただけでは present は出ない", !c.since(m0).some((e) => e.type === "present"));
    const sent = await c.runTurn(
      { prompt: "echo:添付を見て", sessionId: sid, cwd: ROOT, attachments: [{ path: up.path, name: "shot.png", mime: "image/png" }] },
      { ms: 20_000 },
    );
    const pres = sent.events.find((e) => e.type === "present");
    t.ok("送信で present がそのセッションに出る", pres?.sessionId === sid && pres?.kind === "image" && pres?.by === "human"
      && String(pres?.dataUri ?? "").startsWith("data:image/png;base64,"), JSON.stringify(pres && { kind: pres.kind, by: pres.by }));
    t.ok("present は履歴に残る",
      (await c.cmd("loadSession", { sessionId: sid })).presents.some((p) => p.path === up.path));
    const m1 = c.mark();
    await c.runTurn({ prompt: "echo:x", sessionId: sid, cwd: ROOT, attachments: [{ path: "C:/Windows/win.ini", name: "win.ini", mime: "text/plain" }] }, { ms: 20_000 });
    t.ok("置き場の外のパスは載せない", !c.since(m1).some((e) => e.type === "present"));

    // ---- 承認（保留せず往復する）
    const from = asked.length;
    const ask = await c.runTurn({ prompt: "ask", sessionId: sid, cwd: ROOT }, { ms: 20_000 });
    t.ok("承認が1件来る", asked.length - from === 1, `${asked.length - from} 件`);
    t.ok("承認は kind:tool として来る", asked.at(-1)?.kind === "tool", String(asked.at(-1)?.kind));
    t.ok("常に許可が選べることが伝わる", asked.at(-1)?.canAlways === true);
    t.ok("許可がバックエンドまで届く", textOf(ask) === "許可された（常に）", JSON.stringify(textOf(ask)));

    // ---- 質問（承認ではなく回答）
    const q = await c.runTurn({ prompt: "question", sessionId: sid, cwd: ROOT }, { ms: 20_000 });
    const qEv = asked.at(-1);
    t.ok("質問は kind:question として来る", qEv?.kind === "question", String(qEv?.kind));
    t.ok("選択肢がそのまま乗る", qEv?.questions?.[0]?.options?.[0]?.label === "A",
         JSON.stringify(qEv?.questions?.[0]?.options ?? null));
    t.ok("回答がバックエンドまで届く", textOf(q).includes('"どれにする？":"A"'), JSON.stringify(textOf(q)));

    // ---- メタ情報（人間側の操作）
    await c.cmd("setTitle", { sessionId: sid, title: "テストの会話", reason: "手動" });
    await c.cmd("setStatus", { sessionId: sid, status: "進行中", reason: "手動" });
    const after = (await c.cmd("listSessions")).find((s) => s.id === sid);
    t.ok("タイトルが一覧に反映される", after?.title === "テストの会話", after?.title ?? "(なし)");
    t.ok("状態が一覧に反映される", after?.status === "進行中", after?.status ?? "(なし)");

    const statuses = await c.cmd("listStatuses");
    t.ok("既出の状態が候補に出る", statuses.some((s) => s.status === "進行中"),
         statuses.map((s) => s.status).join(",") || "(なし)");

    const { title: guessed } = await c.cmd("suggestTitle", { sessionId: sid });
    t.ok("タイトル案が返る", typeof guessed === "string" && guessed.length > 0, guessed);

    // ---- 状態グループのアイコン（sidecar statuses.json）
    const noIcon = (await c.cmd("listStatuses")).find((s) => s.status === "進行中");
    t.ok("アイコンの既定は無し", noIcon?.icon === null, String(noIcon?.icon));
    const setIcon = await c.cmd("setStatusIcon", { status: "進行中", icon: "◐" });
    t.ok("setStatusIcon が保存した値を返す", setIcon.icon === "◐", JSON.stringify(setIcon));
    t.ok("statusIcon イベントが配られる",
      c.events.some((e) => e.type === "statusIcon" && e.status === "進行中" && e.icon === "◐"));
    t.ok("listStatuses に icon が合流する",
      (await c.cmd("listStatuses")).find((s) => s.status === "進行中")?.icon === "◐");
    await c.cmd("renameStatus", { from: "進行中", to: "作業中" });
    const renamed = await c.cmd("listStatuses");
    // 旧名は履歴に残るので候補からは消えない（既出の語彙）。アイコンだけが新名へ移る
    t.ok("改名でアイコンが移る", renamed.find((s) => s.status === "作業中")?.icon === "◐"
      && !renamed.find((s) => s.status === "進行中")?.icon, renamed.map((s) => `${s.status}:${s.icon}`).join(","));
    await c.cmd("setStatusIcon", { status: "作業中", icon: "" });
    t.ok("空で「なし」に戻る", (await c.cmd("listStatuses")).find((s) => s.status === "作業中")?.icon === null);
    await c.cmd("setStatusIcon", { status: "作業中", icon: "✓" });
    await c.cmd("renameStatus", { from: "作業中", to: "" });
    await c.cmd("setStatus", { sessionId: sid, status: "作業中", reason: "手動" });
    t.ok("グループの削除でアイコンも捨てる",
      (await c.cmd("listStatuses")).find((s) => s.status === "作業中")?.icon === null);

    // ---- セッションの入ったグループの削除。状態は外れ、器は捨てられ、候補（履歴の語彙）には残るがグループにはならない
    //      （kept が false で、どのセッションにも付いていない状態を web はグループに出さない）
    await c.cmd("setStatus", { sessionId: sid, status: "消す予定", reason: "手動" });
    await c.cmd("setStatusIcon", { status: "消す予定", icon: "🗑" });
    t.ok("付いている間は kept（器がある）", (await c.cmd("listStatuses")).find((s) => s.status === "消す予定")?.kept === true);
    const del = await c.cmd("renameStatus", { from: "消す予定", to: "" });
    t.ok("削除で付いていたセッションの状態が外れる", del.moved === 1
      && (await c.cmd("listSessions")).find((s) => s.id === sid)?.status === null);
    const gone = (await c.cmd("listStatuses")).find((s) => s.status === "消す予定");
    t.ok("削除後は候補には残るが kept ではない（グループとしては消える）", gone && gone.kept === false && gone.icon === null,
         JSON.stringify(gone ?? null));
    t.ok("削除の status イベント（sessionId null, bulk）が配られる",
      c.events.some((e) => e.type === "status" && e.sessionId === null && e.bulk === 1 && /消す予定/.test(e.reason ?? "")));
    await c.cmd("setStatus", { sessionId: sid, status: "作業中", reason: "手動" });   // 後の判定（lineage の行）が見る状態に戻す

    // ---- 空のグループ。人が作った器は statuses.json にある限り存在する（設計メモ §6 の例外）
    await c.cmd("createStatus", { status: "レビュー済み" });
    const empty = (await c.cmd("listStatuses")).find((s) => s.status === "レビュー済み");
    t.ok("作った空のグループが一覧に出る", empty?.count === 0 && typeof empty?.firstUsedAt === "string",
         JSON.stringify(empty ?? null));
    t.ok("作ったことが status イベントで伝わる",
      c.events.some((e) => e.type === "status" && e.sessionId === null && e.status === "レビュー済み"));
    await c.cmd("setStatusIcon", { status: "レビュー済み", icon: "✓" });
    await c.cmd("setStatusIcon", { status: "レビュー済み", icon: "" });
    t.ok("アイコンを外しても空のグループは残る",
      (await c.cmd("listStatuses")).some((s) => s.status === "レビュー済み"));
    await c.cmd("createStatus", { status: "レビュー済み" });
    t.ok("同じ名前で作り直しても 1 つ",
      (await c.cmd("listStatuses")).filter((s) => s.status === "レビュー済み").length === 1);
    await c.cmd("renameStatus", { from: "レビュー済み", to: "" });
    t.ok("削除すると空のグループは消える",
      !(await c.cmd("listStatuses")).some((s) => s.status === "レビュー済み"));

    // 進み具合は各行の保存後に届き、完了の status イベントより前に並ぶ。
    const progressA = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    const progressB = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    await c.cmd('setStatus', { sessionId: progressA, status: '進捗テスト' });
    await c.cmd('setStatus', { sessionId: progressB, status: '進捗テスト' });
    const renameAt = c.mark();
    const renameResult = await c.cmd('renameStatus', { from: '進捗テスト', to: '進捗確認' });
    const renameEvents = c.since(renameAt);
    const renameSteps = renameEvents.filter(e => e.type === 'statusProgress');
    t.ok('状態名の変更は 1 件ごとの進み具合を出す', renameResult.moved === 2
      && JSON.stringify(renameSteps.map(e => [e.from, e.to, e.done, e.total]))
        === JSON.stringify([['進捗テスト', '進捗確認', 1, 2], ['進捗テスト', '進捗確認', 2, 2]]));
    t.ok('変更の進み具合は完了イベントより前に届く', renameEvents.findIndex(e => e.type === 'statusProgress' && e.done === 2)
      < renameEvents.findIndex(e => e.type === 'status' && e.bulk === 2));
    const deleteAt = c.mark();
    const deleteResult = await c.cmd('renameStatus', { from: '進捗確認', to: '' });
    const deleteEvents = c.since(deleteAt);
    t.ok('状態の削除も 1 件ごとの進み具合を出す', deleteResult.moved === 2
      && JSON.stringify(deleteEvents.filter(e => e.type === 'statusProgress').map(e => [e.to, e.done, e.total]))
        === JSON.stringify([['', 1, 2], ['', 2, 2]]));
    await c.cmd('deleteUnsentSession', { sessionId: progressA });
    await c.cmd('deleteUnsentSession', { sessionId: progressB });

    // ---- 新規セッションに最初から状態を付ける（runTurn の status）
    const tagged = await c.runTurn(
      { prompt: "echo:引き継ぎ", sessionId: null, cwd: ROOT, backend: "fake", status: "レビュー待ち" },
      { ms: 20_000 },
    );
    const taggedRow = (await c.cmd("listSessions")).find((s) => s.id === tagged.sessionId);
    t.ok("runTurn の status が新規セッションに付く", taggedRow?.status === "レビュー待ち", taggedRow?.status ?? "(なし)");
    t.ok("付いたことが status イベントで伝わる",
      tagged.events.some((e) => e.type === "status" && e.sessionId === tagged.sessionId && e.status === "レビュー待ち"));
    t.ok("再開のターンでは status を無視する",
      (await c.runTurn({ prompt: "echo:x", sessionId: tagged.sessionId, cwd: ROOT, status: "別の状態" }, { ms: 20_000 })).outcome === "ok"
        && (await c.cmd("listSessions")).find((s) => s.id === tagged.sessionId)?.status === "レビュー待ち");

    // ---- 再開のセッションの作業ディレクトリを変える（host が明示して送った cwd を採る）
    const other = path.join(ROOT, "tests");
    const moved = await c.runTurn({ prompt: "echo:移動", sessionId: tagged.sessionId, cwd: other }, { ms: 20_000 });
    const cwdEv = moved.events.find((e) => e.type === "cwd");
    t.ok("cwd を変えて再開すると cwd イベントが出る", cwdEv?.sessionId === tagged.sessionId && cwdEv?.cwd === other && cwdEv?.by === "human",
         JSON.stringify(cwdEv ?? null));
    t.ok("一覧の cwd が新しい値になる（fake のネイティブは古いままでも sidecar が正本）",
      (await c.cmd("listSessions")).find((s) => s.id === tagged.sessionId)?.cwd === other);
    t.ok("同じ cwd で再開しても cwd イベントは出ない",
      !(await c.runTurn({ prompt: "echo:x", sessionId: tagged.sessionId, cwd: other }, { ms: 20_000 })).events.some((e) => e.type === "cwd"));
    t.ok("cwd を送らずに再開すると変えた後の cwd で回る",
      (await c.runTurn({ prompt: "echo:x", sessionId: tagged.sessionId }, { ms: 20_000 })).outcome === "ok"
        && (await c.cmd("listSessions")).find((s) => s.id === tagged.sessionId)?.cwd === other);

    // ---- 分岐
    const forked = await c.cmd("fork", { sessionId: sid, title: "分岐先" });
    const withFork = await c.cmd("listSessions");
    const child = withFork.find((s) => s.id === forked.sessionId);
    t.ok("分岐先が一覧に出る", Boolean(child), forked.sessionId ?? "(なし)");
    t.ok("分岐の親が記録される", child?.parent?.sessionId === sid, child?.parent?.sessionId ?? "(なし)");
    t.ok("分岐先は履歴を引き継ぐ",
      (await c.cmd("loadSession", { sessionId: forked.sessionId })).messages.length > 0);

    // 途中の発言から分岐する。upToMessageId までが引き継がれる
    const full = (await c.cmd("loadSession", { sessionId: sid })).messages;
    const cutAt = full[1];
    const mid = await c.cmd("fork", { sessionId: sid, upToMessageId: cutAt.uuid });
    const midMsgs = (await c.cmd("loadSession", { sessionId: mid.sessionId })).messages;
    t.ok("途中の発言から分岐すると、そこまでが引き継がれる",
      midMsgs.length === 2 && midMsgs[1].uuid === cutAt.uuid, `${midMsgs.length} 件（親は ${full.length} 件）`);
    t.ok("分岐点が parent.atMessage に残る",
      (await c.cmd("listSessions")).find((s) => s.id === mid.sessionId)?.parent?.atMessage === cutAt.uuid);
    // web は fork に仮の名前を渡さない。名前はバックエンドが付ける（fake は元のタイトル + (fork)）
    t.ok("title を渡さない fork はバックエンドが名前を付ける",
      (await c.cmd("listSessions")).find((s) => s.id === mid.sessionId)?.title === "テストの会話 (fork)",
      (await c.cmd("listSessions")).find((s) => s.id === mid.sessionId)?.title ?? "(なし)");

    // 系譜。子から引いても根から引いても同じ家族が返る
    const lin = await c.cmd("lineage", { sessionId: mid.sessionId });
    t.ok("lineage が根を返す", lin.rootId === sid, lin.rootId ?? "(なし)");
    t.ok("lineage に家族が全部入る",
      [sid, forked.sessionId, mid.sessionId].every((id) => lin.sessions.some((s) => s.id === id))
        && lin.sessions.length === 3, `${lin.sessions.length} 件`);
    t.ok("lineage の行に parent とタイトルが付く",
      lin.sessions.find((s) => s.id === forked.sessionId)?.parent?.sessionId === sid
        && lin.sessions.find((s) => s.id === sid)?.title === "テストの会話");
    // 一覧と同じ合成（sessionRow）を通るので、状態など一覧の列もそのまま乗る
    t.ok("lineage の行は一覧の行と同じ形",
      lin.sessions.find((s) => s.id === sid)?.status === "作業中"
        && lin.sessions.find((s) => s.id === sid)?.backend === "fake",
      JSON.stringify(lin.sessions.find((s) => s.id === sid)));

    // ---- 中断
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "slow", sessionId: null, cwd: ROOT, backend: "fake" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session", { ms: 20_000, from: mark });
    const running = await c.cmd("running");
    t.ok("実行中として数えられる", running.count >= 1, `count=${running.count}`);
    const stopped = await c.cmd("abort", { sessionId: started.sessionId });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 20_000, from: mark });
    t.ok("中断できる", stopped.aborted === 1, JSON.stringify(stopped));
    t.ok("中断は turnResult aborted で伝わる",
      c.since(mark).some((e) => e.type === "turnResult" && e.outcome === "aborted"));

    // ---- 複数タブ（イベントは全部のタブに配られる。どれを掴むかは印で決まる）
    //
    // 新規セッションを待っているタブは、流れてきた session の id を採る。
    // 再開ターンも（モデルを知らせるために）session を出すので、印が無いと取り違える。
    // 掴んでよい 1 本には first が付く — web/client.mjs の isMine と
    // tests/unit/stream-routing.mjs が見ているのはこの印。
    const c2 = await open({ port: server.port, token: server.token });
    try {
      const m2 = c2.mark();
      await c.runTurn({ prompt: "echo:再開", sessionId: sid, cwd: ROOT }, { ms: 20_000 });
      const resumed = await c2.waitFor((e) => e.type === "session" && e.sessionId === sid,
                                       { ms: 20_000, from: m2 });
      t.ok("2本目のタブにも同じ流れが配られる", Boolean(resumed));
      t.ok("再開ターンの session に first は付かない", !resumed.first, JSON.stringify(resumed));

      const m3 = c2.mark();
      const fresh = await c.runTurn(
        { prompt: "echo:新規", sessionId: null, cwd: ROOT, backend: "fake" }, { ms: 20_000 });
      const born = await c2.waitFor((e) => e.type === "session" && e.sessionId === fresh.sessionId,
                                    { ms: 20_000, from: m3 });
      t.ok("新規ターンの session には first が付く", born.first === true, JSON.stringify(born));
      t.ok("新規待ちのタブが掴めるのは first の付いた1本だけ",
           c2.since(m2).filter((e) => e.type === "session" && e.first).length === 1,
           `${c2.since(m2).filter((e) => e.type === "session").length} 本の session が流れた`);
    } finally {
      c2.close();
    }

    // ---- 認証（持っているバックエンドだけ）
    const before = await c.cmd("authStatus", { backend: "fake" });
    t.ok("authStatus が supported を返す", before.supported === true && before.loggedIn === false,
         JSON.stringify(before));
    const logged = await c.cmd("authLogin", { backend: "fake" });
    t.ok("ログインすると loggedIn になる", logged.loggedIn === true, JSON.stringify(logged));
    t.ok("ログイン URL が auth イベントで出る",
      c.events.some((e) => e.type === "auth" && e.phase === "url" && e.backend === "fake"));
    const out = await c.cmd("authLogout", { backend: "fake" });
    t.ok("ログアウトできる", out.loggedIn === false, JSON.stringify(out));

    // ---- 開き直しても承認が残る（別サーバ。この接続は承認に即答してしまうので混ぜない）
    await reopenCase(t, scratch);

    // ---- 既定では host が離れても打ち切らない（別サーバ。AGENT_HOST_GRACE_MS 無し）
    await holdCase(t, scratch);

    // ---- 承認の猶予切れ（別サーバ。AGENT_HOST_GRACE_MS を明示したときだけ。500ms にする）
    await graceCase(t, scratch);

    // ---- ready は新しくつないだ接続にだけ返る（別サーバ）
    await readyCase(t, scratch);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 既定（AGENT_HOST_GRACE_MS 無し）では、host が全部離れても何も打ち切らない（issue #11）。
 * 承認待ちは保留のまま残り、戻ったタブへ同じ id で聞き直される。承認の要らないターンは走り続ける。
 */
async function holdCase(t, scratch) {
  const server = await startServer({
    // 走らせる側の環境に残っていても既定の挙動を測れるよう、空にして渡す（空＝未指定と同じ扱い）
    env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_GRACE_MS: "" },
    dataDir: path.join(scratch, "hold"),
    timeoutMs: 30_000,
  });
  try {
    const away = await open({ port: server.port, token: server.token });
    const mark = away.mark();
    away.cmd("runTurn", { prompt: "ask", sessionId: null, cwd: ROOT, backend: "fake" }).catch(() => {});
    const asking = await away.waitFor((e) => e.type === "session", { ms: 20_000, from: mark });
    const perm = await away.waitFor((e) => e.type === "permission", { ms: 20_000, from: mark });
    const mark2 = away.mark();
    away.cmd("runTurn", { prompt: "slow", sessionId: null, cwd: ROOT, backend: "fake" }).catch(() => {});
    const slow = await away.waitFor((e) => e.type === "session" && e.sessionId !== asking.sessionId, { ms: 20_000, from: mark2 });
    away.close();

    // 以前の 500ms 猶予のテストと同じだけ待っても、何も止まらない
    await sleep(1600);
    t.ok("既定では離れても「戻るまで待つ」と記録する", server.tail(50).includes("戻るまで待つ"));

    const back = await open({ port: server.port, token: server.token });
    try {
      const again = await back.waitFor((e) => e.type === "permission" && e.id === perm.id, { ms: 5_000 }).catch(() => null);
      t.ok("戻ると保留していた承認が同じ id で聞き直される", Boolean(again), perm.id);
      t.ok("承認待ちのあいだ turnEnd は来ていない",
        !back.events.some((e) => e.type === "turnEnd"), JSON.stringify(back.events.filter((e) => e.type === "turnEnd")));
      const running = await back.cmd("running");
      const ids = running.turns.map((x) => x.sessionId);
      t.ok("承認待ちのターンも承認の要らないターンも走ったまま",
        ids.includes(asking.sessionId) && ids.includes(slow.sessionId), JSON.stringify(ids));
      t.ok("承認待ちとして残っている", running.permissions.some((p) => p.id === perm.id), `permissions=${running.permissions.length}`);

      const mark3 = back.mark();
      await back.cmd("resolvePermission", { id: perm.id, allow: true });
      await back.waitFor((e) => e.type === "turnEnd" && e.sessionId === asking.sessionId, { ms: 20_000, from: mark3 });
      const said = back.since(mark3).filter((e) => e.type === "text.delta" && e.sessionId === asking.sessionId).map((e) => e.text).join("");
      t.ok("戻ってから答えた承認がそのまま効く", said.startsWith("許可された"), JSON.stringify(said));

      await back.cmd("abort", { sessionId: slow.sessionId });
      await back.waitFor((e) => e.type === "turnEnd" && e.sessionId === slow.sessionId, { ms: 20_000, from: mark3 });
    } finally {
      back.close();
    }
  } finally {
    await server.stop();
  }
}

/**
 * ready は新しくつないだ接続にだけ返す（issue #11）。
 * 全部に配ると、受けたクライアントは一覧と開いている会話を読み込み直すので、
 * 別の端末がつながるたびに他の画面が揺れる。
 */
async function readyCase(t, scratch) {
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake" },
    dataDir: path.join(scratch, "ready"),
    timeoutMs: 30_000,
  });
  const first = await open({ port: server.port, token: server.token });
  let readyOnFirst = 0;
  first.ws.on("message", (raw) => {
    try { if (JSON.parse(raw.toString()).kind === "ready") readyOnFirst++; } catch {}
  });
  let second;
  try {
    second = await open({ port: server.port, token: server.token });
    t.ok("新しい接続は ready を受け取る", true);
    // 往復を 1 回挟み、遅れて届く ready が無いことを確かめてから数える
    await first.cmd("running");
    await sleep(200);
    t.ok("先につないでいた接続には ready が届かない", readyOnFirst === 0, `ready=${readyOnFirst}`);
  } finally {
    second?.close();
    first.close();
    await server.stop();
  }
}

/**
 * host が消えたまま戻らなかったとき（design.md §8.5 の猶予切れ）。
 * 既定では打ち切らないので、AGENT_HOST_GRACE_MS を明示したときだけの挙動。
 *
 * 承認を聞かれたところで切ると、サーバは猶予のあいだ黙って待つ。
 * 猶予が切れたら「黙って deny し続ける」のではなく、待っている承認を理由付きで deny し、
 * 走っているターンごと止める。留守中のイベントは溜められ、戻ったタブへまとめて配られる。
 */
async function graceCase(t, scratch) {
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_GRACE_MS: "500" },
    dataDir: path.join(scratch, "grace"),
    timeoutMs: 30_000,
  });
  try {
    // 承認には答えないまま切る
    const away = await open({ port: server.port, token: server.token });
    const mark = away.mark();
    away.cmd("runTurn", { prompt: "ask", sessionId: null, cwd: ROOT, backend: "fake" }).catch(() => {});
    const started = await away.waitFor((e) => e.type === "session", { ms: 20_000, from: mark });
    const perm = await away.waitFor((e) => e.type === "permission", { ms: 20_000, from: mark });
    t.ok("承認を聞かれたところで host が消える", Boolean(perm.id), perm.id ?? "(なし)");
    away.close();

    // 猶予 500ms + 保険のタイマー 500ms を越えて戻らない
    await sleep(1600);

    const back = await open({ port: server.port, token: server.token });
    try {
      await back.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 20_000 });
      t.ok("猶予切れでターンが終わる", true, started.sessionId);
      const said = back.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");
      t.ok("待っていた承認は deny されている", said.startsWith("拒否された"), JSON.stringify(said));
      t.ok("理由が「戻らなかった」として伝わる", said.includes("戻らなかった"), JSON.stringify(said));
      const running = await back.cmd("running");
      t.ok("実行中が残らない", running.count === 0, `count=${running.count}`);
    } finally {
      back.close();
    }
  } finally {
    await server.stop();
  }
}

/**
 * 承認は一度きりしか配られない（web/session-stream.mjs の streamEvents に載らない）。
 * その会話を開き直したとき loadSession が保留中のものを返さないと、一覧だけが「承認待ち」で
 * カードがどこにも出ない、という行き止まりになる。
 */
async function reopenCase(t, scratch) {
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake" },
    dataDir: path.join(scratch, "reopen"),
    timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });
  try {
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "ask", sessionId: null, cwd: ROOT, backend: "fake" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session", { ms: 20_000, from: mark });
    const perm = await c.waitFor((e) => e.type === "permission", { ms: 20_000, from: mark });

    const opened = await c.cmd("loadSession", { sessionId: started.sessionId, live: true });
    const pending = (opened.permissions ?? []).find((p) => p.id === perm.id);
    t.ok("開き直すと保留中の承認が返る", Boolean(pending), (opened.permissions ?? []).length + " 件");
    t.ok("カードを組み立てられるだけの中身が付く",
      pending?.toolName === "fake_write" && pending?.input?.path === "a.txt" && pending?.canAlways === true,
      JSON.stringify(pending ?? null));
    t.ok("どの会話の承認かが分かる", pending?.sessionId === started.sessionId, String(pending?.sessionId));

    // 答えた後は返らない（解決済みのカードが開くたびに生えない）
    await c.cmd("resolvePermission", { id: perm.id, allow: true });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 20_000, from: mark });
    const again = await c.cmd("loadSession", { sessionId: started.sessionId, live: true });
    t.ok("答えた承認は返らない", (again.permissions ?? []).length === 0,
      JSON.stringify(again.permissions ?? []));
  } finally {
    c.close();
    await server.stop();
  }
}
