// 脇の Channels 側（docs/channels.md「画面」、ADR 0094、モック 01）。#channelsSide の 3 つの節を描く:
//   チャンネル … # 名前。未読は太字、あなた宛ては件数の札。＋でその場に名前の欄を出して作る（channels.create）
//   Bots       … アイコン・名前・エージェント・状態（待機 / 作業中の回る弧 / あなた待ち）。押すと DM、＋は bot を作る画面（W4）
//   ルーティン … P2（W5）が中身を入れる。今は節と空の状態だけ
// 見ていない側のタブの札に点（あなたを待っているものは --ink-mark、未読だけなら青）を付ける。Chats 側の数は web/side.mjs の attention()。
// 検索は Chats と同じ欄（#q）で両方を横断する（side.connectChannels。結果の行に「Chats」「#チャンネル」）。
// 読むのは channels.list・bots.list・channels.search、更新は出来事 channelsChanged・channelPost・channelRead・channelThread・botsChanged。
// 開く入口は document の channels:show（{ kind: 'channel', id, threadId? } / { kind: 'bot', id }。web/channels/index.mjs）。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { sideChannels, botState, tabDots, channelNameRows, postRows, showDetail, selectedRow } from './side-model.mjs';

const ICONS = {
  hash: 'M10 4 8 20M16 4l-2 16M4.5 9h15M4 15h15',
  bot: 'M6.5 8h11a3.5 3.5 0 0 1 3.5 3.5v4a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 15.5v-4A3.5 3.5 0 0 1 6.5 8zM12 8V4.5M9.5 13v1M14.5 13v1',
  clock: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
  plus: 'M12 5v14M5 12h14',
};
const RELOAD_WAIT_MS = 150;     // 出来事が続けて来たら 1 回にまとめて読み直す（作業中の投稿は 1 秒に 1 回届く）

const icon = (d) => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d }));
  return svg;
};
const message = (e) => String(e?.message ?? e ?? '');

/**
 * @param {object} host  web/channels/index.mjs の host
 * @param {() => { tab: string, setDot(name: string, kind: string|null): void }} getTabs  脇のタブ（部品を並べた後に作られるので関数で受ける）
 */
export function createSidebar(host, getTabs) {
  const panel = document.getElementById('channelsSide');
  if (!panel) return {};
  const side = host.side;
  const S = {
    channels: [],            // channels.list（unread・mentions 付き）
    bots: [],                // bots.list
    loaded: false,           // 一度でも読めた
    stale: true,             // 読み直しが要る（接続の前に読もうとして失敗した・出来事が来た）
    view: null,              // メインに出している面（show の view）。脇の選ばれた行
    creating: false,         // チャンネルの名前の欄を出している
    createError: '',
    focusKey: null,          // キーボードで指している行（描き直しても指し続ける）
  };
  const secs = Object.fromEntries(['channels', 'bots', 'routines'].map((k) => [k, panel.querySelector(`.cs-sec[data-sec="${k}"]`)]));
  const rowsOf = {};

  // ---------------------------------------------------------------- 節の見出し（Chats の状態の見出しと同じ形）
  function head(key, iconPath, label, add) {
    const sec = secs[key];
    if (!sec) return;
    sec.querySelector(':scope > h2')?.remove();
    const h = el('div', 'grp-head cs-head');
    const ic = el('span', 'grp-icon cs-icon');
    ic.append(icon(iconPath));
    const name = el('h2', 'grp-name cs-name', label);
    h.append(ic, name);
    if (add) {
      const b = el('button', 'btn btn-icon grp-add cs-add');
      b.type = 'button';
      b.title = add.label;
      b.setAttribute('aria-label', add.label);
      b.append(icon(ICONS.plus));
      b.addEventListener('click', (e) => { e.stopPropagation(); add.onClick(); });
      h.append(b);
    }
    sec.prepend(h);
    const rows = sec.querySelector('.cs-rows') ?? sec.appendChild(el('div', 'cs-rows'));
    rows.classList.add('rows');
    rowsOf[key] = rows;
  }
  head('channels', ICONS.hash, t('channels:side.sections.channels'), { label: t('channels:side.newChannel'), onClick: () => startCreate() });
  head('bots', ICONS.bot, t('channels:side.sections.bots'), { label: t('channels:side.newBot'), onClick: () => navigate({ kind: 'bot', id: 'new' }) });
  head('routines', ICONS.clock, t('channels:side.sections.routines'), null);   // ＋は W5（P2）がルーティンの編集と一緒に足す

  // 検索欄は両方を探す
  const q = document.getElementById('q');
  if (q) { q.placeholder = t('channels:side.searchPlaceholder'); q.setAttribute('aria-label', t('channels:side.searchPlaceholder')); }

  const navigate = (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail }));

  // ---------------------------------------------------------------- 読み込み
  let reloadTimer = 0, loading = null;
  function reloadSoon() {
    S.stale = true;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, RELOAD_WAIT_MS);
  }
  async function load() {
    clearTimeout(reloadTimer);
    if (loading) { S.stale = true; return loading; }
    S.stale = false;
    loading = (async () => {
      try {
        const [c, b] = await Promise.all([host.invoke('channels.list', {}), host.invoke('bots.list', {})]);
        S.channels = c?.channels ?? [];
        S.bots = b?.bots ?? [];
        S.loaded = true;
        side?.setDirectory?.({ channels: S.channels, bots: S.bots });
        paint();
      } catch {
        // まだつながっていない・切れている。次の出来事（つながると一覧の出来事が届く）で読み直す
        S.stale = true;
        if (!S.loaded) paint();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // ---------------------------------------------------------------- 描画
  const live = () => ({ sessions: host.state?.sessions ?? [], runningIds: host.state?.runningIds ?? new Set(), waitingIds: host.state?.waitingIds ?? new Set() });
  const sel = () => selectedRow(S.view, S.bots);
  const isSel = (kind, id) => { const s = sel(); return s?.kind === kind && s.id === id; };

  function paint() {
    const hadFocus = panel.contains(document.activeElement) && document.activeElement?.classList.contains('cs-row');
    paintChannels();
    paintBots();
    paintRoutines();
    roving(hadFocus);
    paintDots();
  }

  function rowBase(kind, id, label) {
    const r = el('div', 'row one cs-row');
    r.dataset.kind = kind;
    r.dataset.id = id;
    r.setAttribute('role', 'button');
    r.tabIndex = -1;
    if (isSel(kind, id)) { r.classList.add('sel'); r.setAttribute('aria-current', 'page'); }
    r.setAttribute('aria-label', label);
    return r;
  }

  function paintChannels() {
    const box = rowsOf.channels;
    if (!box) return;
    const nodes = [];
    if (S.creating) nodes.push(createField());
    for (const c of sideChannels(S.channels)) {
      const unread = (c.unread ?? 0) > 0, mentions = c.mentions ?? 0;
      const spoken = [`#${c.name}`, unread ? t('channels:side.unread') : '', mentions ? t('channels:side.mentions', { count: mentions }) : '',
        c.archivedAt ? t('channels:side.archived') : ''];
      const r = rowBase('channel', c.id, spoken.filter(Boolean).join(', '));
      if (unread) r.classList.add('unread');
      if (c.archivedAt) r.classList.add('quiet');
      const hash = el('span', 'hash', '#');
      hash.setAttribute('aria-hidden', 'true');
      r.append(hash, el('span', 'row-t', c.name));
      if (mentions) {
        const mc = el('span', 'mc', String(mentions));
        mc.title = t('channels:side.mentions', { count: mentions });
        mc.setAttribute('aria-hidden', 'true');
        r.append(mc);
      }
      r.addEventListener('click', () => navigate({ kind: 'channel', id: c.id }));
      nodes.push(r);
    }
    if (!nodes.length) nodes.push(el('div', 'empty cs-empty', S.loaded ? t('channels:side.channelsEmpty') : t('channels:side.loading')));
    box.replaceChildren(...nodes);
  }

  function paintBots() {
    const box = rowsOf.bots;
    if (!box) return;
    const now = live();
    const label = (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id;
    const nodes = S.bots.map((b) => {
      const state = botState(b, now);
      // i18n-dynamic: channels:side.botState.
      const stateText = t(`channels:side.botState.${state}`);
      const r = rowBase('bot', b.id, [b.name, label(b.backend), stateText].join(', '));
      const av = el('span', 'av s', b.icon || '');
      av.setAttribute('aria-hidden', 'true');
      const name = el('span', 'row-t cs-bot-name', b.name);
      r.append(av, name);
      if (b.backend) { const be = backendLogo(b.backend, label(b.backend)); be.setAttribute('aria-hidden', 'true'); r.append(be); }
      r.append(el('span', 'cs-fill'));
      if (state === 'working') { const m = runMark(stateText); m.setAttribute('aria-hidden', 'true'); r.append(m); }
      else r.append(el('span', state === 'waiting' ? 'wait' : 'st-r', stateText));
      // 押すと DM（bot と 1 対 1 のチャンネル）。bot のページは右クリック・DM の見出しから
      r.addEventListener('click', () => navigate(b.dmChannelId ? { kind: 'channel', id: b.dmChannelId } : { kind: 'bot', id: b.id }));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); botMenu(b, e.clientX, e.clientY); });
      r.botMenu = (x, y) => botMenu(b, x, y);
      return r;
    });
    if (!nodes.length) nodes.push(el('div', 'empty cs-empty', S.loaded ? t('channels:side.botsEmpty') : t('channels:side.loading')));
    box.replaceChildren(...nodes);
  }

  function botMenu(b, x, y) {
    host.showMenu?.(x, y, [
      ...(b.dmChannelId ? [{ label: t('channels:side.openDm'), onClick: () => navigate({ kind: 'channel', id: b.dmChannelId }) }] : []),
      { label: t('channels:side.openBot'), onClick: () => navigate({ kind: 'bot', id: b.id }) },
    ], b.name);
  }

  function paintRoutines() {
    const box = rowsOf.routines;
    if (!box) return;
    box.replaceChildren(el('div', 'empty cs-empty', t('channels:side.routinesEmpty')));
  }

  // ---------------------------------------------------------------- チャンネルを作る（＋ → その場の名前の欄）
  function startCreate() {
    S.creating = true;
    S.createError = '';
    paint();
    rowsOf.channels?.querySelector('.cs-new input')?.focus();
  }
  function endCreate() {
    S.creating = false;
    S.createError = '';
    paint();
  }
  function createField() {
    const wrap = el('div', 'cs-new');
    const line = el('label', 'cs-new-line');
    const hash = el('span', 'hash', '#');
    hash.setAttribute('aria-hidden', 'true');
    const input = el('input', 'cs-new-input');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = t('channels:side.newChannelPlaceholder');
    input.setAttribute('aria-label', t('channels:side.newChannel'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    line.append(hash, input);
    wrap.append(line);
    if (S.createError) {
      const err = el('div', 'cs-new-err', S.createError);
      err.id = 'csNewErr';
      err.setAttribute('role', 'alert');
      input.setAttribute('aria-describedby', err.id);
      wrap.append(err);
    }
    let busy = false;
    input.addEventListener('keydown', async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endCreate(); secs.channels?.querySelector('.cs-add')?.focus(); return; }
      if (e.key !== 'Enter' || busy) return;
      e.preventDefault();
      const name = input.value.trim().replace(/^#+/, '').trim();
      if (!name) { endCreate(); return; }
      busy = true;
      try {
        const channel = await host.invoke('channels.create', { name });
        S.creating = false;
        S.createError = '';
        S.channels = [...S.channels.filter((c) => c.id !== channel.id), { ...channel, unread: 0, mentions: 0 }];
        navigate({ kind: 'channel', id: channel.id });
        reloadSoon();
      } catch (err) {
        S.createError = message(err);
        paint();
        const again = rowsOf.channels?.querySelector('.cs-new input');
        if (again) { again.value = input.value; again.focus(); }
      } finally {
        busy = false;
      }
    });
    // 空のまま離れたら畳む（打った名前があれば残す）
    input.addEventListener('blur', () => { setTimeout(() => { if (S.creating && !input.value.trim() && document.activeElement !== input) endCreate(); }, 0); });
    return wrap;
  }

  // ---------------------------------------------------------------- キーボード（一覧は Tab 1 回で入り、↑↓ で行を移る）
  const rowNodes = () => [...panel.querySelectorAll('.cs-row')];
  const keyOf = (n) => `${n.dataset.kind}:${n.dataset.id}`;
  function roving(refocus) {
    const nodes = rowNodes();
    const target = nodes.find((n) => keyOf(n) === S.focusKey) ?? nodes.find((n) => n.classList.contains('sel')) ?? nodes[0];
    for (const n of nodes) n.tabIndex = n === target ? 0 : -1;
    if (refocus && target) target.focus({ preventScroll: true });
  }
  function move(to) {
    const nodes = rowNodes();
    if (!nodes.length) return;
    const node = nodes[Math.max(0, Math.min(nodes.length - 1, to))];
    S.focusKey = keyOf(node);
    for (const n of nodes) n.tabIndex = n === node ? 0 : -1;
    node.focus();
    node.scrollIntoView({ block: 'nearest' });
  }
  panel.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.cs-row');
    if (!row) return;
    const nodes = rowNodes();
    const i = nodes.indexOf(row);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(i + 1); break;
      case 'ArrowUp':
        e.preventDefault();
        if (i === 0 && q) q.focus();   // 先頭から ↑ で検索欄へ戻る（検索欄の ↓ の逆）
        else move(i - 1);
        break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(nodes.length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); row.click(); break;   // click で開く（狭い画面では引き出しも閉じる）
      case 'ContextMenu': case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return;
        if (row.botMenu) { e.preventDefault(); const r = row.getBoundingClientRect(); row.botMenu(r.left + 16, r.bottom); }
        break;
      default:
    }
  });
  panel.addEventListener('focusin', (e) => { const row = e.target.closest?.('.cs-row'); if (row) S.focusKey = keyOf(row); });

  // ---------------------------------------------------------------- タブの点
  function paintDots() {
    const tabs = getTabs?.();
    if (!tabs) return;
    const now = live();
    const dots = tabDots({ tab: tabs.tab, channels: S.channels, botStates: S.bots.map((b) => botState(b, now)), chats: side?.attention?.() ?? {} });
    tabs.setDot('chats', dots.chats);
    tabs.setDot('channels', dots.channels);
  }

  // ---------------------------------------------------------------- 検索の横断（web/side.mjs）
  const whoOf = (author) => {
    if (author?.kind === 'human') return t('sidebar.search.who.user');
    if (author?.kind === 'bot') return S.bots.find((b) => b.id === author.botId)?.name ?? '';
    if (author?.kind === 'agent') return t('sidebar.search.who.assistant');
    return '';
  };
  side?.connectChannels?.({
    matchNames: (terms) => channelNameRows(S.channels, terms),
    searchPosts: async (query) => postRows((await host.invoke('channels.search', { query: query.slice(0, 200) }))?.hits ?? [], whoOf),
    open: (row) => navigate(showDetail(row)),
    active: () => getTabs?.()?.tab === 'channels',
    enterList: () => { const nodes = rowNodes(); if (nodes.length) move(Math.max(0, nodes.findIndex((n) => n.tabIndex === 0))); },
  });
  // Chats の一覧が描き直されたら（走る・待つ・既読が動いた）、bot の状態とタブの点を合わせる
  side?.onRender?.(() => { if (S.stale && !loading) load(); else { paintBots(); roving(false); paintDots(); } });

  // タブは setupChannels が部品を並べた直後に作る。それを待ってから描く
  queueMicrotask(() => { paint(); load(); });

  const RELOAD_ON = new Set(['channelsChanged', 'channelPost', 'channelRead', 'channelThread', 'botsChanged']);
  return {
    onEvent(ev) {
      if (RELOAD_ON.has(ev?.type)) reloadSoon();
      else if (S.stale && !loading) load();
    },
    show(view) { S.view = view ?? null; paint(); },
    hide() { S.view = null; paint(); },
    sideTabChanged() { paintDots(); if (S.stale) load(); },
  };
}
