// 切り替えを待つ表示（無停止の更新 段階 1 の 1-6。docs/design-system.md「切り替えを待つ表示」、docs/zero-downtime-update/design.md §6.1）。
// 更新で窓が入れ替わった後、新しい main は古い版のサーバーのまま動き、作業が終わってから新しい版へ切り替える。その間（数分〜数時間）の
// 窓は古い版のサーバーが配る画面（この画面）なので、表示はこのモジュールが描き、新しい main（desktop/switch-screen.cjs）が状態を渡す。
//
// 受け取る口は preload の plyDesktop.switch（版 1）。この画面が読める版は SWITCH_BRIDGE_VERSIONS で、読み込むとき hello で知らせる。
// 口が無い画面（ブラウザー・スマホ・リモートの窓）・知らない版の状態・知らない phase は、何も出さない。表示を持たない古い版の画面には
// main が最小限のダイアログを出す（desktop/switch-screen.cjs の頭の注記）。
import { el, svgEl } from "./dom.mjs";
import { fmt, t } from "./i18n.mjs";
import { runMark } from "./arc.mjs";
import { warnMark } from "./interrupt.mjs";

/** この画面が読める口の版（preload の switch が版 1）。口の形を変える版は switch2 を足し、1 版ぶん前の口を残す */
export const SWITCH_BRIDGE_VERSIONS = [1];
const PHASES = ["waiting", "asking", "manual", "held", "stopping", "switching", "done", "failed"];
/** 待ちの間に脇の知らせの印（⚙ の点）を出す phase。done・failed・切り替え中は出さない */
const PENDING = new Set(["waiting", "asking", "manual", "held"]);
const LEAVE_MS = 260;
// 訳文の {{mark}} を三角に置き換えるための印（私用領域の 1 文字。web/updates.mjs と同じ）
const MARK = "\u{E000}";

/** main が渡した状態を読む。読めない（口の版が違う・形が違う）なら null。欠けた項目は空として扱う */
export function readSwitchState(payload) {
  if (!payload || typeof payload !== "object" || !SWITCH_BRIDGE_VERSIONS.includes(payload.v) || !PHASES.includes(payload.phase)) return null;
  const list = (value) => (Array.isArray(value) ? value.filter((x) => x && typeof x === "object").map((x) => ({
    kind: String(x.kind ?? ""), sessionId: typeof x.sessionId === "string" ? x.sessionId : null, backend: typeof x.backend === "string" ? x.backend : null,
    label: typeof x.label === "string" ? x.label : null })) : []);
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    phase: payload.phase,
    target: typeof payload.target === "string" ? payload.target : "",
    current: typeof payload.current === "string" ? payload.current : "",
    since: num(payload.since), at: num(payload.at),
    kind: payload.kind === "stoppers" ? "stoppers" : "manual",
    reason: typeof payload.reason === "string" ? payload.reason : "",
    interruptFailed: payload.interruptFailed === true,
    interrupt: payload.interrupt && typeof payload.interrupt === "object" ? { done: num(payload.interrupt.done) ?? 0, total: num(payload.interrupt.total) ?? 0 } : null,
    items: list(payload.items), stoppers: list(payload.stoppers), stopped: list(payload.stopped),
  };
}

/** 待っている作業を会話ごとに 1 行へ。承認を待っている会話は「承認待ち」、それ以外は「実行中」（エージェントはターンのもの） */
export function switchWorkRows(items) {
  const rows = new Map();
  for (const item of items ?? []) {
    const key = item.sessionId ?? "";
    const row = rows.get(key) ?? { key: `work:${key}`, sessionId: item.sessionId ?? null, state: "running", backend: null };
    if (item.kind === "permission") row.state = "waiting";
    if (item.kind === "turn" && item.backend) row.backend = item.backend;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** 切り替えで止まるもの（`!` のシェル・Codex の裏の端末）の行 */
export function switchStopperRows(stoppers) {
  return (stoppers ?? []).map((s, i) => ({ key: `stop:${s.kind}:${s.sessionId ?? ""}:${s.label ?? i}`, sessionId: s.sessionId, kind: s.kind, backend: s.backend,
    what: s.kind === "shell" ? `! ${s.label ?? ""}`.trim() : s.label ? t("switch.terminalNamed", { label: s.label }) : t("switch.terminal") }));
}

/** 「実行中 3 件・承認待ち 1 件」 */
export function switchCounts(rows) {
  const running = rows.filter((r) => r.state === "running").length, waiting = rows.filter((r) => r.state === "waiting").length;
  return [running && t("updates.promptRunning", { count: running }), waiting && t("updates.promptWaiting", { count: waiting })].filter(Boolean).join(t("updates.promptJoin"));
}

/** 切り替えで止めたものの 1 行（「止めたもの: ! のシェル 1 件・Codex の端末 1 件」）。無ければ空 */
export function stoppedText(stopped, agentName = (id) => id) {
  const shells = stopped.filter((s) => s.kind === "shell").length;
  const byAgent = new Map();
  for (const s of stopped) if (s.kind === "background") byAgent.set(s.backend ?? "", (byAgent.get(s.backend ?? "") ?? 0) + 1);
  const parts = [shells && t("switch.stoppedShell", { count: shells }),
    ...[...byAgent].map(([backend, count]) => (backend ? t("switch.stoppedAgent", { agent: agentName(backend), count }) : t("switch.stoppedBackground", { count })))].filter(Boolean);
  return parts.length ? t("switch.stopped", { items: parts.join(t("updates.promptJoin")) }) : "";
}

/** 脇の知らせに出す形。出さないなら null（held・done・読めない状態・閉じた失敗） */
export function noticeModel(state, { dismissed = false } = {}) {
  if (!state) return null;
  const target = state.target;
  const stoppers = switchStopperRows(state.stoppers);
  const rows = switchWorkRows(state.items);
  switch (state.phase) {
    case "waiting":
      return { kind: "wait", title: t("switch.waiting", { target }), sub: switchCounts(rows), rows, stoppers, since: state.since, error: state.interruptFailed ? t("switch.interruptFailed") : "" };
    case "asking":
      return { kind: "ask", title: t("switch.askTitle", { target }), sub: t("switch.askSub", { count: state.stoppers.length }), rows: [], stoppers };
    case "manual":
      return { kind: "manual", title: t("switch.manualTitle", { target }), sub: manualReason(state.reason), rows, stoppers };
    case "stopping":
      return { kind: "stopping", title: t("switch.stopping", { target, done: state.interrupt?.done ?? 0, total: state.interrupt?.total ?? 0 }) };
    case "switching":
      return { kind: "switching", title: t("switch.switching", { target }) };
    case "failed":
      return dismissed ? null : { kind: "failed", title: t("switch.failed", { current: state.current }) };
    default:
      return null;
  }
}

/** 合わない版の理由の 1 行。形式番号が変わる版と、それ以外（新しい版へ作業を続けたまま渡せない） */
const manualReason = (reason) => (reason === "schema" ? t("switch.manualSchema") : t("switch.manualOther"));

/** 設定 › アプリ情報・更新の、待っている間の状態の字とヒント。出さないなら null */
export function pageModel(state) {
  if (!state) return null;
  const target = state.target;
  switch (state.phase) {
    case "waiting": return { status: t("switch.pageWaiting", { target }), hint: t("switch.pageRunning", { current: state.current }) };
    case "asking": return { status: t("switch.pageAsking", { target }), hint: t("switch.pageRunning", { current: state.current }) };
    case "held": case "manual":
      return { status: state.kind === "stoppers" && state.phase === "held" ? t("switch.pageAsking", { target }) : t("switch.pageManual", { target }), hint: t("switch.pageRunning", { current: state.current }) };
    case "stopping": return { status: t("updates.interrupting", { done: state.interrupt?.done ?? 0, total: state.interrupt?.total ?? 0 }), hint: "" };
    case "switching": return { status: t("switch.pageSwitching", { target }), hint: "" };
    case "failed": return { status: t("switch.pageFailed"), hint: t("switch.pageFailedHint", { current: state.current }) };
    default: return null;
  }
}

/** 脇の知らせ・設定のページの操作ボタン（act は main へ返す答え） */
function actionsFor(kind, { page = false, open = false } = {}) {
  switch (kind) {
    case "wait": return page ? [{ act: "now", label: t("switch.interruptNow") }]
      : [{ toggle: true, label: open ? t("switch.collapse") : t("switch.view") }, ...(open ? [{ act: "now", label: t("switch.interruptNow") }] : [])];
    case "ask": return [...(page ? [] : [{ act: "later", label: t("switch.later") }]), { act: "now", label: t("switch.stopAndSwitch"), primary: true }];
    case "manual": return [...(page ? [] : [{ act: "later", label: t("switch.later") }]), { act: "now", label: t("switch.interruptAndSwitch"), primary: true }];
    case "failed": return [{ act: "retry", label: t("switch.retry") }, ...(page ? [] : [{ dismiss: true, label: t("switch.dismiss") }])];
    default: return [];
  }
}

/** 設定のページの箱の形（phase から。「あとで」の後は held の kind） */
function pageKind(state) {
  if (state.phase === "waiting") return "wait";
  if (state.phase === "asking") return "ask";
  if (state.phase === "manual") return "manual";
  if (state.phase === "held") return state.kind === "stoppers" ? "ask" : "manual";
  if (state.phase === "failed") return "failed";
  return null;
}

const dashMark = () => {
  const span = el("span", "state-mark");
  span.setAttribute("aria-hidden", "true");
  const svg = svgEl("svg", { viewBox: "0 0 14 14" });
  svg.append(svgEl("path", { d: "M4 7h6" }));
  span.append(svg);
  return span;
};

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function setupSwitchNotice({ bridge = window.plyDesktop?.switch, sessionName = (id) => id, agentName = (id) => id, openSession = () => {}, onChange = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const inert = { get pending() { return false; }, get holdsNotice() { return false; }, page: () => null, stoppedText: () => "", refresh() {}, get state() { return null; } };
  if (!bridge || !SWITCH_BRIDGE_VERSIONS.includes(bridge.version) || !$("switchNotice")) return inert;

  let state = null;
  let open = false;
  let acting = false;
  const sigs = new Map();
  const dismissKey = () => `ply-switch-dismissed:${state?.at ?? ""}`;
  const isDismissed = () => { try { return sessionStorage.getItem(dismissKey()) === "yes"; } catch { return false; } };

  function rowEl(row, { stopper }) {
    if (stopper) {
      const line = el("div", "update-work-row stop");
      line.append(dashMark(), el("span", "update-work-name", row.sessionId ? sessionName(row.sessionId) : t("switch.unknownSession")));
      const what = el("span", "update-work-state mono", row.what);
      what.title = row.what;
      line.append(what);
      return line;
    }
    const line = el("button", "update-work-row switch-row");
    line.type = "button";
    line.title = t("switch.openSession");
    const waiting = row.state === "waiting";
    const mark = waiting ? el("span", "update-work-dia", "◆") : runMark(t("updates.workRunningOnly"));
    if (waiting) mark.setAttribute("aria-hidden", "true");
    line.append(mark, el("span", "update-work-name", row.sessionId ? sessionName(row.sessionId) : t("switch.unknownSession")),
      el("span", `update-work-state${waiting ? " mark" : ""}`, waiting ? t("updates.workWaiting") : row.backend ? t("updates.workRunning", { agent: agentName(row.backend) }) : t("updates.workRunningOnly")));
    if (row.sessionId) line.onclick = () => openSession(row.sessionId);
    return line;
  }

  /** 一覧の 1 まとまり（見出し + 行）。行は鍵で使い回し、消えた行は縮んでから外す */
  function syncGroup(group, title, small, rows, stopper) {
    const map = group.rows ??= new Map();
    let head = group.querySelector("h4");
    if (!head) { head = el("h4"); group.prepend(head); }
    head.replaceChildren(title);
    if (small) head.append(el("small", "", small));
    const keep = new Set(rows.map((r) => r.key));
    let anchor = head;
    for (const row of rows) {
      const sig = `${row.state ?? ""}|${row.backend ?? ""}|${row.what ?? ""}|${row.sessionId ? sessionName(row.sessionId) : ""}`;
      let entry = map.get(row.key);
      if (!entry || entry.sig !== sig || entry.leaving) {
        entry?.node.remove();
        entry = { node: rowEl(row, { stopper }), sig };
        map.set(row.key, entry);
      }
      if (anchor.nextSibling !== entry.node) anchor.after(entry.node);
      anchor = entry.node;
    }
    for (const [key, entry] of map) {
      if (keep.has(key) || entry.leaving) continue;
      entry.leaving = true;
      const remove = () => { entry.node.remove(); if (map.get(key) === entry) map.delete(key); group.hidden = !map.size; };
      if (reduceMotion()) remove();
      else { entry.node.classList.add("leaving"); setTimeout(remove, LEAVE_MS); }
    }
    group.hidden = !rows.length && ![...map.values()].some((e) => e.leaving);
  }
  function paintList(container, model) {
    const work = container.querySelector(".switch-grp-work") ?? container.appendChild(el("div", "switch-grp switch-grp-work"));
    const stop = container.querySelector(".switch-grp-stop") ?? container.appendChild(el("div", "switch-grp switch-grp-stop"));
    const since = model.since ? t("switch.since", { time: fmt.time(model.since) }) : "";
    syncGroup(work, t("switch.listTitle"), since, model.rows ?? [], false);
    syncGroup(stop, t("switch.stoppersTitle"), "", model.stoppers ?? [], true);
    container.hidden = work.hidden && stop.hidden;
  }
  function paintAfter(node, model) {
    const show = (model.rows ?? []).length > 0 && ["wait", "manual"].includes(model.kind);
    node.hidden = !show;
    if (!show) return;
    // 「中断した会話は ⚠ で残り、「再開」で続けられます。…」。訳文の {{mark}} の位置に三角を置く
    const [before, after = ""] = t("switch.after", { mark: MARK }).split(MARK);
    node.replaceChildren(before, warnMark(t("interrupt.markName")), after);
  }

  /** ボタン列。内容が同じなら作り直さない（キーボードのフォーカスを保つ） */
  function paintActs(box, name, buttons, { end = false } = {}) {
    const sig = JSON.stringify([buttons, end, acting]);
    if (sigs.get(name) === sig) return;
    sigs.set(name, sig);
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.act ?? "" : null;
    box.classList.toggle("end", end);
    box.replaceChildren(...buttons.map((b) => {
      const button = el("button", `btn${b.primary ? " btn-primary" : ""}`, b.label);
      button.type = "button";
      button.disabled = acting && !b.toggle && !b.dismiss;
      button.dataset.act = b.act ?? (b.toggle ? "toggle" : "dismiss");
      if (b.toggle) { button.setAttribute("aria-expanded", String(open)); button.setAttribute("aria-controls", "switchDetail"); }
      button.onclick = () => click(b);
      return button;
    }));
    if (focused) box.querySelector(`[data-act="${CSS.escape(focused)}"]`)?.focus();
  }
  function click(b) {
    if (b.toggle) { open = !open; paint(); return; }
    if (b.dismiss) { try { sessionStorage.setItem(dismissKey(), "yes"); } catch {} paint(); onChange(); $("settings")?.focus(); return; }
    acting = true;
    paint();
    Promise.resolve(bridge.act(b.act)).catch(() => {}).finally(() => { setTimeout(() => { if (acting) { acting = false; paint(); } }, 3000); });
    if (b.act === "later") $("settings")?.focus();
  }

  function paintNotice() {
    const notice = $("switchNotice");
    const model = noticeModel(state, { dismissed: isDismissed() });
    notice.hidden = !model;
    if (!model) return;
    const title = $("switchTitle");
    const role = model.kind === "failed" ? "alert" : "status";
    if (title.getAttribute("role") !== role) { title.setAttribute("role", role); title.setAttribute("aria-live", role === "alert" ? "assertive" : "polite"); }
    if (title.textContent !== model.title) title.replaceChildren(...(model.kind === "failed" ? [warnMark(t("switch.failedMark")), el("span", "", model.title)] : [model.title]));
    notice.classList.toggle("fail", model.kind === "failed");
    const sub = $("switchSub");
    const subText = model.kind === "wait" && model.error ? [model.sub, model.error].filter(Boolean).join(" ") : model.sub ?? "";
    sub.hidden = !subText;
    sub.textContent = subText;
    if (model.error) sub.setAttribute("role", "alert"); else sub.removeAttribute("role");
    $("switchProgress").hidden = !["stopping", "switching"].includes(model.kind);
    const listed = ["wait", "ask", "manual"].includes(model.kind);
    const expanded = model.kind === "wait" ? open : listed;
    $("switchDetail").classList.toggle("open", expanded);
    $("switchDetail").hidden = !listed;
    if (listed) { paintList($("switchList"), model); paintAfter($("switchAfter"), model); }
    paintActs($("switchActs"), "notice", actionsFor(model.kind, { open }), { end: expanded });
  }

  function paintPage() {
    const box = $("switchBox");
    if (!box) return;
    const kind = state ? pageKind(state) : null;
    const progress = state && ["stopping", "switching"].includes(state.phase);
    box.hidden = !kind && !progress;
    if (box.hidden) return;
    const model = kind ? { kind, rows: switchWorkRows(state.items), stoppers: switchStopperRows(state.stoppers), since: state.since } : { kind: "none", rows: [], stoppers: [] };
    // 止まるものだけが残ったとき（ask）は止まるものだけ。合わない版・待ちは作業も並べる
    if (kind === "ask") model.rows = [];
    $("switchPageList").hidden = !kind;
    if (kind) { paintList($("switchPageList"), model); paintAfter($("switchPageAfter"), model); } else $("switchPageAfter").hidden = true;
    $("switchPageProgress").hidden = !progress;
    paintActs($("switchPageActs"), "page", kind ? actionsFor(kind, { page: true }) : [], { end: true });
  }

  function paint() {
    paintNotice();
    paintPage();
  }
  function apply(payload) {
    const next = readSwitchState(payload);
    acting = false;
    // 失敗の知らせを閉じた後でも、次の失敗（at が変わる）はまた出る
    state = next;
    paint();
    onChange();
  }

  bridge.onState?.(apply);
  try { bridge.hello?.(); } catch {}
  Promise.resolve(bridge.state?.()).then(apply, () => {});

  return {
    /** 切り替えを待っている（⚙ の点を出す） */
    get pending() { return Boolean(state && PENDING.has(state.phase)); },
    /** 「更新しました」を出さない間（切り替えが済むまで。失敗して前の版で動いている間も）。切り替わった後の画面（done）と、何も無いときは出す */
    get holdsNotice() { return Boolean(state && state.phase !== "done"); },
    get state() { return state; },
    /** 設定のページの状態の字とヒント（出さないなら null） */
    page() { return pageModel(state); },
    /** 切り替わった直後の「止めたもの: …」（更新しました の知らせに足す。無ければ空） */
    stoppedText() { return state?.phase === "done" ? stoppedText(state.stopped, agentName) : ""; },
    /** 会話の名前・エージェント名が変わった（一覧を描き直す） */
    refresh() { if (state) paint(); },
  };
}
