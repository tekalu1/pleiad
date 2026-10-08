// エージェントの Chrome の窓の「状態の一行」と止める・引き継ぐ・戻す（docs/design-system.md「Chrome の窓の状態の一行」、ADR 0148・0154）。
//   - createChromeControlView: 状態の一行（role=status。ボタンは「止める」「引き継ぐ」「Claude に戻す」）・一時停止中の帯（会話の中）・
//     映像の上に重ねる、エージェントが押した位置の輪。単体で描けて試せる。右パネルの「Chrome の窓」へは web/chrome-panel.mjs の mountStatus（root）・mountOverlay（overlay）で差し込む。
//     撮影を断っている間の薄い幕と「映像を止めています」は映像の側（web/chrome-panel.mjs の .cp-veil）が出す（二重にしない）
//   - chromeControlStore: サーバーの chromeControl・chromeTap イベント（会話ごと）の置き場。右パネルが会話の状態を引く・聞く
//   - renderChromeHandoverLine: 引き継いで戻したときの会話の行（present kind: 'chromeHandover'）
// 状態は core/chrome/control.mjs の 4 つ（running・idle・stopped・paused）。色は既存のトークンだけ。動きは --dur・--ease-out（動きを減らす設定では入れ替えだけ）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';

export const CONTROL_STATES = ['running', 'idle', 'stopped', 'paused'];

/** 状態の一行の語（running は {{name}} が操作中）。state が無ければ null */
export function statusText(state, name, error = null) {
  if (error === 'conceal-failed') return t('chromeControl.error.concealFailed');
  if (state === 'running') return t('chromeControl.status.running', { name });
  if (state === 'idle') return t('chromeControl.status.idle');
  if (state === 'paused') return t('chromeControl.status.paused');
  if (state === 'stopped') return t('chromeControl.status.stopped');
  return null;
}

/** 状態ごとに出すボタン（上から順）。止めた・待機中は「引き継ぐ」だけ。一時停止中は「戻す」だけ（待機中の「Chrome で開く」は「引き継ぐ」に一本化。ADR 0154） */
export function actionsFor(state) {
  if (state === 'running') return ['stop', 'takeOver'];
  if (state === 'paused') return ['resume'];
  if (state === 'idle' || state === 'stopped') return ['takeOver'];
  return [];
}

/** 経過時間（1 分 12 秒・45 秒） */
export function durationText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? t('chromeControl.duration.minutes', { m, s }) : t('chromeControl.duration.seconds', { s });
}

/** 押した位置の輪が残る時間（ms）。輪の動きは CSS（動きを減らす設定では薄く出て消えるだけ） */
const RING_MS = 700;

/**
 * @param {object} o
 * @param {(action: 'takeOver'|'resume'|'stop') => Promise<any>} o.run  押されたときに呼ぶ（browser.chromeTakeOver・chromeResume・chromeStop の呼び出し）
 * @param {() => string} [o.getName]  エージェントの名前（「Claude が操作中」「Claude に戻す」）
 * @param {(error: Error, action: string) => void} [o.onError]
 * @returns {{ root: HTMLElement, banner: HTMLElement, overlay: HTMLElement, apply: (next: {state: string, since?: number|null, error?: string|null}|null) => void,
 *            ring: (x: number, y: number, size?: {width: number, height: number}) => void, state: () => string|null, refresh: () => void }}
 */
export function createChromeControlView({ run, getName = () => 'Claude', onError = () => {} } = {}) {
  let current = null;
  let busy = false;
  const root = el('div', 'cc'); root.hidden = true;
  const status = el('span', 'cc-status'); status.setAttribute('role', 'status');
  const dot = el('span', 'cc-dot'); dot.setAttribute('aria-hidden', 'true');
  const text = el('span', 'cc-text');
  status.append(dot, text);
  const buttons = new Map();
  const labels = { stop: () => t('chromeControl.stop'), takeOver: () => t('chromeControl.takeOver'), resume: () => t('chromeControl.resume', { name: getName() }) };
  const act = action => {
    if (busy) return;
    busy = true; paint();
    Promise.resolve().then(() => run(action)).catch(error => onError(error, action)).finally(() => { busy = false; paint(); });
  };
  for (const action of ['stop', 'takeOver', 'resume']) {
    const b = el('button', 'btn cc-btn', labels[action]()); b.type = 'button';
    b.hidden = true; b.onclick = () => act(action);
    buttons.set(action, b);
  }
  root.append(status, ...buttons.values());

  // 一時停止中の帯（会話の中。「一時停止中 · あなたが Chrome で操作しています」）
  // 帯は role=status にしない（状態の一行が同じことを読み上げるので、二重にしない）
  const banner = el('div', 'cc-banner'); banner.hidden = true;
  const bannerText = el('span', 'cc-banner-text');
  const bannerBtn = el('button', 'btn cc-btn', labels.resume()); bannerBtn.type = 'button';
  bannerBtn.onclick = () => act('resume');
  banner.append(bannerText, bannerBtn);

  // 映像の上に重ねる層（親が position: relative の枠に入れる）。押した位置の輪だけを出す
  const overlay = el('div', 'cc-overlay'); overlay.setAttribute('aria-hidden', 'true');

  function paint() {
    const state = current?.state ?? null;
    root.hidden = !state;
    root.dataset.state = state ?? '';
    banner.hidden = state !== 'paused';
    overlay.dataset.state = state ?? '';
    if (!state) return;
    text.textContent = statusText(state, getName(), current.error);
    const allowed = actionsFor(state);
    for (const [action, b] of buttons) {
      b.hidden = !allowed.includes(action);
      b.textContent = labels[action]();
      b.disabled = busy;
    }
    bannerText.textContent = current.error === 'conceal-failed' ? t('chromeControl.error.concealFailed') : t('chromeControl.banner');
    bannerBtn.textContent = labels.resume(); bannerBtn.disabled = busy;
  }

  /** 押した位置に輪を出す。(x, y) は押した位置（ページの CSS 画素）、size は映像の元のページの大きさ。大きさが分からなければ出さない（位置を偽らない） */
  function ring(x, y, size = null) {
    const w = Number(size?.width), h = Number(size?.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return;
    const node = el('span', 'cc-ring');
    node.style.left = `${Math.max(0, Math.min(100, (x / w) * 100))}%`;
    node.style.top = `${Math.max(0, Math.min(100, (y / h) * 100))}%`;
    overlay.append(node);
    setTimeout(() => node.remove(), RING_MS);
  }

  return {
    root, banner, overlay, ring,
    apply(next) { current = next && CONTROL_STATES.includes(next.state) ? { state: next.state, since: next.since ?? null, error: next.error ?? null } : null; paint(); },
    state: () => current?.state ?? null,
    refresh: paint,
  };
}

/**
 * サーバーの chromeControl（会話ごとの状態）と chromeTap（押した位置）の置き場。画面（web/client.mjs）が event を渡し、右パネルが get・onChange・onTap で引く。
 * 待機中（idle）の会話は持たない
 */
export function createChromeControlStore() {
  const states = new Map();
  const changes = new Set(), taps = new Set();
  const fire = (set, ...args) => { for (const fn of [...set]) { try { fn(...args); } catch { /* 聞き手の失敗は置き場を壊さない */ } } };
  return {
    event(ev) {
      if (!ev?.sessionId) return;
      if (ev.type === 'chromeControl') {
        if (!CONTROL_STATES.includes(ev.state)) return;
        const was = states.get(ev.sessionId);
        const before = was?.state ?? 'idle';
        const by = ev.state === 'paused' && (ev.by === 'device' || ev.by === 'pc') ? ev.by : null;
        if (ev.state === 'idle') states.delete(ev.sessionId); else states.set(ev.sessionId, { state: ev.state, since: ev.since ?? null, error: ev.error ?? null, by });
        if (before !== ev.state || (was?.error ?? null) !== (ev.error ?? null) || (was?.by ?? null) !== by) fire(changes, ev.sessionId, ev.state, ev.since ?? null);
      } else if (ev.type === 'chromeTap') fire(taps, { sessionId: ev.sessionId, x: ev.x, y: ev.y, windowId: ev.windowId ?? null });
    },
    /** 会話の今の状態（イベントが無い会話は idle）。by は一時停止中に誰が操作しているか（pc・device。第 7 段） */
    get: sessionId => states.get(sessionId) ?? { state: 'idle', since: null, error: null, by: null },
    onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
    onTap(fn) { taps.add(fn); return () => taps.delete(fn); },
    /** 全部の会話の状態を捨てる（接続し直したとき。サーバーは続けて今の分を送る）。持っていた状態は idle として聞き手へ知らせる */
    clear() { const ids = [...states.keys()]; states.clear(); for (const id of ids) fire(changes, id, 'idle', null); },
  };
}

/** 今の会話のエージェントの名前（会話の行の「Claude に戻しました」。web/client.mjs が入れる） */
let agentName = () => 'Claude';
export const setChromeHandoverAgentName = fn => { if (typeof fn === 'function') agentName = fn; };

const handIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5l-2 3-2-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' }));
  return svg;
};

/** 引き継いで戻したときの会話の行（present kind: 'chromeHandover'。chromeHandover: { seconds }）。「あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒」 */
export function renderChromeHandoverLine(ev) {
  const row = el('div', 'cc-line');
  const icon = el('span', 'cc-line-ic'); icon.setAttribute('aria-hidden', 'true'); icon.append(handIcon());
  row.append(icon, el('span', 'cc-line-t', t('chromeControl.handover', { name: agentName(), duration: durationText(ev?.chromeHandover?.seconds) })));
  return row;
}

export const chromeControlStore = createChromeControlStore();
