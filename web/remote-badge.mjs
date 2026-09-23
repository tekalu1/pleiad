// リモートの窓の印（docs/remote.md §7.2 の 1。承認済みのモック docs/mockups/remote-window.html）。
// 端末のアプリ（デスクトップ版の desktop/remote-preload.cjs）が window.plyRemote を渡したときだけ描く。
// 帯の左にホスト名のバッジを常に出す（閉じるボタンは無い）。押すと接続の情報と「この窓を閉じる」の小さな面。
// 帯の色は style.css の :root.remote .titlebar（client.mjs の paintTitleBar が読んで OS へ送る）。
// つながらないとき（中継・ホストがオフライン）はバッジに状態を添え、面に「再試行」を出す。取り消されたら本体が読み直して
// プロキシの案内のページを出す（desktop/remote-windows.cjs）。
import { t, fmt } from './i18n.mjs';
import { el, icon } from './dom.mjs';

const ARROWS = 'M4 8h13l-3-3M20 16H7l3 3';
const RETRYABLE = new Set(['offline', 'host-offline']);
const STATES = new Set(['connecting', 'connected', 'offline', 'host-offline', 'revoked', 'stopped']);

/** plyRemote を画面で使う形に。無い・形が違えば null（ローカルの窓・ブラウザー版） */
export function remoteInfo(remote) {
  if (!remote || typeof remote !== 'object' || typeof remote.hostId !== 'string' || !remote.hostId) return null;
  const text = v => (typeof v === 'string' ? v : '');
  return { hostId: remote.hostId, host: text(remote.hostName) || remote.hostId.slice(0, 8), relay: text(remote.relay), device: text(remote.device), shell: text(remote.shell) || 'desktop' };
}

/** バッジと面に出すもの。status は plyRemote.status() / onStatus の値（無ければ接続中とみなす） */
export function badgeView(info, status) {
  const state = STATES.has(status?.state) ? status.state : 'connected';
  return {
    host: info.host,
    label: t('remote.badgeLabel'),
    // i18n-dynamic: remote.state.
    stateText: t(`remote.state.${state}`),
    // つながっている間はバッジに状態を書かない（常に出るので短く）。それ以外は添える
    suffix: state === 'connected' ? '' : t(`remote.state.${state}`),
    title: t('remote.badgeTitle', { host: info.host }),
    state,
    connectedAt: Number.isFinite(status?.connectedAt) ? status.connectedAt : null,
    retry: RETRYABLE.has(state),
  };
}

/**
 * バッジと面を作って帯に置く。plyRemote が無ければ何もしない（null）。
 *   remote: window.plyRemote、doc: document
 */
export function setupRemoteBadge({ remote = globalThis.window?.plyRemote, doc = globalThis.document } = {}) {
  const info = remoteInfo(remote);
  if (!info || !doc?.body) return null;
  doc.documentElement.classList.add('remote');

  const badge = el('button', 'remote-badge');
  badge.type = 'button';
  badge.id = 'remoteBadge';
  badge.setAttribute('aria-expanded', 'false');
  badge.setAttribute('aria-controls', 'remotePop');
  const label = el('span', 'lbl'), host = el('span', 'host'), suffix = el('span', 'state');
  badge.append(icon(ARROWS), label, host, suffix);

  const pop = el('div', 'pop remote-pop');
  pop.id = 'remotePop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('remote.pop.label'));
  const heading = el('b', 'remote-host');
  const facts = el('dl');
  const acts = el('div', 'acts');
  const retry = el('button', 'btn', t('remote.pop.retry'));
  retry.type = 'button';
  const close = el('button', 'btn', t('remote.pop.close'));
  close.type = 'button';
  acts.append(retry, close);
  pop.append(heading, facts, acts);

  let view = badgeView(info, null);
  function paint(status) {
    if (status !== undefined) view = badgeView(info, status);
    label.textContent = view.label;
    host.textContent = view.host;
    suffix.textContent = view.suffix ? `· ${view.suffix}` : '';
    suffix.hidden = !view.suffix;
    badge.title = view.title;
    badge.dataset.state = view.state;
    heading.textContent = view.host;
    const rows = [[t('remote.pop.state'), view.stateText]];
    if (info.relay) rows.push([t('remote.pop.relay'), info.relay]);
    if (view.connectedAt) rows.push([t('remote.pop.connectedAt'), fmt.dateTime(view.connectedAt)]);
    if (info.device) rows.push([t('remote.pop.device'), info.device]);
    facts.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
    retry.hidden = !view.retry;
  }
  function setOpen(open) {
    pop.hidden = !open;
    badge.setAttribute('aria-expanded', String(open));
  }
  badge.onclick = e => { e.stopPropagation(); setOpen(pop.hidden); };
  pop.addEventListener('click', e => e.stopPropagation());
  doc.addEventListener('click', () => setOpen(false));
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); badge.focus(); } });
  retry.onclick = () => { Promise.resolve(remote.retry?.()).catch(() => {}); };
  close.onclick = () => { remote.closeWindow?.(); };

  // 帯（.titlebar）の直後に置く。帯は掴んで窓を動かす場所で aria-hidden なので、押せるバッジは帯の外の要素にする
  const bar = doc.querySelector('.titlebar');
  if (bar) bar.after(badge, pop); else doc.body.prepend(badge, pop);
  paint();
  Promise.resolve(remote.status?.()).then(s => { if (s) paint(s); }).catch(() => {});
  remote.onStatus?.(s => paint(s));
  return { badge, pop, paint, view: () => view };
}
