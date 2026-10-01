// コンピューターの操作の会話の表示（docs/computer-use.md、docs/design-system.md「コンピューターの操作」）。
// 行（題・動詞・アプリ・サムネイル・止めた理由）・終わった塊の見せ方（3 行と「ほか N 件」）・承認の中身・通知の見出し・種類で切れる塊。
// 承認カードを塊の最新の行に置く動き・止める・別の会話を待つ行・拡大は実ブラウザーで見る（tests/browser/computer-use.cjs）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { readFileSync } from "node:fs";
import { Bundle, splitToolCalls } from "../../web/tool-bundle.mjs";
import { renderToolCall, applyToolResult } from "../../web/render.mjs";
import { createCompletionNotifications } from "../../web/notifications.mjs";
import {
  relayLabel, isComputerTool, computerInfo, reasonShort, reasonLong, pickRows, computerSummary, approvalApps, appWhere, approvalHeading, approvalNotice, approvalBody,
  shotUrl, shotsOf,
} from "../../web/computer-use.mjs";

export const name = "computer-use-ui";
export const title = "コンピューターの操作の表示: 行・塊の見せ方・止めた理由・承認の中身・通知";

const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
const P = "mcp__ply_computer__";
const SHOT = "4f2a91c3d5e7480192ab34cd56ef7788";
const shotImg = (id = SHOT) => ({ url: `/computer-shot/${id}.jpg`, shot: id, width: 1460, height: 821 });
const has = (node, cls) => node.querySelectorAll(`.${cls}`).length;

/** 行を作って結果を入れる */
function row(tool, input, result) {
  const card = renderToolCall(`${P}${tool}`, input, { id: `${tool}-${Math.random()}` });
  if (result) applyToolResult(card, result);
  return card;
}
const ok = (extra = {}) => ({ text: "押しました", isError: false, computer: { tool: "left_click", state: "ok", title: "x", app: "メモ帳", display: 1, ...extra.computer }, ...extra.rest });

export default async function (t) {
  // ---- 名前と状態の読み取り
  t.ok("ply_computer のツール名だけがコンピューターの操作", isComputerTool(`${P}screenshot`) && !isComputerTool("mcp__ply_agents__ply_delegate") && !isComputerTool("Bash") && !isComputerTool(undefined));
  {
    const i = computerInfo({ isError: true, computer: { state: "stopped", reason: "escape", title: "金額を入力", app: "メモ帳" } });
    t.ok("止めた（stopped）は isError でも失敗にしない", i.state === "stopped" && i.reason === "escape" && i.title === "金額を入力" && i.app === "メモ帳");
    t.ok("印が無ければ isError だけで決める（履歴に印が無い古い結果）", computerInfo({ isError: true }).state === "failed" && computerInfo({ text: "ok" }).state === "ok" && computerInfo(null).state === "ok");
    t.ok("知らない state は無いものとして扱う", computerInfo({ isError: false, computer: { state: "weird" } }).state === "ok");
    t.ok("grant は bypass / all だけ", computerInfo({ computer: { state: "ok", grant: "bypass" } }).grant === "bypass" && computerInfo({ computer: { state: "ok", grant: "x" } }).grant === null);
  }
  t.ok("止めた理由の短い字と 1 文（知らない理由は短い字だけ「止まった」・1 文は null）",
    reasonShort("escape") === "止めた" && reasonShort("locked") === "ロックで止まった" && reasonShort("???") === "止まった"
    && reasonLong("escape") === "あなたが Esc で止めました" && reasonLong("forbidden", "1Password").includes("1Password") && reasonLong("???") === null);

  // ---- 終わった塊で見せる行（モックの 03: 失敗 → 最後に撮った画面 → 最後の行）
  {
    const it = (extra = {}) => ({ failed: false, stopped: false, shot: false, running: false, ...extra });
    const done = [it(), it({ shot: true }), it(), it(), it(), it({ shot: true }), it({ failed: true }), it(), it({ shot: true })];
    t.ok("完了: 失敗・最後の画面・その前の行（モックの [6, 8, 7]）", [...pickRows(done)].sort((a, b) => a - b).join() === "6,7,8");
    const esc = [it(), it({ shot: true }), it(), it(), it(), it({ stopped: true })];
    t.ok("Esc で止めた: 最後の画面・止めた行・その前の行（モックの [1, 4, 5]）", [...pickRows(esc)].sort((a, b) => a - b).join() === "1,4,5");
    t.ok("3 行以下は全部", pickRows([it(), it(), it()]).size === 3 && pickRows([it()]).size === 1 && pickRows([]).size === 0);
    const manyFail = Array.from({ length: 8 }, () => it({ failed: true }));
    manyFail.push(it({ shot: true }));
    t.ok("失敗が多くても、最後の画面か最後の行を残す（失敗・止めたで埋めるのは 2 行まで）", pickRows(manyFail).has(8) && pickRows(manyFail).size === 3);
    const sum = computerSummary([it({ failed: true }), it({ stopped: true, reason: "locked" }), it({ failed: true, running: true })]);
    t.ok("見出しの内訳: 失敗の数と最後の止めた理由（走っているものは数えない）", sum.failed === 1 && sum.stopped === "locked");
    t.ok("止めたものが無ければ理由は null", computerSummary([it(), it({ failed: true })]).stopped === null);
  }

  // ---- 行
  {
    const c = row("left_click", { title: "保存を押す", coordinate: [412, 238] });
    t.ok("行: 動詞は操作の種類、主役は title（座標は主役にしない）", text(c.querySelector(".tc-label")) === "押す" && text(c.querySelector(".tc-main")) === "保存を押す" && c.classList.contains("tc-computer"));
    t.ok("座標などの入力は開いた中に（title は繰り返さない）", text(c.querySelector(".tc-kv")).includes("coordinate") && !text(c.querySelector(".tc-kv")).includes("title"));
    t.ok("動詞: 撮る・入力・キー・開く・許可", ["screenshot", "type", "key", "open_application", "request_access"].map((n) => text(row(n, { title: "x" }).querySelector(".tc-label"))).join() === "撮る,入力,キー,開く,許可");
    t.ok("知らないツールは名前のまま", text(row("future_tool", { title: "x" }).querySelector(".tc-label")) === "future_tool");
  }
  {
    const c = row("screenshot", { title: "画面を確かめる" }, ok({ rest: { images: [shotImg()] }, computer: { tool: "screenshot", shot: SHOT, app: "メモ帳" } }));
    const btn = c.querySelector(".tc-shot");
    t.ok("撮った画面はサムネイル（行の右端）。押すと拡大するボタンで、行の開閉とは別", btn && btn.getAttribute("aria-label").includes("画面を確かめる") && btn.shot.url === `/computer-shot/${SHOT}.jpg` && btn.shot.width === 1460);
    t.ok("対象のアプリは補足に", text(c.querySelector(".tc-note")) === "メモ帳");
    t.ok("成功の行に要約の文を出さない・失敗にも数えない", !c.classList.contains("tc-error") && c.classList.contains("tc-done") && !text(c.querySelector(".tc-res")).includes("押しました"));
    t.ok("生成画像のプレビュー（.tc-preview）は出さない（サムネイルが担う）", has(c, "tc-preview") === 0);
    applyToolResult(c, ok({ rest: { images: [shotImg()] }, computer: { tool: "screenshot", shot: SHOT, app: "メモ帳" } }));
    t.ok("結果を呼び直しても二重にならない", has(c, "tc-shot") === 1);
  }
  t.ok("配信の URL 以外の画像は出さない（外部・data:・id の形が違うもの）",
    shotUrl("/computer-shot/zz.jpg") === null && shotUrl("https://example.com/computer-shot/" + SHOT + ".jpg") === null && shotUrl("data:image/jpeg;base64,xx") === null
    && shotUrl(`/computer-shot/${SHOT}.jpg`) !== null && shotsOf({ images: [{ url: "/x.jpg" }, shotImg()] }).length === 1);
  {
    const c = row("left_click", { title: "保存を押す" }, { text: "Point is outside the target window", isError: true, computer: { tool: "left_click", state: "failed", title: "保存を押す" } });
    t.ok("失敗: ✕ 失敗と要点の 1 行（失敗に数える）", c.classList.contains("tc-error") && text(c.querySelector(".tc-res")) === "✕ 失敗" && text(c.querySelector(".tc-errline")) === "Point is outside the target window");
  }
  {
    const c = row("type", { title: "金額を入力" }, { text: "止めました", isError: true, computer: { tool: "type", state: "stopped", reason: "escape", title: "金額を入力" } });
    t.ok("止めた: ✕ にせず、止めた印と短い理由、行の下に 1 文（失敗に数えない）",
      !c.classList.contains("tc-error") && c.classList.contains("tc-stopped") && has(c, "stopmk") === 1 && text(c.querySelector(".tc-res")) === "止めた"
      && text(c.querySelector(".tc-errline")) === "あなたが Esc で止めました" && c.dataset.stopReason === "escape");
    const f = row("open_application", { title: "1Password を開く" }, { text: "断りました", isError: true, computer: { tool: "open_application", state: "stopped", reason: "forbidden", app: "1Password" } });
    t.ok("禁止のアプリ: 操作できない・理由にアプリ名", text(f.querySelector(".tc-res")) === "操作できない" && text(f.querySelector(".tc-errline")).includes("1Password"));
    applyToolResult(c, ok());
    t.ok("結果が替われば止めた印を外す", !c.classList.contains("tc-stopped") && has(c, "stopmk") === 0 && has(c, "tc-reason") === 0);
  }
  {
    const c = row("screenshot", {}, ok({ computer: { title: "メモ帳の画面を撮る" } }));
    t.ok("入力に title が無ければ、橋が補った題（印の行）を主役にする", text(c.querySelector(".tc-main")) === "メモ帳の画面を撮る");
    const g = row("left_click", { title: "押す" }, ok({ computer: { grant: "bypass" } }));
    t.ok("確認なしの自動許可は補足に「許可 · 確認なしのため自動」", text(g.querySelector(".tc-note")) === "メモ帳 · 許可 · 確認なしのため自動");
    const b = row("computer_batch", { title: "まとめて保存", actions: [{}] }, ok({ computer: { tool: "computer_batch", actions: [{ tool: "left_click", state: "ok", app: "メモ帳" }, { tool: "type", state: "failed" }, { tool: "key", state: "stopped", reason: "escape" }] } }));
    t.ok("まとめて実行は動作ごとの内訳を開いた中に", text(b.querySelector(".tc-batch")).includes("メモ帳") && text(b.querySelector(".tc-batch")).includes("✕ 失敗") && text(b.querySelector(".tc-batch")).includes("止めた"));
    const denied = row("left_click", { title: "押す" });
    denied.dataset.denied = "1";
    applyToolResult(denied, { text: "denied", isError: true, computer: { tool: "left_click", state: "stopped", reason: "denied" } });
    t.ok("承認を拒否した行は「拒否した」で、失敗にしない", text(denied.querySelector(".tc-res")) === "拒否した" && !denied.classList.contains("tc-error"));
  }

  // ---- 塊（終わったもの）
  {
    const shot = { rest: { images: [shotImg()] }, computer: { tool: "screenshot", shot: SHOT, app: "メモ帳" } };
    const cards = [
      row("request_access", { title: "メモ帳の許可" }, ok()), row("screenshot", { title: "画面" }, ok(shot)), row("left_click", { title: "本文" }, ok()),
      row("type", { title: "入力" }, ok()), row("key", { title: "保存" }, ok()), row("screenshot", { title: "ダイアログ" }, ok(shot)),
      row("left_click", { title: "保存" }, { text: "outside", isError: true, computer: { tool: "left_click", state: "failed" } }),
      row("left_click", { title: "保存" }, ok()), row("screenshot", { title: "保存後" }, ok(shot)),
    ];
    const b = new Bundle({ kind: "computer" });
    b.addAll(cards);
    const wraps = b.hist.children;
    const shown = wraps.map((w, i) => (w.classList.contains("hid") ? null : i)).filter((i) => i !== null);
    t.ok("終わった塊は閉じていても 3 行（失敗・最後の画面・その前）を見せる", shown.join() === "6,7,8", shown.join());
    t.ok("見出しは「コンピューターを操作しました」・件数・✕ 失敗 1（止めたものは数えない）", text(b.head.querySelector(".mix")) === "コンピューターを操作しました" && text(b.nEl) === "9" && text(b.xmEl) === "✕ 失敗 1");
    t.ok("「ほか N 件」で残りを開ける", b.moreEl.hidden === false && text(b.moreEl) === "ほか 6 件");
    b.moreEl.onclick();
    t.ok("開くと全部が見え、「ほか」は消える", wraps.every((w) => !w.classList.contains("hid")) && b.moreEl.hidden === true);
    b.collapse();
    t.ok("閉じると見せる行に戻る", wraps.filter((w) => !w.classList.contains("hid")).length === 3 && b.moreEl.hidden === false);
    t.ok("コンピューターの塊は kind と cu の印", b.computer === true && b.el.classList.contains("cu") && new Bundle().computer === false);
  }
  {
    const stopped = [row("screenshot", { title: "画面" }, ok()), row("type", { title: "入力" }, { text: "s", isError: true, computer: { tool: "type", state: "stopped", reason: "locked" } })];
    const b = new Bundle({ kind: "computer" });
    b.addAll(stopped);
    t.ok("止めたものは見出しの右に理由の短い字（✕ にしない）・2 行なら「ほか」は出ない", text(b.xmEl) === "ロックで止まった" && b.moreEl.hidden === true);
  }
  {
    const live = new Bundle({ live: true, kind: "computer", onStop: () => {} });
    t.ok("走っている塊は「止める」を持つ。止めたら外れる", live.stopEl && text(live.stopEl) === "止める" && text(live.head.querySelector(".mix")) === "コンピューターを操作中");
    live.setStopping(true);
    t.ok("押した後は止め終えるまで押せない・失敗したら戻る", live.stopEl.disabled === true && text(live.stopEl) === "止めています…");
    live.setStopping(false);
    t.ok("戻す", live.stopEl.disabled === false && text(live.stopEl) === "止める");
    t.ok("ふつうの塊は「止める」も「ほか」も持たない", !new Bundle({ live: true }).stopEl && !new Bundle({ live: true }).moreEl);
  }

  // ---- 種類で切れる塊
  {
    const g = (c) => (c.cu ? "computer" : "tools");
    const seg = splitToolCalls([{ n: 1 }, { n: 2, cu: true }, { n: 3, cu: true }, { n: 4 }, { n: 5, cu: true }], () => false, g);
    t.ok("コンピューターの操作の連続は別の塊になり、種類が替わればそこで切れる",
      seg.map((s) => `${s.kind}${s.calls.length}`).join() === "tools1,computer2,tools1,computer1", seg.map((s) => s.kind).join());
    t.ok("種類を渡さなければ今までどおり（kind は tools）", splitToolCalls([{ n: 1 }, { n: 2 }], () => false).map((s) => `${s.kind}${s.calls.length}`).join() === "tools2");
  }

  // ---- 承認の中身
  {
    const payload = { agent: { id: "claude", label: "Claude" }, apps: [{ id: "exe:c:/windows/system32/notepad.exe", name: "メモ帳", risk: "normal" }], first: true };
    const a = approvalApps(payload);
    t.ok("アプリ・エージェント・初回・高リスクを読む", a.agent === "Claude" && a.apps.length === 1 && a.apps[0].where === "c:/windows/system32/notepad.exe" && a.first === true && a.high === false);
    t.ok("見出しは「{エージェント} に「{アプリ}」の操作を許可しますか？」", approvalHeading(a) === "Claude に「メモ帳」の操作を許可しますか？");
    const many = approvalApps({ ...payload, apps: [...payload.apps, { id: "aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "電卓", risk: "high" }] });
    t.ok("複数のアプリは「ほか N 件」・高リスクが 1 つでもあれば警告", approvalHeading(many) === "Claude に「メモ帳」ほか 1 件の操作を許可しますか？" && many.high === true);
    t.ok("アプリが無い・読めない payload は null（ふつうの承認として出す）", approvalApps({ apps: [] }) === null && approvalApps(null) === null && approvalApps({ apps: [{ id: "x" }] }) === null);
    t.ok("所在: exe はパス、AUMID はそのまま、それ以外は空", appWhere("aumid:Pkg!App") === "Pkg!App" && appWhere("exe:d:/x/a.exe") === "d:/x/a.exe" && appWhere("x") === "");
    const first = approvalBody(a);
    t.ok("初めての 1 回だけ説明文を出す・JSON は出さない", text(first).includes("Esc でいつでも止められます") && !text(approvalBody({ ...a, first: false })).includes("Esc でいつでも") && !text(first).includes("{"));
    t.ok("所在は等幅の 1 行（モックの exe のパス）", text(first.querySelector(".sub")) === "c:/windows/system32/notepad.exe" && first.querySelector(".sub").classList.contains("mono"));
    const risk = approvalBody({ ...a, first: false, high: true });
    t.ok("高リスクは ⚠ と強い字の一言（許可はできる）", text(risk.querySelector(".warn")).startsWith("⚠"));
    t.ok("中継された承認の題は「委譲先」の部分だけ使う（直接の承認の題は見出しの繰り返しなので使わない）",
      relayLabel("委譲先「経費の入力」 / Claude に「Excel」の操作を許可しますか？") === "委譲先「経費の入力」" && relayLabel("Claude に「Excel」の操作を許可しますか？") === "" && relayLabel(null) === "");
    t.ok("エージェント名が無ければ「エージェント」", approvalApps({ ...payload, agent: {} }).agent === "エージェント");
    t.ok("OS の通知の見出し: 誰が何の許可を待っているか", approvalNotice(a) === "Claude が「メモ帳」の使用の許可を待っています" && approvalNotice(many) === "Claude が「メモ帳」ほか 1 件の使用の許可を待っています");
  }

  // ---- OS の通知（背面のとき。承認待ちの通知を、アプリの名前入りの見出しにする）
  {
    const sent = [];
    const alerts = createCompletionNotifications({ host: { plyDesktop: { notifyCompletion: (n) => { sent.push(n); return Promise.resolve(true); } } }, openSession: () => {} });
    const base = { type: "permission", kind: "tool", sessionId: "s1", notifyReply: true, conversationTitle: "請求書" };
    alerts.waiting({ ...base, id: "p1", computerApp: { agent: { label: "Codex" }, apps: [{ id: "exe:c:/x/excel.exe", name: "Excel", risk: "normal" }] } });
    alerts.waiting({ ...base, id: "p2" });
    t.ok("アプリの承認の通知は見出しにエージェントとアプリ、本文は会話の題。ほかの承認は今までどおり",
      sent[0].title === "Codex が「Excel」の使用の許可を待っています" && sent[0].body === "請求書" && sent[1].title === "返事を待っています");
  }

  // ---- client.mjs の配線（ソースの検査。動きは実ブラウザーで）
  {
    const client = readFileSync(new URL("../../web/client.mjs", import.meta.url), "utf8");
    t.ok("止める: computerStop に会話の id を送る", /cmd\("computerStop", \{ sessionId: state\.current \}\)/.test(client));
    t.ok("承認の答えは scope（session / always）と、拒否の印（messageKey）を送る", /scope === "always"/.test(client) && /scope,?\s*\}/.test(client) && /messageKey: "userDenied"/.test(client));
    t.ok("computer.state は会話ごとに覚え、開いている会話の分だけ行に出す", /ev\.type === 'computer\.state'/.test(client) && /state\.computerStates\.set\(ev\.sessionId, ev\)/.test(client));
    t.ok("permission の computerApp は塊の最新の行か単独のカードに出す", /ev\.computerApp \? approvalApps\(ev\.computerApp\)/.test(client) && /computerApproval\(ev, computerApp, row\)/.test(client));
    t.ok("履歴を開いたときの塊も kind で分ける（1 件でも塊）", /isComputerTool\(card\.dataset\.tool\) \? "computer" : "tools"/.test(client) && /seg\.kind !== "computer"/.test(client));
  }
}
