// 中断した会話の見せ方（docs/design-system.md「中断と再開」、ADR 0036）。
// 中断はサーバーが会話ごとの状態として持つ（client のセッションの interrupted: {at, reason} | null、turnEnd にも載る）。
// 次のターンが始まったら消える。ここは印・文言・数え方だけを持ち、DOM の置き場所は client.mjs と side.mjs が決める。
import { svgEl } from "./dom.mjs";
import { t } from "./i18n.mjs";

// i18n-dynamic: interrupt.label.
// i18n-dynamic: interrupt.line.
/** 理由。user = 中断ボタン、update = 更新のため、quit = 終了のため、restart = 落ちた・強制終了、hostAway = ホスト不在の猶予切れ */
export const REASONS = ["user", "update", "quit", "restart", "hostAway"];
/** 行の 2 行目に理由の字も出す理由（自分で押した中断ではないもの。モックの場面 5） */
const META_REASONS = new Set(["update", "quit", "restart"]);

/** 知らない理由・欠けた理由は user と読む（サーバーの abort と同じ） */
export const reasonOf = (interrupted) => (REASONS.includes(interrupted?.reason) ? interrupted.reason : "user");

/** 中断状態か。interrupted が null・undefined なら違う */
export const isInterrupted = (session) => Boolean(session?.interrupted && typeof session.interrupted === "object");

/**
 * 未読か。readAt は確認済みの完了時刻（サーバーの markRead が completedAt までに丸める）。
 * 中断で終わったターンは interrupted.at と completedAt がほぼ同じなので、小さい方と比べる
 * （at だけと比べると、丸められた readAt が永遠に届かず未読のままになる）
 */
export function interruptUnread(session, readAt) {
  if (!isInterrupted(session)) return false;
  const at = Number(session.interrupted.at);
  const done = Number.isFinite(session.completedAt) ? session.completedAt : at;
  const point = Number.isFinite(at) ? Math.min(at, done) : done;
  return Number.isFinite(point) && point > (Number.isFinite(readAt) ? readAt : 0);
}

/** 確認したとして送る時刻（完了と中断の大きい方。サーバーが completedAt に丸める） */
export function interruptReadPoint(session) {
  const at = Number(session?.interrupted?.at);
  return Math.max(Number.isFinite(session?.completedAt) ? session.completedAt : 0, Number.isFinite(at) ? at : 0);
}

/** 行の 2 行目に理由の字を出すか */
export const showsReasonInMeta = (interrupted) => META_REASONS.has(reasonOf(interrupted));
/** 短い理由（三角の title・行の 2 行目）。「中断」「更新のため中断」 */
export const interruptLabel = (interrupted) => t(`interrupt.label.${reasonOf(interrupted)}`);
/** 会話の末尾の一行の文。「中断しました」「Pleiad の更新のため中断しました」 */
export const interruptLineText = (interrupted) => t(`interrupt.line.${reasonOf(interrupted)}`);

/**
 * 注意の三角（14px・線 1.6・角丸・「!」）。未読は --ink、既読は --ink-weak（.read）。
 * 承認待ちの差し色（--ink-mark）は使わない（あなた待ちと見分けがつかなくなる）
 */
export function warnMark(label, { read = false } = {}) {
  const svg = svgEl("svg", { viewBox: "0 0 14 14", class: `warn-mark${read ? " read" : ""}`, role: "img", "aria-label": label });
  const title = svgEl("title");
  title.textContent = label;
  svg.append(title,
    svgEl("path", { d: "M6.1 2.6a1 1 0 0 1 1.8 0l4.9 8.4a1 1 0 0 1-.9 1.5H2.1a1 1 0 0 1-.9-1.5z" }),
    svgEl("path", { d: "M7 6v2.4M7 10.35v.01" }));
  return svg;
}

/** 会話の末尾の「■ 中断しました」の四角（中断ボタンの四角と同じ形を 14px に） */
export function stopMark() {
  const svg = svgEl("svg", { viewBox: "0 0 14 14", class: "stop-mark", "aria-hidden": "true" });
  svg.append(svgEl("rect", { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.6 }));
  return svg;
}

/** 再開の再生の三角（24×24、既存のアイコンと同じ線画） */
export const PLAY_PATH = "M8.5 6.2v11.6a.8.8 0 0 0 1.2.7l9-5.8a.8.8 0 0 0 0-1.4l-9-5.8a.8.8 0 0 0-1.2.7z";

/** 中断で保留になった未送信の数（再開はこれを送る） */
export const pausedCount = (messages) => (messages ?? []).filter((m) => m?.status === "paused").length;

/** 再開ボタンの字。保留があれば「保留中の N 件を送って再開」 */
export const resumeLabel = (paused) => (paused > 0 ? t("interrupt.resumeOutbox", { count: paused }) : t("interrupt.resume"));

/** 入力欄の下の一行。保留があれば「送ると、保留中の N 件の後にこの指示で続けます」（サーバーが保留を先に送り直す） */
export const resumeNoteText = (paused) => (paused > 0 ? t("interrupt.resumeNoteHeld", { count: paused }) : t("interrupt.resumeNote"));

/**
 * 再開ボタンを出すか。中断状態・走っていない・承認を待っていない・入力欄が空のとき。
 * 字があれば隠す（送ればその指示で続く。方針を変える道）
 */
export function resumeVisible({ interrupted, running, waiting, text, attached }) {
  return Boolean(interrupted) && !running && !waiting && !String(text ?? "").trim() && !attached;
}

/**
 * 更新で止めた会話のうち、まだ閉じていない分（脇の下の「更新で中断した会話が N 件あります」）。
 * dismissedAt は × で閉じたときの最大の at（localStorage）。それより新しい中断があれば、また出す。
 * startedAt（サーバーの起動時刻。ready で届く）を渡したら、それより前の中断だけを数える。更新で Pleiad が
 * 再起動したときだけ出すため（中断した後に更新が失敗した・30 秒で止まらなかったなら、サーバーは起動し直していない）
 */
export function updateInterrupted(sessions, dismissedAt = 0, { startedAt } = {}) {
  const before = startedAt === undefined ? Infinity : Number(startedAt);
  const list = (sessions ?? []).filter((s) => isInterrupted(s) && reasonOf(s.interrupted) === "update" && !s.delegation
    && Number(s.interrupted.at) < before);
  const maxAt = list.reduce((m, s) => Math.max(m, Number(s.interrupted.at) || 0), 0);
  return { ids: list.map((s) => s.id), maxAt, show: list.length > 0 && maxAt > (Number(dismissedAt) || 0) };
}

/**
 * 更新の確認に並べる、止まる作業。running（server の runningWork）から会話ごとに 1 行。
 * ターンが走っていれば「実行中」、承認だけを待っていれば「承認待ち」（中継の複製は数えない）
 */
export function workRows(work) {
  const rows = new Map();
  for (const turn of work?.turns ?? []) {
    if (!turn?.sessionId || rows.has(turn.sessionId)) continue;
    rows.set(turn.sessionId, { sessionId: turn.sessionId, state: "running", backend: turn.backend ?? null });
  }
  for (const p of work?.permissions ?? []) {
    if (!p?.sessionId || p.relay) continue;
    const row = rows.get(p.sessionId);
    if (row) row.state = "waiting";
    else rows.set(p.sessionId, { sessionId: p.sessionId, state: "waiting", backend: null });
  }
  return [...rows.values()];
}

/** 脇の更新の知らせに足す件数（実行中 N 件・承認待ち M 件） */
export function workCounts(work) {
  const rows = workRows(work);
  return { running: rows.filter((r) => r.state === "running").length, waiting: rows.filter((r) => r.state === "waiting").length };
}

/** 中断の進み。total は押した時点の件数、count は今の件数。done は止まった数（戻らない） */
export function interruptProgress(total, count, prevDone = 0) {
  const all = Math.max(0, Number(total) || 0);
  const done = Math.min(all, Math.max(prevDone, all - Math.max(0, Number(count) || 0)));
  return { done, total: all, finished: (Number(count) || 0) <= 0 };
}
