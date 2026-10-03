// チャンネルの流れ（W2。docs/design-system.md「チャンネルの流れ」、モック 02）。
// #channelsBody の中に section#chFeed.ch-feed を作る: 投稿の列（.ch-log）と入力欄（#chFeedComposer）。見出し（# 名前・目的・メンバー・⋯）は
// メインの頭（#channelsView > .top）に出す。読み書きはすべて channels.* の操作を invoke で呼ぶ（新しい WS コマンドは足さない）。
// 出来事 channelPost・channelReaction・channelThread・channelRead・channelsChanged・botsChanged で、その場で描き直す。
//
// 部品の口（web/channels/index.mjs）: show({ kind: 'channel', id, threadId? })・hide()・onEvent(ev)。
// スレッドを開く空間（W3）はここに無い。要約の行・「スレッドで返信」は host.openThread(channelId, threadId) を呼ぶだけ。
import { el, svgEl } from '../dom.mjs';
import { botIcon } from './bot-icon.mjs';
import { t } from '../i18n.mjs';
import { fillPost, renderPost, dayText, authorInfo, wireAttachmentZoom } from './post.mjs';
import { withReaction } from './reactions.mjs';
import { createChComposer } from './ch-composer.mjs';
import { feedDraftKey } from './ch-attach-model.mjs';
import { openChannelSettings } from './feed-settings.mjs';
import { openEmojiPicker } from '../emoji-picker.mjs';
import { headingButton } from './routine-entry.mjs';

const PAGE = 50;
const NEAR_BOTTOM = 80;
const authorSame = (a, b) => JSON.stringify([a?.kind, a?.botId, a?.sessionId, a?.routineId]) === JSON.stringify([b?.kind, b?.botId, b?.sessionId, b?.routineId]);

export function createFeed(host) {
  const body = document.getElementById('channelsBody');
  const top = document.querySelector('#channelsView > .top');
  const title = document.getElementById('channelsPageTitle');
  if (!body || !top || !title) return {};

  const S = {
    id: null, channel: null, posts: [], index: new Map(), summaries: {}, threads: {}, nextBefore: null,
    bots: new Map(), loadingOlder: false, seq: 0, readSent: 0, ready: false,
    queue: [],   // 読み込んでいる間に届いた出来事。読み終えてから順に当てる（読んだ写しが古くても取りこぼさない）
  };
  const titleI18n = title.getAttribute('data-i18n');

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'ch-feed');
  root.id = 'chFeed';
  root.hidden = true;
  const log = el('div', 'ch-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', t('channels:feed.log'));
  log.tabIndex = 0;
  const jump = el('button', 'ch-jump', t('channels:feed.newer'));
  jump.type = 'button';
  jump.hidden = true;
  const composer = createChComposer({
    id: 'chFeedComposer',
    host,
    bucket: () => S.id,
    candidates: () => candidates(),
    suggest: () => suggestion(),
    backendLabel: (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id,
    onSend: (draft) => post(draft),
  });
  root.append(log, jump, composer.el);
  composer.bindDropZone(root);
  wireAttachmentZoom(log, host);
  body.append(root);
  const emptyNote = body.querySelector(':scope > .ch-empty');

  const postEls = new Map();
  const narrow = () => window.matchMedia?.('(max-width: 700px)').matches;

  // ---------------------------------------------------------------- 発言者・bot
  const ctx = {
    host,
    get bots() { return S.bots; },
    summaryOf: (id) => S.summaries[id],
    threadOf: (id) => S.threads[id],
    sessionTitle: (id) => host.state?.sessions?.find((s) => s.id === id)?.title ?? null,
    actions: {
      react: (p, emoji, on, had) => react(p, emoji, on, had),
      quick: (p, emoji) => react(p, emoji, true, false),
      openThread: (p) => openThread(p),
      menu: (p, x, y, anchor) => openMenu(p, x, y, anchor),
    },
  };

  async function loadBots() {
    try {
      const got = await host.invoke('bots.list');
      S.bots = new Map((got?.bots ?? []).map((b) => [b.id, b]));
    } catch { /* bot の操作がまだ無い・失敗しても投稿は読める。発言者は名前を持たない扱い */ }
  }

  const youInitial = () => [...t('channels:feed.you')][0] ?? '?';
  const memberBots = () => (S.channel?.kind === 'dm' ? [S.bots.get(S.channel.botId)] : (S.channel?.members ?? []).map((id) => S.bots.get(id))).filter(Boolean);

  // i18n-dynamic: channels:feed.botState.
  const stateHint = (bot) => (bot.state === 'working' || bot.state === 'waiting' ? t(`channels:feed.botState.${bot.state}`) : '');
  function candidates() {
    if (!S.channel || S.channel.kind === 'dm') return [];
    return [
      ...memberBots().map((b) => ({ id: b.id, name: b.name, icon: b.icon || '🤖', iconImage: b.iconImage, backend: b.backend ?? null, hint: stateHint(b) })),
      { id: 'you', name: t('channels:feed.you'), icon: youInitial(), you: true, hint: '' },
    ];
  }
  /** 誰も呼ばれていない文に勧める bot。この流れで最後に返事をした bot、無ければ先頭のメンバー */
  function suggestion() {
    if (!S.channel || S.channel.kind === 'dm') return null;
    const members = memberBots();
    const last = [...S.posts].reverse().find((p) => p.author?.kind === 'bot' && members.some((b) => b.id === p.author.botId));
    return (last && S.bots.get(last.author.botId)) || members[0] || null;
  }

  // ---------------------------------------------------------------- 見出し
  function paintPlaceholder() {
    const ch = S.channel;
    if (!ch) return;
    // 送信の近道は、指で使う画面には出さない（Chats の入力欄の案内と同じ決まり）
    const keys = window.matchMedia?.('(pointer:coarse)').matches ? '' : ` · ${t('channels:feed.composer.sendKeys')}`;
    if (ch.kind === 'dm') composer.setPlaceholder(t('channels:feed.composer.dm', { name: ch.name }) + keys);
    else if (narrow()) composer.setPlaceholder(t('channels:feed.composer.shortPlaceholder', { name: ch.name }));
    else composer.setPlaceholder(t('channels:feed.composer.placeholder', { name: ch.name }) + keys);
  }
  window.matchMedia?.('(max-width: 700px)').addEventListener?.('change', paintPlaceholder);

  function paintHead() {
    const ch = S.channel;
    top.classList.toggle('ch-top', Boolean(ch));
    for (const n of top.querySelectorAll('.ch-head-x')) n.remove();
    if (!ch) return;
    title.removeAttribute('data-i18n');
    const dmBot = ch.kind === 'dm' ? S.bots.get(ch.botId) : null;
    title.replaceChildren(dmBot ? botIcon(dmBot, 'ch-hash') : el('span', 'ch-hash', '#'), document.createTextNode(ch.name));
    title.title = ch.name;
    const x = (node) => { node.classList.add('ch-head-x'); top.append(node); return node; };
    x(el('span', 'ch-purpose', ch.kind === 'dm' ? '' : ch.purpose ?? ''));
    const members = el('span', 'ch-members');
    const who = [t('channels:feed.you'), ...memberBots().map((b) => b.name)];
    members.title = t('channels:feed.members', { names: who.join(t('channels:feed.reactionSep')) });
    members.setAttribute('role', 'img');
    members.setAttribute('aria-label', members.title);
    members.append(el('span', 'ch-av you', youInitial()), ...memberBots().map((b) => botIcon(b, 'ch-av')));
    x(members);
    if (!ch.archivedAt) x(headingButton(host, ch));   // ［ルーティン n］（W5）
    const more = el('button', 'btn btn-icon ch-more');
    more.type = 'button';
    more.title = t('channels:feed.settings.open');
    more.setAttribute('aria-label', t('channels:feed.settings.open'));
    const dots = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const cx of [5, 12, 19]) dots.append(svgEl('circle', { cx, cy: 12, r: 1.4 }));
    more.append(dots);
    more.onclick = () => openChannelSettings({ host, channel: ch, bots: [...S.bots.values()], returnTo: more });
    x(more);
    paintPlaceholder();
    composer.setDisabled(Boolean(ch.archivedAt), t('channels:feed.archived'));
  }

  function clearHead() {
    top.classList.remove('ch-top');
    for (const n of top.querySelectorAll('.ch-head-x')) n.remove();
    if (titleI18n) { title.setAttribute('data-i18n', titleI18n); title.textContent = t(titleI18n); title.removeAttribute('title'); }
  }

  // ---------------------------------------------------------------- 投稿の列
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  const toBottom = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; };

  const dayEl = (at) => {
    const d = el('div', 'ch-day');
    d.append(el('span', null, dayText(at)));
    d.dataset.day = new Date(at).toDateString();
    return d;
  };

  function paintAll() {
    postEls.clear();
    const nodes = [];
    if (S.nextBefore) nodes.push(el('div', 'ch-older', t('channels:feed.older')));
    let day = null;
    for (const p of S.posts) {
      const key = new Date(p.at).toDateString();
      if (key !== day) { nodes.push(dayEl(p.at)); day = key; }
      const node = renderPost(p, ctx);
      postEls.set(p.id, node);
      nodes.push(node);
    }
    if (!S.posts.length) nodes.push(el('p', 'ch-empty-feed', S.channel?.kind === 'dm'
      ? t('channels:feed.emptyDm', { name: S.channel.name }) : t('channels:feed.emptyChannel')));
    log.replaceChildren(...nodes);
  }

  function repaint(id) {
    const p = S.index.get(id);
    const node = postEls.get(id);
    if (p && node) fillPost(node, p, ctx);
  }
  const repaintAll = () => { for (const id of postEls.keys()) repaint(id); };

  function addPost(p) {
    S.posts.push(p);
    S.index.set(p.id, p);
    log.querySelector('.ch-empty-feed')?.remove();
    const lastDay = [...log.querySelectorAll('.ch-day')].at(-1)?.dataset.day;
    if (lastDay !== new Date(p.at).toDateString()) log.append(dayEl(p.at));
    const node = renderPost(p, ctx);
    node.classList.add('enter');
    postEls.set(p.id, node);
    log.append(node);
  }

  // ---------------------------------------------------------------- 読み込み
  async function load(id) {
    const seq = ++S.seq;
    S.ready = false;
    S.queue = [];
    log.replaceChildren(el('p', 'ch-loading', t('channels:feed.loading')));
    try {
      const [channel, page] = await Promise.all([host.invoke('channels.get', { channelId: id }), host.invoke('channels.read', { channelId: id, limit: PAGE }), loadBots()]);
      if (seq !== S.seq) return;
      S.channel = channel;
      S.posts = page.posts ?? [];
      S.index = new Map(S.posts.map((p) => [p.id, p]));
      S.summaries = page.summaries ?? {};
      S.threads = Object.fromEntries((page.threads ?? []).map((th) => [th.threadId, th]));
      S.nextBefore = page.nextBefore ?? null;
      S.ready = true;
      paintHead();
      paintAll();
      for (const ev of S.queue.splice(0)) events[ev.type]?.(ev);
      toBottom();
      markRead();
    } catch (err) {
      if (seq !== S.seq) return;
      const box = el('div', 'ch-failed');
      const retry = el('button', 'btn', t('channels:feed.retry'));
      retry.type = 'button';
      retry.onclick = () => load(id);
      box.append(el('p', null, t('channels:feed.loadFailed', { error: err?.message ?? String(err) })), retry);
      log.replaceChildren(box);
    }
  }

  async function loadOlder() {
    if (S.loadingOlder || !S.nextBefore || !S.ready) return;
    S.loadingOlder = true;
    const seq = S.seq;
    try {
      const page = await host.invoke('channels.read', { channelId: S.id, before: S.nextBefore, limit: PAGE });
      if (seq !== S.seq) return;
      const older = (page.posts ?? []).filter((p) => !S.index.has(p.id));
      const before = log.scrollHeight - log.scrollTop;
      S.posts = [...older, ...S.posts];
      for (const p of older) S.index.set(p.id, p);
      Object.assign(S.summaries, page.summaries ?? {});
      for (const th of page.threads ?? []) S.threads[th.threadId] = th;
      S.nextBefore = page.nextBefore ?? null;
      paintAll();
      log.scrollTop = log.scrollHeight - before;
    } catch { /* 次のスクロールで取り直す */ } finally { S.loadingOlder = false; }
  }

  // ---------------------------------------------------------------- 既読
  let readTimer = null;
  const active = () => !root.hidden && document.body.classList.contains('channels') && document.visibilityState !== 'hidden';
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const last = S.posts.at(-1);
      if (!S.id || !last || !active() || !nearBottom() || last.at <= S.readSent) return;
      S.readSent = last.at;
      host.invoke('channels.markRead', { channelId: S.id, at: last.at }).catch(() => { S.readSent = 0; });
    }, 300);
  }
  document.addEventListener('visibilitychange', () => { if (active()) markRead(); });

  // ---------------------------------------------------------------- 操作
  async function post({ text, attachments }) {
    const made = await host.invoke('channels.post', { channelId: S.id, text, ...(attachments?.length ? { attachments } : {}) });
    if (made?.id && !S.index.has(made.id) && !made.threadId) addPost(made);
    toBottom();
    // bot を @ で呼んだ投稿は新しいスレッドの根になる。ここで書いた人にその返事が見えるよう、スレッドを開く（DM は流れがスレッドの代わり）
    if (made?.id && S.channel?.kind !== 'dm' && (made.mentions ?? []).some((m) => m !== 'you')) host.openThread?.(S.id, made.id);
  }

  async function react(p, emoji, on, had) {
    if (on && had) return;
    const prev = p.reactions;
    p.reactions = withReaction(prev, emoji, on);
    repaint(p.id);
    try {
      const got = await host.invoke('channels.react', { channelId: S.id, postId: p.id, emoji, on });
      if (got?.reactions) { p.reactions = got.reactions; repaint(p.id); }
    } catch (err) {
      p.reactions = prev;
      repaint(p.id);
      composer.say(t('channels:feed.reactFailed', { error: err?.message ?? String(err) }));
    }
  }

  function openThread(p) { host.openThread?.(S.id, p.threadId ?? p.id); }

  function openMenu(p, x, y, anchor) {
    const items = [
      { label: t('channels:feed.reply'), onClick: () => openThread(p) },
      { label: t('channels:feed.react'), onClick: () => {
        const at = postEls.get(p.id)?.querySelector('.post-tool.add') ?? anchor;
        openEmojiPicker({ anchor: at, title: t('channels:feed.reactPicker'), onPick: (emoji) => react(p, emoji, true, (p.reactions?.[emoji] ?? []).some((a) => a.kind === 'human')) });
      } },
      { sep: true },
      { label: t('channels:feed.copyText'), onClick: () => { navigator.clipboard?.writeText(p.text ?? '').catch(() => {}); } },
    ];
    if (p.turn?.sessionId) items.splice(2, 0, { label: t('channels:feed.openSession'), onClick: () => host.openSession(p.turn.sessionId) });
    host.showMenu(x, y, items, authorInfo(p.author, ctx).name);
  }

  // 右クリック・長押し（web/long-press.mjs が contextmenu を起こす）・Shift+F10 で同じメニュー
  log.addEventListener('contextmenu', (e) => {
    const node = e.target.closest?.('.post');
    if (!node || e.target.closest('a, button')) return;
    if (String(window.getSelection?.() ?? '').trim()) return;   // 文字を選んでいるときはブラウザーの「コピー」に任せる
    const p = S.index.get(node.dataset.postId);
    if (!p || p.deletedAt) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    openMenu(p, e.clientX || r.left + 8, e.clientY || r.bottom, node);
  });
  jump.onclick = () => { toBottom(); markRead(); };
  log.addEventListener('scroll', () => {
    if (nearBottom()) { jump.hidden = true; markRead(); }
    if (log.scrollTop < 120) loadOlder();
  });

  // ---------------------------------------------------------------- 出来事
  function onReply(op, p) {
    const s = (S.summaries[p.threadId] ??= { count: 0, lastAt: 0, authors: [] });
    if (op === 'add') {
      if (s.count > 0 && p.at <= s.lastAt) return repaint(p.threadId);   // 読み込んだ写しがもう数えている（読み込み中に届いた分）
      s.count += 1;
      s.lastAt = Math.max(s.lastAt, p.at);
      if (s.authors.length < 5 && !s.authors.some((a) => authorSame(a, p.author))) s.authors.push(p.author);
    } else if (op === 'delete') {
      s.count = Math.max(0, s.count - 1);
    }
    repaint(p.threadId);
  }

  function onPost(ev) {
    const { op, post: p } = ev;
    if (!p) return;
    if (p.threadId) return onReply(op, p);
    if (op === 'add') {
      if (S.index.has(p.id)) { Object.assign(S.index.get(p.id), p); repaint(p.id); return; }
      const stick = nearBottom();
      addPost(p);
      if (stick || p.author?.kind === 'human') toBottom();
      else jump.hidden = false;
      markRead();
      composer.refresh();
      return;
    }
    const cur = S.index.get(p.id);
    if (!cur) return;
    if (op === 'delete') Object.assign(cur, p, { deletedAt: p.deletedAt ?? Date.now() });
    else Object.assign(cur, p);
    repaint(p.id);
  }

  function onChannelsChanged(ev) {
    if (ev.removed === S.id) { S.id = null; S.channel = null; root.hidden = true; composer.setDraftKey(null); clearHead(); if (emptyNote) emptyNote.hidden = false; return; }
    if (ev.channel?.id === S.id) { S.channel = ev.channel; paintHead(); }
  }

  const events = {
    channelPost: (ev) => { if (ev.channelId === S.id) { if (S.ready) onPost(ev); else S.queue.push(ev); } },
    channelReaction: (ev) => {
      if (ev.channelId !== S.id) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = S.index.get(ev.postId);
      if (p) { p.reactions = ev.reactions ?? {}; repaint(p.id); }
    },
    channelThread: (ev) => {
      if (ev.channelId !== S.id || !ev.thread) return;
      if (!S.ready) { S.queue.push(ev); return; }
      S.threads[ev.threadId] = ev.thread;
      repaint(ev.threadId);
    },
    channelRead: () => {},
    channelsChanged: (ev) => onChannelsChanged(ev),
    botsChanged: (ev) => {
      if (ev.removed) S.bots.delete(ev.removed);
      if (ev.bot) S.bots.set(ev.bot.id, ev.bot);
      if (!S.id) return;
      paintHead();
      repaintAll();
      composer.refresh();
    },
  };

  return {
    show(view) {
      if (view?.kind !== 'channel' || !view.id) { this.hide(); return; }
      const same = S.id === view.id && S.ready;
      S.id = view.id;
      composer.setDraftKey(feedDraftKey(view.id));   // 書きかけはチャンネルごと（別のチャンネルへ移っても残り、戻ると出る）
      root.hidden = false;
      if (emptyNote) emptyNote.hidden = true;
      if (!same) { S.channel = null; S.posts = []; S.index = new Map(); S.threads = {}; S.summaries = {}; S.readSent = 0; paintHead(); }
      else paintHead();   // 別の面（bot のページなど）へ移ると hide() が見出しを戻すので、同じチャンネルへ戻ったときも描き直す
      const done = same ? Promise.resolve().then(() => { toBottom(); markRead(); }) : load(view.id);
      done.then(() => {
        if (view.threadId) host.openThread?.(view.id, view.threadId);
        composer.focus();
      });
    },
    hide() {
      root.hidden = true;
      clearHead();
      if (emptyNote) emptyNote.hidden = false;
    },
    onEvent(ev) { events[ev?.type]?.(ev); },
    sideTabChanged(tab) { if (tab === 'channels' && S.ready) markRead(); },
  };
}
