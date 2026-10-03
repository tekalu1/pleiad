// ルーティンの入口の部品: 見出しの［ルーティン n］・bot のページの「ルーティン」の節・時刻と状態の言い回し。
// シートそのものは routine-sheet.mjs（document の channels:routine で開く）。一覧は routine-store.mjs。
// 入口はどれもこのファイルの openRoutine を呼ぶだけで、シートの有無は知らない（シートが無ければ何も起きない）。
import { el, svgEl } from '../dom.mjs';
import { t, fmt } from '../i18n.mjs';
import { getRoutineStore } from './routine-store.mjs';
import { dayKind, triggerText, lastFailed, sortForSide } from './routine-model.mjs';

export const CLOCK = 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2';
const PLUS = 'M12 5v14M5 12h14';

export const glyph = (d, cls = 'i') => {
  const svg = svgEl('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const p of [].concat(d)) svg.append(svgEl('path', { d: p }));
  return svg;
};

/** シートを開く。detail: { routineId } で編集、{ channelId?, botId? } で新規 */
export const openRoutine = (detail = {}) => document.dispatchEvent(new CustomEvent('channels:routine', { detail }));

/** 次に動く時刻の言い回し: 今日 23:00 / 明日 9:00 / 10/6（月）9:00 */
export function whenText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const time = fmt.time(at, { hour: 'numeric', minute: '2-digit' });
  const kind = dayKind(at, now);
  if (kind === 'today') return t('channels:routines.when.today', { time });
  if (kind === 'tomorrow') return t('channels:routines.when.tomorrow', { time });
  return t('channels:routines.when.date', { date: fmt.dateTime(at, { month: 'numeric', day: 'numeric', weekday: 'short' }), time });
}

/** 実行の状態の言い回し。失敗は「✕ 失敗」、成功を緑の ✓ では見せない（文字だけ） */
export function stateText(state) {
  if (!state) return '';
  // i18n-dynamic: channels:feed.state.
  const label = t(`channels:feed.state.${state}`);
  return state === 'failed' ? `✕ ${label}` : label;
}

// ---------------------------------------------------------------- チャンネルの見出し［ルーティン n］

/**
 * チャンネルの見出しに置く［ルーティン n］。n はこのチャンネルのルーティンの数（0 なら数を付けない）。
 * 押すと、無ければ作るシート、あれば「そのルーティン… / ルーティンを作る」のメニュー（host.showMenu）。
 * 見出しが描き直されて外れたら、自分で購読をやめる
 */
export function headingButton(host, channel) {
  const store = getRoutineStore(host);
  const b = el('button', 'btn ch-routines');
  b.type = 'button';
  const count = el('span', 'rt-n');
  b.append(glyph(CLOCK), el('span', 'rtl', t('channels:routines.heading')), count);
  const paint = () => {
    const n = store.forChannel(channel.id).length;
    count.textContent = n ? String(n) : '';
    const label = n ? t('channels:routines.headingTitle', { count: n }) : t('channels:routines.headingNone');
    b.title = label;
    b.setAttribute('aria-label', n ? `${t('channels:routines.heading')} ${n}` : t('channels:routines.heading'));
  };
  const off = store.subscribe(() => { if (!b.isConnected && off) { off(); return; } paint(); });
  paint();
  b.onclick = (e) => {
    const mine = store.forChannel(channel.id);
    if (!mine.length || !host.showMenu) { openRoutine({ ...(mine.length === 1 ? { routineId: mine[0].id } : { channelId: channel.id }) }); return; }
    const r = b.getBoundingClientRect();
    host.showMenu(Math.round(r.left), Math.round(r.bottom + 4), [
      ...mine.map((x) => ({ label: `${x.name}${x.paused ? ` · ${t('channels:routines.paused')}` : ''}`, onClick: () => openRoutine({ routineId: x.id }) })),
      { label: t('channels:routines.new'), onClick: () => openRoutine({ channelId: channel.id }) },
    ], t('channels:routines.headingMenu', { name: channel.name }));
    e.stopPropagation();
  };
  return b;
}

// ---------------------------------------------------------------- bot のページの「ルーティン」の節

/**
 * bot のページ（bot-page.mjs が持つ #botView）の左の列の末尾に置く節。その bot のルーティンの行（名前・読み・次の時刻）と［ルーティンを作る］。
 * bot-page.mjs は触らず、routine-sheet.mjs の show(view) が #botView の中へ差し込む
 */
export function botBlock(host) {
  const store = getRoutineStore(host);
  const root = el('div', 'bp-blk bp-routines');
  root.id = 'botRoutines';
  const title = el('h4', null, t('channels:routines.title'));
  const list = el('div', 'bp-rt-list');
  const add = el('button', 'btn bp-rt-add');
  add.type = 'button';
  add.append(glyph(PLUS), t('channels:routines.new'));
  root.append(title, list, add);
  let botId = null, channels = new Map();
  const paint = () => {
    const mine = botId ? sortForSide(store.forBot(botId)) : [];
    const rows = mine.map((r) => {
      const row = el('button', `bp-rt${r.paused ? ' paused' : ''}`);
      row.type = 'button';
      row.dataset.id = r.id;
      const ch = channels.get(r.channelId);
      const meta = [triggerText(r.trigger, t), ch ? `#${ch.name}` : ''].filter(Boolean).join(' · ');
      const when = r.paused ? t('channels:routines.paused') : whenText(r.nextAt);
      row.append(el('span', 'bp-rt-name', r.name), el('span', 'bp-rt-meta', meta));
      if (lastFailed(r)) row.append(el('span', 'bp-rt-fail', stateText('failed')));
      if (when) row.append(el('span', 'bp-rt-when', when));
      row.onclick = () => openRoutine({ routineId: r.id });
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [el('p', 'bp-empty', t('channels:routines.botEmpty'))]));
  };
  store.subscribe(() => { if (root.isConnected) paint(); });
  add.onclick = () => openRoutine({ botId });
  return {
    el: root,
    /** bot が替わった（null なら畳む）。channels は id → Channel（名前の字に使う） */
    setBot(id, byId) { botId = id; channels = byId ?? channels; root.hidden = !id; paint(); },
  };
}
