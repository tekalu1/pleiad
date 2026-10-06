// 通知ボタンと通知の一覧（承認済み 2026-10-06。docs/design-system.md「通知の一覧」、ADR 0149）。
// 脇の頭（ロゴの右）のベル → 浮く面（広い幅はポップ、700px 以下は下からのシート）。サーバーの notifications.*（core/ops/notifications.mjs）を読む。
//
//   ベル … 未読があれば右上に件数。あなた待ちが（未読で）あれば ◆ を前に付ける。件数はベルの名前（aria-label）にも入れる
//   面   … 絞り込み（すべて | あなた待ち | @あなた）と［すべて既読］。行 = 左に未読の青い丸・種類の記号（◆ あなた待ち・✕ 失敗・✓ 完了・@ メンション）・
//          1 行目に何が起きたか・2 行目に場所と時刻。決着したあなた待ちは ◇ と「承認済み」などを弱く出す。空は「新しい通知はありません」
//   行を押す／Enter … 面を閉じ、通知先（会話とその発言、またはチャンネル・スレッド・投稿）を開く（open(target)。着いた発言・投稿の強調は開く側）
//   キー … ベルで Enter → 面（一覧に焦点）、↑↓ で行、Home / End、Enter で飛ぶ、Esc で閉じてベルへ戻る。面の外を押しても閉じる
//
// 件数は notificationsChanged（{ unread, waiting }）で動かす。一覧は開いたときと、開いている間の変化で読み直す（件数だけのときは読まない）。
// 文の組み立て（describeNotification）と件数の印（badgeState）は DOM を持たない関数で、tests/unit/notification-inbox-ui.mjs が見る。
import { el } from './dom.mjs';

const FILTERS = ['all', 'wait', 'mention'];
const COUNT_CAP = 99;

// i18n-dynamic: inbox.line.
// i18n-dynamic: inbox.outcome.
// i18n-dynamic: inbox.filter.
/** 通知 1 件の見せ方。{ icon, line, place, outcome, label }。titleOf(sessionId) は今の会話の題（無ければ控えの題） */
export function describeNotification(n, t, titleOf = () => '') {
  const live = n.target?.sessionId ? titleOf(n.target.sessionId) : '';
  const title = live || n.title || '';
  const name = n.actor?.name || '';
  const open = n.kind === 'wait' && n.resolvedAt == null;
  let line;
  if (n.kind === 'wait') {
    const what = n.ask === 'question' ? 'question' : 'approval';
    line = t(`inbox.line.${what}.${name ? 'named' : 'plain'}.${open ? 'open' : 'closed'}`, { name });
  } else if (n.kind === 'failed') {
    line = name ? t('inbox.line.failed.named', { name }) : title ? t('inbox.line.failed.titled', { title }) : t('inbox.line.failed.plain');
  } else if (n.kind === 'done') {
    line = title ? t('inbox.line.done.titled', { title }) : t('inbox.line.done.plain');
  } else {
    line = name ? t('inbox.line.mention.named', { name }) : t('inbox.line.mention.plain');
  }
  // 場所: チャンネルのスレッドは「#チャンネル › スレッドの題」、それ以外は「Chats › 会話の題」
  let place = '';
  if (n.target?.channelId) {
    place = n.channelName
      ? (n.threadTitle ? t('inbox.place.thread', { channel: n.channelName, thread: n.threadTitle }) : t('inbox.place.channel', { channel: n.channelName }))
      : (n.threadTitle || '');
  } else if (n.target?.sessionId) place = t('inbox.place.chat', { title: title || t('session.untitled') });
  const outcome = n.kind === 'wait' && n.outcome ? t(`inbox.outcome.${n.outcome}`) : '';
  const icon = n.kind === 'wait' ? (open ? 'wait' : 'closed') : n.kind;
  return { icon, line, place, outcome, open };
}

/** ベルの印。waiting は未読のあなた待ち。{ text, wait, label }（text が '' なら印なし） */
export function badgeState({ unread = 0, waiting = 0 } = {}, t) {
  const n = Math.max(0, unread | 0);
  const text = n > COUNT_CAP ? `${COUNT_CAP}+` : n ? String(n) : '';
  const wait = waiting > 0;
  const label = !n ? t('inbox.bell') : wait ? t('inbox.bellWait', { n }) : t('inbox.bellUnread', { n });
  return { text, wait, label, show: Boolean(n || wait) };
}

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.bell      ベルのボタン（脇の頭）
 * @param {HTMLElement} o.panel           面（#notifPanel。hidden で始まる）
 * @param {HTMLElement} o.veil            シートの後ろの幕（狭い幅）
 * @param {(op: string, args?: object) => Promise<any>} o.invoke
 * @param {(key: string, params?: object) => string} o.t
 * @param {(when: number) => string} o.relTime
 * @param {(sessionId: string) => string} [o.titleOf]    今の会話の題
 * @param {(target: object) => void} o.open              通知先を開く（会話・その発言 uuid、またはチャンネル・スレッド・投稿）
 * @param {MediaQueryList} o.narrow                      700px 以下
 * @param {() => Element|null} [o.anchor]                ポップの左端をそろえる要素（脇）
 */
export function setupNotificationInbox({ bell, panel, veil, invoke, t, relTime, titleOf = () => '', open, narrow, anchor = () => null }) {
  const S = { unread: 0, waiting: 0, items: [], hasMore: false, filter: 'all', active: 0, isOpen: false, seq: 0, timer: 0 };
  let list, empty, more, head, filterBtns, readAll, badge;

  // ---- ベル
  function paintBell() {
    const b = badgeState(S, t);
    bell.setAttribute('aria-label', b.label);
    bell.title = t('inbox.bell');
    badge ??= bell.querySelector('.bell-badge');
    if (!b.show) { badge?.remove(); badge = null; return; }
    if (!badge) { badge = el('span', 'bell-badge'); badge.setAttribute('aria-hidden', 'true'); bell.append(badge); }
    badge.replaceChildren();
    if (b.wait) badge.append(el('span', 'mark', '◆'));
    if (b.text) badge.append(document.createTextNode(b.text));
  }

  // ---- 面の骨組み（1 回だけ）
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('inbox.panel'));
  head = el('div', 'nhead');
  const seg = el('div', 'nseg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('inbox.filter.label'));
  filterBtns = FILTERS.map((f) => {
    const b = el('button', null, t(`inbox.filter.${f}`)); b.type = 'button'; b.dataset.filter = f;
    b.onclick = () => { S.filter = f; S.active = 0; paintFilters(); load(); };
    seg.append(b);
    return b;
  });
  readAll = el('button', 'btn', t('inbox.readAll')); readAll.type = 'button';
  readAll.onclick = async () => { await invoke('notifications.markRead', { all: true }).catch(() => {}); await load(); };
  head.append(seg, el('span', 'grow'), readAll);
  list = el('div', 'nlist'); list.setAttribute('role', 'listbox'); list.tabIndex = 0; list.setAttribute('aria-label', t('inbox.list'));
  empty = el('div', 'nempty', t('inbox.empty'));
  more = el('button', 'nmore', t('inbox.more')); more.type = 'button'; more.hidden = true;
  more.onclick = () => loadMore();
  panel.replaceChildren(head, list, more);
  panel.hidden = true;
  const paintFilters = () => { for (const b of filterBtns) b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter)); };
  paintFilters();

  // ---- 行
  const ICON = {
    wait: () => el('span', 'nk ask', '◆'),   // .wait は style.css が ◆ を足すので別の名前
    closed: () => el('span', 'nk', '◇'),
    done: () => svgIcon('M5 12.5 9.5 17 19 7.5'),
    failed: () => svgIcon('M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5'),
    mention: () => el('span', 'nk at', '@'),
  };
  function svgIcon(d) {
    const wrap = el('span', 'nk');
    wrap.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;   // 固定の path だけ
    return wrap;
  }
  const rowId = (n) => `notif-${n.id}`;
  function rowEl(n, index) {
    const d = describeNotification(n, t, titleOf);
    const row = el('div', 'nrow');
    row.id = rowId(n); row.dataset.n = n.id; row.setAttribute('role', 'option');
    row.classList.toggle('unread', n.unread);
    const dot = el('span', 'nd');
    if (n.unread) { const u = el('span', 'udot'); dot.append(u); }
    const body = el('span', 'nb');
    body.append(el('span', 'nt', d.line), el('span', 'nm', [d.place, relTime(n.at)].filter(Boolean).join(' · ')));
    const icon = ICON[d.icon]();
    row.append(dot, icon, body);
    if (d.outcome) row.append(el('span', 'ns', d.outcome));
    // 読み上げ: 未読か・何が起きたか・場所と時刻（記号は aria-hidden 相当にして名前に含めない）
    row.setAttribute('aria-label', [n.unread ? t('inbox.unreadMark') : '', d.line, d.place, relTime(n.at), d.outcome].filter(Boolean).join(' · '));
    row.onclick = () => go(n);
    row.onpointermove = () => { if (S.active !== index) { S.active = index; paintActive(false); } };
    return row;
  }
  function paint() {
    const keep = S.items[S.active]?.id;
    list.replaceChildren();
    if (!S.items.length) list.append(empty);
    else S.items.forEach((n, i) => list.append(rowEl(n, i)));
    if (keep) { const i = S.items.findIndex((n) => n.id === keep); if (i >= 0) S.active = i; }
    S.active = Math.min(S.active, Math.max(0, S.items.length - 1));
    more.hidden = !S.hasMore;
    readAll.disabled = !S.unread;
    paintActive(false);
  }
  function paintActive(scroll = true) {
    const rows = [...list.querySelectorAll('.nrow')];
    rows.forEach((r, i) => { r.classList.toggle('on', i === S.active); r.setAttribute('aria-selected', String(i === S.active)); });
    const on = rows[S.active];
    if (on) { list.setAttribute('aria-activedescendant', on.id); if (scroll) on.scrollIntoView({ block: 'nearest' }); }
    else list.removeAttribute('aria-activedescendant');
  }

  // ---- 読み込み
  async function load() {
    const seq = ++S.seq;
    try {
      const r = await invoke('notifications.list', { filter: S.filter, limit: 50 });
      if (seq !== S.seq) return;
      S.items = r.items ?? []; S.hasMore = r.hasMore === true; S.unread = r.unread ?? 0; S.waiting = r.waiting ?? 0;
      paintBell();
      if (S.isOpen) paint();
    } catch { /* つながっていない間は今の表示のまま（つなぎ直すと reconnected が読み直す） */ }
  }
  async function loadMore() {
    const before = S.items.at(-1)?.seq;
    if (!before) return;
    const seq = S.seq;
    try {
      const r = await invoke('notifications.list', { filter: S.filter, limit: 50, before });
      if (seq !== S.seq) return;
      S.items = [...S.items, ...(r.items ?? [])]; S.hasMore = r.hasMore === true;
      paint();
    } catch { /* 同上 */ }
  }
  async function loadCounts() {
    try {
      const c = await invoke('notifications.count', {});
      S.unread = c.unread ?? 0; S.waiting = c.waiting ?? 0;
      paintBell();
    } catch { /* 同上 */ }
  }

  // ---- 開閉
  function place() {
    panel.classList.toggle('sheet', narrow.matches);
    veil.hidden = !narrow.matches;
    if (narrow.matches) { panel.style.cssText = ''; return; }
    const b = bell.getBoundingClientRect();
    const side = anchor()?.getBoundingClientRect();
    const left = Math.max(8, Math.min((side?.left ?? b.left) + 10, window.innerWidth - 360 - 8));
    const top = b.bottom + 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(240, Math.min(520, window.innerHeight - top - 12))}px`;
  }
  function show() {
    if (S.isOpen) return;
    S.isOpen = true; S.active = 0;
    panel.hidden = false;
    place();
    bell.setAttribute('aria-expanded', 'true');
    paint();
    load();
    list.focus({ preventScroll: true });
  }
  function close(focusBell = true) {
    if (!S.isOpen) return;
    S.isOpen = false;
    panel.hidden = true; veil.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
    if (focusBell && bell.offsetParent) bell.focus({ preventScroll: true });
  }
  function go(n) {
    close(false);
    if (n.unread) {
      n.unread = false;
      S.unread = Math.max(0, S.unread - 1);
      if (n.kind === 'wait' && n.resolvedAt == null) S.waiting = Math.max(0, S.waiting - 1);
      paintBell();
      invoke('notifications.markRead', { ids: [n.id] }).catch(() => {});
    }
    open(n.target ?? {});
  }

  bell.setAttribute('aria-haspopup', 'dialog');
  bell.setAttribute('aria-expanded', 'false');
  bell.onclick = () => (S.isOpen ? close(true) : show());
  veil.onclick = () => close(false);
  document.addEventListener('pointerdown', (e) => {
    if (S.isOpen && !panel.contains(e.target) && !bell.contains(e.target) && e.target !== veil) close(false);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.target !== list) return;
    const n = S.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { S.active = (S.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; paintActive(); }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (n) { S.active = e.key === 'Home' ? 0 : n - 1; paintActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.items[S.active]) go(S.items[S.active]);
    }
  });
  narrow.addEventListener?.('change', () => { if (S.isOpen) place(); });
  window.addEventListener('resize', () => { if (S.isOpen) place(); });

  paintBell();
  return {
    /** notificationsChanged。件数を動かし、面が開いていれば一覧を読み直す（続けて来ても 1 回） */
    onEvent(ev) {
      S.unread = ev.unread ?? 0; S.waiting = ev.waiting ?? 0;
      paintBell();
      if (S.isOpen) { clearTimeout(S.timer); S.timer = setTimeout(load, 120); }
    },
    /** つながった・つなぎ直した。件数を取り直す（面が開いていれば一覧も） */
    reconnected() { if (S.isOpen) load(); else loadCounts(); },
    close: () => close(false),
    get isOpen() { return S.isOpen; },
    get state() { return { unread: S.unread, waiting: S.waiting, filter: S.filter, items: S.items }; },
  };
}
