// コンピューターの操作（docs/computer-use.md）の会話の中の表示。
// イベントの形（tool.start / tool.result の `images`・`computer`、`computer.state`、permission の `computerApp`）を読んで、
// 行の右端（撮った画面のサムネイル・止めた理由）・拡大・承認カードの中身・別の会話を待つ行を作る。
// 行の組み立ては web/render.mjs、塊は web/tool-bundle.mjs、承認の置き場は web/client.mjs。ここは DOM を少し持つが、数え方は純粋な関数に切ってある（単体テストの対象）。
import { el, svgEl } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { runMark } from "./arc.mjs";

export const COMPUTER_PREFIX = "mcp__ply_computer__";
/** ply_computer のツールか（Claude・Codex・agy のどれも、正規化でこの名前にそろう） */
export const isComputerTool = (name) => String(name ?? "").startsWith(COMPUTER_PREFIX);
export const computerToolName = (name) => String(name ?? "").slice(COMPUTER_PREFIX.length);

// ---------------------------------------------------------------- 数え方（DOM に触れない）

// ツール名 -> 行の動詞。モックの「撮る・押す・入力・キー・許可・開く・ドラッグ・待つ」
const VERB = {
  screenshot: "shot", zoom: "zoom", switch_display: "display", cursor_position: "cursor", mouse_move: "move",
  left_click: "click", right_click: "click", middle_click: "click", double_click: "click", triple_click: "click",
  left_click_drag: "drag", left_mouse_down: "down", left_mouse_up: "up", scroll: "scroll",
  type: "type", key: "key", hold_key: "key", wait: "wait", open_application: "open",
  request_access: "access", list_granted_applications: "list", computer_batch: "batch",
};

/** 行の動詞（左端）。知らないツールは名前のまま */
export function computerVerb(name) {
  const key = VERB[computerToolName(name)];
  // i18n-dynamic: timeline.computer.verb.
  return key ? t(`timeline.computer.verb.${key}`) : computerToolName(name).slice(0, 24);
}

const STATES = new Set(["ok", "failed", "stopped", "waiting"]);
const REASONS = new Set(["escape", "stop", "locked", "forbidden", "denied", "busy"]);

/**
 * 結果から表示に使う情報を読む。`computer`（印の行から橋が作ったもの）が無ければ isError だけで決める。
 * stopped（止めた・断った・拒否・ロック・待ちの打ち切り）は失敗に数えない（ADR 0073）
 */
export function computerInfo(result) {
  const c = result?.computer && typeof result.computer === "object" ? result.computer : null;
  const known = c && STATES.has(c.state);
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    state: known ? c.state : (result?.isError ?? result?.is_error) ? "failed" : "ok",
    reason: known ? text(c.reason) : null,
    title: known ? text(c.title) : null,
    app: known ? text(c.app) : null,
    grant: known && (c.grant === "bypass" || c.grant === "all") ? c.grant : null,
    actions: known && Array.isArray(c.actions) ? c.actions.filter((a) => a && typeof a === "object").slice(0, 20) : [],
  };
}

/** 止めた理由の短い字（右端・見出し） */
export function reasonShort(reason) {
  // i18n-dynamic: timeline.computer.reasonShort.
  return t(`timeline.computer.reasonShort.${REASONS.has(reason) ? reason : "other"}`);
}

/** 止めた理由の 1 文（行の下）。知らない理由は null（呼び出し側が結果の本文を使う） */
export function reasonLong(reason, app) {
  // i18n-dynamic: timeline.computer.reason.
  return REASONS.has(reason) ? t(`timeline.computer.reason.${reason}`, { app: app ?? t("timeline.computer.thisApp") }) : null;
}

const SHOWN_MAX = 3;
const SPECIAL_MAX = 2;   // 失敗・止めたもので埋めるのは 2 行まで（最後の画面か最後の行を必ず残す）

/**
 * 終わった塊で見せる行（最大 3 行）を選ぶ。優先は 失敗・止めた → 最後に撮った画面 → 最後の行 → 新しいもの。
 * @param {{failed?:boolean, stopped?:boolean, shot?:boolean, running?:boolean}[]} items 呼び出しの順
 * @returns {Set<number>} 見せる行の添字
 */
export function pickRows(items) {
  const n = items.length;
  if (n <= SHOWN_MAX) return new Set(items.map((_, i) => i));
  const order = [];
  let special = 0;
  for (let i = n - 1; i >= 0 && special < SPECIAL_MAX; i--) if ((items[i].failed || items[i].stopped) && !items[i].running) { order.push(i); special++; }
  for (let i = n - 1; i >= 0; i--) if (items[i].shot) { order.push(i); break; }
  order.push(n - 1);
  for (let i = n - 1; i >= 0; i--) order.push(i);
  const picked = new Set();
  for (const i of order) { if (picked.size >= SHOWN_MAX) break; picked.add(i); }
  return picked;
}

/** 塊の見出しの右端に出す内訳。失敗の数と、止めた理由（最後に止めたもの）。どちらも走り終えた呼び出しだけ */
export function computerSummary(items) {
  const done = items.filter((x) => !x.running);
  const stopped = done.filter((x) => x.stopped).at(-1);
  return { failed: done.filter((x) => x.failed).length, stopped: stopped ? (stopped.reason ?? "other") : null };
}

// ---------------------------------------------------------------- 承認の内容

const hasText = (v) => typeof v === "string" && v.trim();

/** 承認の payload（computerApp）を表示に使える形へ。アプリが 1 つも無ければ null */
export function approvalApps(computerApp) {
  const apps = (Array.isArray(computerApp?.apps) ? computerApp.apps : [])
    .filter((a) => a && typeof a === "object" && hasText(a.name))
    .map((a) => ({ id: String(a.id ?? ""), name: String(a.name).trim(), risk: a.risk === "high" ? "high" : "normal", where: appWhere(a.id) }));
  if (!apps.length) return null;
  return {
    agent: hasText(computerApp?.agent?.label) ? String(computerApp.agent.label).trim() : t("chat.computerApproval.agent"),
    apps, first: computerApp?.first === true, reason: hasText(computerApp?.reason) ? String(computerApp.reason).trim() : "",
    high: apps.some((a) => a.risk === "high"),
  };
}

/** アプリの id から、所在の 1 行。`exe:c:/windows/system32/notepad.exe` はパス、`aumid:…` は AUMID のまま */
export function appWhere(id) {
  const s = String(id ?? "");
  if (s.startsWith("exe:")) return s.slice(4);
  if (s.startsWith("aumid:")) return s.slice(6);
  return "";
}

/** 「メモ帳」「メモ帳 ほか 1 件」の形の見出し・通知用の語。名前のあとに件数を続ける */
export function approvalHeading(approval, { agent = approval?.agent ?? "" } = {}) {
  const n = approval.apps.length;
  return n > 1
    ? t("chat.computerApproval.questionMore", { agent, app: approval.apps[0].name, count: n - 1 })
    : t("chat.computerApproval.question", { agent, app: approval.apps[0].name });
}

/** 通知の本文用の語（「メモ帳」ほか 1 件） */
export function approvalNotice(approval) {
  const n = approval.apps.length;
  return n > 1
    ? t("notify.computerApprovalMore", { agent: approval.agent, app: approval.apps[0].name, count: n - 1 })
    : t("notify.computerApproval", { agent: approval.agent, app: approval.apps[0].name });
}

/** 承認カードの中身（見出しの文・所在・警告・初めての説明）。置き場（行の中・単独のカード）は呼び出し側 */
export function approvalBody(approval, extra = "") {
  const box = el("div", "cu-ap");
  const ln = el("div", "ln");
  ln.append(el("span", "lbl", t("chat.computerApproval.label")));
  const q = el("span", "q");
  q.append(appIcon(), el("span", "qt", approvalHeading(approval)));
  ln.append(q);
  box.append(ln);
  if (extra) box.append(el("div", "sub", extra));
  for (const a of approval.apps) {
    if (!a.where) continue;
    const sub = el("div", "sub mono", approval.apps.length > 1 ? `${a.name} · ${a.where}` : a.where);
    sub.title = a.where;
    box.append(sub);
  }
  if (approval.reason) box.append(el("div", "sub", t("chat.computerApproval.reason", { reason: approval.reason })));
  if (approval.high) box.append(el("div", "warn", t("chat.computerApproval.warn")));
  if (approval.first) box.append(el("div", "expl", t("chat.computerApproval.explain")));
  return box;
}

/** 決着の補足（行の補足・単独のカードの 1 行） */
export function approvalSaid(scope, ok, approval) {
  if (!ok) return t("chat.approval.denied");
  return scope === "always" ? t("chat.approval.allowedAlways") : t("chat.computerApproval.allowedSession");
}

function appIcon() {
  const svg = svgEl("svg", { class: "appic", viewBox: "0 0 16 16", "aria-hidden": "true" });
  svg.append(svgEl("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), svgEl("path", { d: "M1.5 5.5h13" }));
  return svg;
}

// ---------------------------------------------------------------- 行の右端・サムネイル・拡大

/** 止めたことの印（—）。失敗の ✕ とは違う */
export function stopMark() {
  const svg = svgEl("svg", { class: "stopmk", viewBox: "0 0 14 14", role: "img", "aria-label": t("timeline.computer.stoppedMark") });
  svg.append(svgEl("path", { d: "M3.5 7h7" }));
  return svg;
}

const SHOT_URL = /^\/computer-shot\/[0-9a-f]{32}\.jpg$/;

/** 配信の URL（/computer-shot/<id>.jpg）だけを通す。ほかの URL・data: は出さない */
export function shotUrl(u) {
  const raw = String(u ?? "").trim();
  return SHOT_URL.test(raw) ? raw : null;
}

/** 結果の images から、表示に使える撮った画面を読む */
export function shotsOf(result) {
  return (Array.isArray(result?.images) ? result.images : []).map((img) => {
    const url = shotUrl(img?.url);
    return url ? { url, width: Number(img.width) || 0, height: Number(img.height) || 0 } : null;
  }).filter(Boolean);
}

/**
 * 行の右端のサムネイル。押すと拡大（同じ塊の画面を ← → で順に見る）。画像を読めなければ「画面は消去済み」に替える。
 * `meta` は拡大の見出しに使う（アプリ名・行の題）。行の開閉には伝えない
 */
export function shotButton(shot, meta) {
  const b = el("button", "tc-shot");
  b.type = "button";
  b.setAttribute("aria-label", t("timeline.computer.shot.open", { title: meta.title }));
  b.shot = { ...shot, ...meta };
  const img = document.createElement("img");
  img.setAttribute("src", shot.url);
  img.setAttribute("alt", "");
  img.setAttribute("loading", "lazy");
  img.setAttribute("decoding", "async");
  img.onerror = () => {
    const gone = el("span", "tc-shot-gone", t("timeline.computer.shot.gone"));
    b.shot.gone = true;
    b.replaceWith(gone);
  };
  b.append(img);
  b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const root = b.closest?.(".bundle") ?? b.closest?.(".m") ?? document.body;
    const list = [...root.querySelectorAll(".tc-shot")].filter((x) => x.shot && !x.shot.gone);
    openShots(list.map((x) => x.shot), Math.max(0, list.indexOf(b)));
  };
  return b;
}

let dialog = null;
let shots = [];
let at = 0;

function shotDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = el("dialog", "tc-shot-dlg");
  dialog.setAttribute("aria-label", t("timeline.computer.shot.dialog"));
  const head = el("div", "dh");
  head.append(el("span", "ttl"));
  const prev = el("button", "btn", "←"), next = el("button", "btn", "→"), close = el("button", "btn", "✕");
  prev.type = next.type = close.type = "button";
  prev.setAttribute("aria-label", t("timeline.computer.shot.prev"));
  next.setAttribute("aria-label", t("timeline.computer.shot.next"));
  close.setAttribute("aria-label", t("timeline.computer.shot.close"));
  prev.dataset.act = "prev"; next.dataset.act = "next";
  head.append(prev, next, close);
  const body = el("div", "img");
  dialog.append(head, body);
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  close.onclick = () => dialog.close();
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  });
  document.body.append(dialog);
  return dialog;
}

function go(d) {
  const to = Math.max(0, Math.min(shots.length - 1, at + d));
  if (to === at) return;
  at = to;
  paintShot();
}

function paintShot() {
  const s = shots[at];
  if (!s || !dialog) return;
  const bits = [s.title, t("timeline.computer.shot.position", { at: at + 1, total: shots.length })];
  if (s.width && s.height) bits.push(t("timeline.computer.shot.size", { w: s.width, h: s.height }));
  dialog.querySelector(".ttl").replaceChildren(...(s.app ? [el("b", null, s.app), el("span", null, " · ")] : []), el("span", null, bits.join(" · ")));
  const img = document.createElement("img");
  img.setAttribute("src", s.url);
  img.setAttribute("alt", s.title);
  img.onerror = () => dialog.querySelector(".img").replaceChildren(el("div", "tc-shot-gone", t("timeline.computer.shot.gone")));
  dialog.querySelector(".img").replaceChildren(img);
  dialog.querySelector('[data-act="prev"]').disabled = at === 0;
  dialog.querySelector('[data-act="next"]').disabled = at === shots.length - 1;
}

/** 拡大を開く。list は { url, width, height, title, app } の並び（同じ塊の画面）。at はそのうちの 1 枚 */
export function openShots(list, index = 0) {
  if (!list.length) return;
  shots = list;
  at = Math.max(0, Math.min(list.length - 1, index));
  const d = shotDialog();
  paintShot();
  if (!d.open) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); }
}

// ---------------------------------------------------------------- 別の会話が操作中（ロックの待ち）

const waits = new Set();
let waitTimer = 0;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function tickWaits() {
  const now = Date.now();
  for (const box of waits) {
    if (!box.isConnected) { waits.delete(box); continue; }
    box.querySelector(".tc-elapsed").textContent = clock(Math.max(0, now - box.since) / 1000);
  }
  if (!waits.size) { clearInterval(waitTimer); waitTimer = 0; }
}

/**
 * 走っている行の場所に出す「別の会話（{題}）が操作中です。終わったら続けます」と「その会話へ移る」。
 * holder は { sessionId, title }。since は待ち始めた時刻（ms）。go(sessionId) でその会話を開く
 */
export function lockWaitBox(holder, since, go) {
  const box = el("div", "tc-lockwait");
  box.setAttribute("role", "status");
  box.since = Number.isFinite(since) ? since : Date.now();
  const ln = el("div", "ln");
  const title = holder?.title ? String(holder.title) : "";
  const res = el("span", "tc-res");
  res.append(runMark(t("timeline.computer.wait.running")), el("span", "tc-elapsed", "0:00"));
  ln.append(el("span", "tc-label", t("timeline.computer.verb.wait")),
    el("span", "tc-main tc-wrap", title ? t("timeline.computer.wait.text", { title }) : t("timeline.computer.wait.textUntitled")), res);
  box.append(ln);
  if (holder?.sessionId) {
    const act = el("div", "wait-ln");
    const b = el("button", "btn", t("timeline.computer.wait.go"));
    b.type = "button";
    b.onclick = () => go(holder.sessionId);
    act.append(b);
    box.append(act);
  }
  waits.add(box);
  if (!waitTimer) waitTimer = setInterval(tickWaits, 1000);
  return box;
}
