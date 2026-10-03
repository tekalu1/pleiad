// スレッド（W3。docs/design-system.md「スレッドの空間モデル」、ADR 0111）。
// 実体は bot の作業の会話なので、Chats の会話と同じ画面の形にする: 見出し（入口は目次・git・内蔵ブラウザー）・投稿の列・入力欄。
//   根の投稿 → 返信。bot の返事は進捗のチェックリストを同じ投稿の編集で更新（S4 が畳んだターンの投稿）、道具は「道具 n 件」の折りたたみ
//   （Chats と同じ Bundle）、可視化は投稿の中にインライン、ファイルのリンク・HTML・ブラウザーは右パネル（host.filePreview）。
//   作業中は［止める］（channels.stopThread）と、このスレッドで使ったトークン。承認待ちはスレッドの中に承認のカード（Chats と同じ部品。どちらで押しても同じ resolvePermission）。
// 板の並べ方・滑らせ方は deck.mjs（流れとの 2 枚）。この部品は #chThread の中身だけを持つ。
// 部品の口（web/channels/index.mjs）: openThread(channelId, threadId)・show(view)・hide()・onEvent(ev)・contextForPanel(anchor)。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { savedEvent } from '../saved-text.mjs';
import { renderPost, fillPost, authorInfo } from './post.mjs';
import { withReaction } from './reactions.mjs';
import { createChComposer } from './ch-composer.mjs';
import { openEmojiPicker } from '../emoji-picker.mjs';
import { createDeck } from './deck.mjs';
import { createThreadHead } from './thread-head.mjs';
import { createThreadToc } from './thread-toc.mjs';
import { createToolSource, turnWindows, callsInWindow, signatureOf, toolNodes } from './thread-tools.mjs';

const PAGE = 50;
const NEAR_BOTTOM = 80;
const LIVE = new Set(['working', 'waiting']);

/** スレッドの題: 根の投稿の最初の行（先頭の @ の呼びかけは外す） */
export function titleOf(root) {
  const line = String(root?.text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const plain = line.replace(/\s+/g, ' ').trim();
  const stripped = plain.replace(/^(?:@\S+\s*)+/, '').trim();
  return (stripped || plain).slice(0, 120);
}

/** トークンの数。1.2k */
export function tokensText(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  const k = v / 1000;
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toString()}k`;
}

const stopIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2.5 }));
  return svg;
};

export function createThread(host) {
  const body = document.getElementById('channelsBody');
  const view = document.getElementById('channelsView');
  const feedRoot = document.getElementById('chFeed');
  const top = view?.querySelector(':scope > .top') ?? feedRoot?.querySelector(':scope > .top');
  if (!body || !view || !feedRoot || !top) return {};

  const S = {
    channelId: null, threadId: null, channel: null, posts: [], index: new Map(), thread: null, bots: new Map(),
    nextBefore: null, ready: false, seq: 0, queue: [], loadingOlder: false,
  };
  const drafts = new Map();     // threadId -> 書きかけの返信（ほかのスレッドへ移っても残す）
  const toolCache = new Map();  // postId -> { sig, wrap, bundles }（道具の行。同じなら作り直さず、開いた状態を保つ）
  const cards = new Map();      // 承認の id -> .mw
  let windows = new Map();
  const tools = createToolSource({ cmd: (command, args) => host.cmd(command, args) });

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'ch-thread');
  root.id = 'chThread';
  root.setAttribute('aria-labelledby', 'chThreadTitle');
  const log = el('div', 'th-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', t('channels:thread.log'));
  log.tabIndex = 0;
  const older = el('div', 'ch-older', t('channels:feed.older'));
  older.hidden = true;
  const rootSlot = el('div', 'th-root');
  const rdiv = el('div', 'th-rdiv');
  const replies = el('div', 'th-replies');
  const perms = el('div', 'th-perms bg-thread');   // 承認のカード（Chats の .mw.card をそのまま入れる。--gut は CSS で投稿の本文の位置に合わせる）
  log.append(older, rootSlot, rdiv, replies, perms);
  const jump = el('button', 'ch-jump th-jump', t('channels:feed.newer'));
  jump.type = 'button';
  jump.hidden = true;
  const band = el('div', 'th-band');
  band.hidden = true;
  band.setAttribute('role', 'status');
  const composer = createChComposer({
    id: 'chThreadComposer',
    candidates: () => candidates(),
    suggest: () => suggestion(),
    backendLabel: (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id,
    onSend: (text) => send(text),
  });
  const toc = createThreadToc({ host, posts: () => S.posts, ctx: () => ctx, go: (p) => goTo(p) });
  const head = createThreadHead({ host, onClose: () => close(), onBack: () => close(), onToc: (b) => toc.toggle(b) });
  root.append(head.el, log, jump, band, composer.el);
  const deck = createDeck({ view, body, feed: feedRoot, thread: root, top });

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  const toBottom = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; markRead(); };

  // 既読: スレッドを見ていて末尾にいる間は、返信までチャンネルの既読を進める（流れの既読は流れの投稿だけを見るので、スレッドの返信が未読のまま残らないように）
  let readTimer = null, readSent = 0;
  const watching = () => document.body.classList.contains('channels') && deck.state !== 'feed' && document.visibilityState !== 'hidden';
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const last = S.posts.at(-1);
      if (!S.threadId || !S.ready || !last || !watching() || !nearBottom() || last.at <= readSent) return;
      readSent = last.at;
      host.invoke('channels.markRead', { channelId: S.channelId, at: last.at }).catch(() => { readSent = 0; });
    }, 300);
  }
  document.addEventListener('visibilitychange', () => { if (watching()) markRead(); });

  // ---------------------------------------------------------------- 発言者・bot
  const ctx = {
    host,
    get bots() { return S.bots; },
    summaryOf: () => null,
    threadOf: () => null,
    sessionTitle: (id) => host.state?.sessions?.find((s) => s.id === id)?.title ?? null,
    actions: {
      react: (p, emoji, on, had) => react(p, emoji, on, had),
      quick: (p, emoji) => react(p, emoji, true, false),
      openThread: () => composer.focus(),   // スレッドの中の「返信」は入力欄へ
      menu: (p, x, y, anchor) => openMenu(p, x, y, anchor),
    },
  };

  async function loadBots() {
    try {
      const got = await host.invoke('bots.list');
      S.bots = new Map((got?.bots ?? []).map((b) => [b.id, b]));
    } catch { /* 定義が引けなくても投稿は出る */ }
  }
  const youInitial = () => [...t('channels:feed.you')][0] ?? '?';
  const memberBots = () => (S.channel?.members ?? []).map((id) => S.bots.get(id)).filter(Boolean);
  /** いま作業中（作業中・あなた待ち）の bot。ターンの投稿の状態から引く（同じ bot は 1 つ） */
  const liveBots = () => {
    const ids = [];
    for (const p of S.posts) if (p.turn?.botId && LIVE.has(p.state) && !p.deletedAt && !ids.includes(p.turn.botId)) ids.push(p.turn.botId);
    return ids.map((id) => S.bots.get(id) ?? { id, name: t('channels:feed.unknownBot'), icon: '🤖' });
  };
  function candidates() {
    const live = new Set(liveBots().map((b) => b.id));
    return [
      ...memberBots().map((b) => ({ id: b.id, name: b.name, icon: b.icon || '🤖', backend: b.backend ?? null,
        // i18n-dynamic: channels:feed.botState.
        hint: live.has(b.id) ? t(`channels:feed.botState.${S.posts.findLast((p) => p.turn?.botId === b.id && LIVE.has(p.state))?.state ?? 'working'}`) : '' })),
      { id: 'you', name: t('channels:feed.you'), icon: youInitial(), you: true, hint: '' },
    ];
  }
  /** 誰も @ していない文に勧める bot。作業中の bot が 1 体ならその bot に届くので勧めない。それ以外はこのスレッドで最後に返事をした bot */
  function suggestion() {
    if (liveBots().length === 1) return null;
    const last = S.posts.findLast((p) => p.author?.kind === 'bot' && S.bots.has(p.author.botId));
    return (last && S.bots.get(last.author.botId)) || memberBots()[0] || null;
  }
  function paintPlaceholder() {
    const live = liveBots();
    composer.setPlaceholder(live.length === 1 ? t('channels:thread.composer.working', { name: live[0].name }) : t('channels:thread.composer.placeholder'));
  }

  /** そのスレッドの bot の会話（右パネルの作業場所の基準・git・ブラウザー）。最後に動いた bot の会話 */
  function activeSession() {
    const turn = S.posts.findLast((p) => p.turn?.sessionId && !p.deletedAt);
    if (turn) return turn.turn.sessionId;
    return Object.values(S.thread?.sessions ?? {}).at(-1) ?? null;
  }
  const sessionIds = () => new Set([...Object.values(S.thread?.sessions ?? {}), ...S.posts.map((p) => p.turn?.sessionId).filter(Boolean)]);

  // ---------------------------------------------------------------- 見出し・帯
  function paintHead() {
    head.setTitle({ channel: S.channel?.name ?? '', title: titleOf(S.posts[0]) });
    head.setSession(activeSession());
  }

  let bandSig = '', stopBusy = false;
  function paintBand() {
    const th = S.thread;
    const total = (th?.tokens?.input ?? 0) + (th?.tokens?.output ?? 0);
    const live = liveBots();
    const working = th?.state === 'working' || th?.state === 'waiting' || live.length > 0;
    const waiting = !working ? false : (th?.state === 'waiting' || S.posts.some((p) => p.turn && p.state === 'waiting' && !p.deletedAt)) && !S.posts.some((p) => p.turn && p.state === 'working' && !p.deletedAt);
    const stopped = !working && Boolean(th?.stopped);
    const calls = Math.max(0, (th?.calls ?? 0) - 1);
    const sig = JSON.stringify([working, waiting, stopped, total, calls, live.map((b) => b.id), th?.tokens, stopBusy]);
    if (sig === bandSig) return;
    bandSig = sig;
    if (!total && !working && !stopped) { band.hidden = true; band.replaceChildren(); return; }
    band.hidden = false;
    band.classList.toggle('quiet', !working && !stopped);
    const text = el('span', 'th-band-text');
    const pieces = [];
    if (working) {
      const who = live.map((b) => `${b.icon || '🤖'} ${b.name}`).join(' ⇄ ');
      const span = el('span', 'th-band-live');
      if (waiting) span.append(el('span', 'th-band-mark', '◆'));
      else span.append(runMark(t('channels:feed.state.working')));
      const name = who || t('channels:thread.band.someone');
      span.append(el('span', 'th-band-who', waiting ? t('channels:thread.band.waiting', { who: name }) : t('channels:thread.band.working', { who: name })));
      pieces.push(span);
      if (calls >= 1 && live.length > 1) pieces.push(el('span', null, t('channels:thread.band.calls', { count: calls })));
    } else if (stopped) pieces.push(el('span', null, t('channels:thread.band.stopped')));
    if (total) {
      // 「このスレッドで 1.2k トークン」。狭い幅は数字だけ（前後の語は CSS で見えなくするだけで、読み上げには残る）
      const num = tokensText(total);
      const full = t('channels:thread.band.tokens', { tokens: num });
      const at = full.indexOf(num);
      const tok = el('span', 'th-band-tokens');
      if (at < 0) tok.textContent = full;
      else tok.append(el('span', 'th-tok-aux', full.slice(0, at)), el('span', 'th-tok-num', num), el('span', 'th-tok-aux', full.slice(at + num.length)));
      tok.title = t('channels:thread.band.tokensTitle', { input: th.tokens.input ?? 0, output: th.tokens.output ?? 0, cached: th.tokens.cached ?? 0 });
      pieces.push(tok);
    }
    pieces.forEach((p, i) => { if (i) text.append(el('span', 'th-band-dot', '·')); text.append(p); });
    band.replaceChildren(text);
    if (working) {
      const stop = el('button', 'btn btn-quiet th-stop');
      stop.type = 'button';
      stop.disabled = stopBusy;
      stop.append(stopIcon(), stopBusy ? t('channels:thread.stopping') : t('channels:thread.stop'));
      stop.onclick = () => stopThread();
      band.append(stop);
    }
  }
  async function stopThread() {
    if (stopBusy || !S.threadId) return;
    stopBusy = true;
    paintBand();
    try {
      await host.invoke('channels.stopThread', { channelId: S.channelId, threadId: S.threadId });
    } catch (err) {
      composer.say(t('channels:thread.stopFailed', { error: err?.message ?? String(err) }));
    } finally {
      stopBusy = false;
      paintBand();
    }
  }

  // ---------------------------------------------------------------- 投稿 1 件
  const sysNode = (p) => {
    const n = el('div', 'th-sys');
    n.dataset.postId = p.id;
    n.append(el('span', 'th-sys-mark', '–'), el('span', null, p.text ?? ''));
    return n;
  };

  /** ターンの投稿の道具の行。会話の履歴から（まだ読んでいなければ無し） */
  function toolSlot(p) {
    const w = windows.get(p.id);
    const messages = w ? tools.messagesOf(w.sessionId) : null;
    if (!messages) return toolCache.get(p.id)?.wrap ?? null;
    const calls = callsInWindow(messages, w);
    if (!calls.length) return null;
    const running = p.state === 'working';   // 承認待ちの呼び出しは走っていない（弧を出さない）
    const sig = `${signatureOf(calls)}${running ? '+' : ''}`;
    let c = toolCache.get(p.id);
    if (!c || c.sig !== sig) {
      const built = toolNodes(calls, { running });
      const wrap = c?.wrap ?? el('div', 'th-tools');
      // 開いていた行・まとまりは、作り直しても同じ範囲を開けておく
      built.bundles.forEach((b, i) => { const old = c?.bundles[i]; if (old) b.restoreView(old.viewState()); });
      wrap.replaceChildren(...built.nodes);
      c = { sig, wrap, bundles: built.bundles };
      toolCache.set(p.id, c);
    }
    return c.wrap;
  }

  /** fillPost の後に足すもの: 道具の行・進捗のチェックリスト・提示（可視化はインライン）。会話そのものを開く入口は投稿の ⋯（openMenu） */
  function decorate(node, p) {
    const main = node.querySelector(':scope > .post-main');
    if (!main || p.deletedAt) return;
    const bodyEl = main.querySelector('.post-body');
    if (p.turn?.sessionId) {
      const slot = toolSlot(p);
      if (slot) main.querySelector('.post-head')?.after(slot);
    }
    if (p.presents?.length) {
      const box = el('div', 'post-presents');
      for (const ev of p.presents) {
        try { box.append(host.renderPresent(savedEvent(ev))); } catch { /* 描けない提示は飛ばす */ }
      }
      if (box.childElementCount) bodyEl.after(box);
    }
  }

  const postEls = new Map();
  function nodeFor(p) {
    if (p.author?.kind === 'system') return sysNode(p);
    const node = renderPost(p, ctx);
    decorate(node, p);
    return node;
  }
  function repaint(id) {
    const p = S.index.get(id);
    const old = postEls.get(id);
    if (!p || !old) return;
    if (p.author?.kind === 'system') { const n = sysNode(p); old.replaceWith(n); postEls.set(id, n); return; }
    fillPost(old, p, ctx);
    decorate(old, p);
  }
  const repaintTurns = (sessionId) => { for (const p of S.posts) if (p.turn && (!sessionId || p.turn.sessionId === sessionId)) repaint(p.id); };

  function paintRdiv() {
    const n = Math.max(0, S.posts.length - 1);
    rdiv.textContent = n ? t('channels:thread.replies', { count: n }) : t('channels:thread.noReplies');
  }

  function paintAll() {
    postEls.clear();
    const [first, ...rest] = S.posts;
    const rootNode = first ? nodeFor(first) : null;
    if (first) postEls.set(first.id, rootNode);
    rootSlot.replaceChildren(...(rootNode ? [rootNode] : []));
    replies.replaceChildren(...rest.map((p) => { const n = nodeFor(p); postEls.set(p.id, n); return n; }));
    older.hidden = !S.nextBefore;
    paintRdiv();
  }

  function addPost(p) {
    S.posts.push(p);
    S.index.set(p.id, p);
    const node = nodeFor(p);
    node.classList?.add('enter');
    postEls.set(p.id, node);
    replies.append(node);
    paintRdiv();
  }

  // ---------------------------------------------------------------- 読み込み
  function reset() {
    Object.assign(S, { channel: null, posts: [], index: new Map(), thread: null, nextBefore: null, ready: false, queue: [], loadingOlder: false });
    postEls.clear(); toolCache.clear(); cards.clear(); tools.forget();
    perms.replaceChildren();
    rootSlot.replaceChildren(); replies.replaceChildren(); rdiv.textContent = '';
    bandSig = ''; band.hidden = true; band.replaceChildren();
    jump.hidden = true;
    readSent = 0;
  }

  async function load() {
    const seq = ++S.seq;
    const { channelId, threadId } = S;
    S.ready = false;
    S.queue = [];
    rootSlot.replaceChildren(el('p', 'ch-loading', t('channels:thread.loading')));
    try {
      const [page, channel] = await Promise.all([
        host.invoke('channels.read', { channelId, threadId, limit: PAGE }),
        host.invoke('channels.get', { channelId }).catch(() => null),
        loadBots(),
      ]);
      if (seq !== S.seq) return;
      S.channel = channel;
      S.posts = page.posts ?? [];
      S.index = new Map(S.posts.map((p) => [p.id, p]));
      S.thread = (page.threads ?? []).find((th) => th.threadId === threadId) ?? null;
      S.nextBefore = page.nextBefore ?? null;
      S.ready = true;
      windows = turnWindows(S.posts);
      paintHead();
      paintAll();
      paintBand();
      paintPlaceholder();
      for (const ev of S.queue.splice(0)) events[ev.type]?.(ev);
      paintPendingPerms();
      toBottom();
      for (const sid of new Set([...windows.values()].map((w) => w.sessionId))) tools.refresh(sid, { force: true });
      composer.setDisabled(Boolean(S.channel?.archivedAt), t('channels:feed.archived'));
      composer.refresh();
      markSelected();
      if (seq === S.seq) composer.focus();
    } catch (err) {
      if (seq !== S.seq) return;
      const box = el('div', 'ch-failed');
      const retry = el('button', 'btn', t('channels:feed.retry'));
      retry.type = 'button';
      retry.onclick = () => load();
      box.append(el('p', null, t('channels:thread.loadFailed', { error: err?.message ?? String(err) })), retry);
      rootSlot.replaceChildren(box);
    }
  }

  async function loadOlder() {
    if (S.loadingOlder || !S.nextBefore || !S.ready) return;
    S.loadingOlder = true;
    const seq = S.seq;
    try {
      const page = await host.invoke('channels.read', { channelId: S.channelId, threadId: S.threadId, before: S.nextBefore, limit: PAGE });
      if (seq !== S.seq) return;
      const olderPosts = (page.posts ?? []).filter((p) => !S.index.has(p.id));
      const before = log.scrollHeight - log.scrollTop;
      S.posts = [S.posts[0], ...olderPosts, ...S.posts.slice(1)];
      for (const p of olderPosts) S.index.set(p.id, p);
      S.nextBefore = page.nextBefore ?? null;
      windows = turnWindows(S.posts);
      paintAll();
      log.scrollTop = log.scrollHeight - before;
    } catch { /* 次のスクロールで取り直す */ } finally { S.loadingOlder = false; }
  }

  // ---------------------------------------------------------------- 操作
  async function send(text) {
    const made = await host.invoke('channels.post', { channelId: S.channelId, threadId: S.threadId, text });
    if (made?.id && !S.index.has(made.id) && made.threadId === S.threadId) { addPost(made); afterPosts(); }
    toBottom();
  }

  async function react(p, emoji, on, had) {
    if (on && had) return;
    const prev = p.reactions;
    p.reactions = withReaction(prev, emoji, on);
    repaint(p.id);
    try {
      const got = await host.invoke('channels.react', { channelId: S.channelId, postId: p.id, emoji, on });
      if (got?.reactions) { p.reactions = got.reactions; repaint(p.id); }
    } catch (err) {
      p.reactions = prev;
      repaint(p.id);
      composer.say(t('channels:feed.reactFailed', { error: err?.message ?? String(err) }));
    }
  }

  function openMenu(p, x, y, anchor) {
    const items = [
      { label: t('channels:feed.react'), onClick: () => {
        const at = postEls.get(p.id)?.querySelector('.post-tool.add') ?? anchor;
        openEmojiPicker({ anchor: at, title: t('channels:feed.reactPicker'), onPick: (emoji) => react(p, emoji, true, (p.reactions?.[emoji] ?? []).some((a) => a.kind === 'human')) });
      } },
      { sep: true },
      { label: t('channels:feed.copyText'), onClick: () => { navigator.clipboard?.writeText(p.text ?? '').catch(() => {}); } },
    ];
    if (p.turn?.sessionId) items.splice(1, 0, { label: t('channels:feed.openSession'), onClick: () => host.openSession(p.turn.sessionId) });
    host.showMenu(x, y, items, authorInfo(p.author, ctx).name);
  }
  log.addEventListener('contextmenu', (e) => {
    const node = e.target.closest?.('.post');
    if (!node || e.target.closest('a, button, .present')) return;
    if (String(window.getSelection?.() ?? '').trim()) return;
    const p = S.index.get(node.dataset.postId);
    if (!p || p.deletedAt) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    openMenu(p, e.clientX || r.left + 8, e.clientY || r.bottom, node);
  });
  jump.onclick = () => toBottom();
  log.addEventListener('scroll', () => {
    if (nearBottom()) { jump.hidden = true; markRead(); }
    if (log.scrollTop < 120) loadOlder();
  });

  /** 目次から: 投稿へ送って、一瞬だけ強調する */
  function goTo(p) {
    const node = postEls.get(p.id);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1400);
  }

  // ---------------------------------------------------------------- 承認のカード
  function showCard(ev) {
    if (!ev?.id || cards.has(ev.id) || !sessionIds().has(ev.sessionId)) return;
    if (perms.querySelector(`[data-key="perm:${CSS.escape(ev.id)}"]`)) return;
    const stick = nearBottom();
    const m = host.permissionCard(ev, perms);
    const wrap = m?.closest?.('.mw') ?? perms.querySelector(`[data-key="perm:${CSS.escape(ev.id)}"]`);
    if (!wrap) return;
    cards.set(ev.id, wrap);
    if (stick) toBottom(); else jump.hidden = false;
  }
  function paintPendingPerms() {
    for (const ev of host.state?.pendingPerms?.values?.() ?? []) showCard(ev);
  }
  /** 別の画面（Chats・スマホ）で答えた承認のカードは外す。答え終えたカード（done）は履歴として残す */
  function settleCards() {
    const pending = host.state?.pendingPerms;
    if (!pending) return;
    for (const [id, wrap] of cards) {
      if (pending.has(id) || wrap.classList.contains('done') || wrap.querySelector('.card.done')) continue;
      wrap.remove();
      cards.delete(id);
    }
  }

  // ---------------------------------------------------------------- 出来事
  /** 投稿が増えた・変わった後に揃えるもの */
  function afterPosts() {
    windows = turnWindows(S.posts);
    paintBand();
    paintPlaceholder();
    composer.refresh();
    toc.refresh();
    head.setSession(activeSession());
  }

  function onReply(op, p) {
    const stick = nearBottom();
    if (op === 'add') {
      if (S.index.has(p.id)) { Object.assign(S.index.get(p.id), p); repaint(p.id); } else addPost(p);
    } else {
      const cur = S.index.get(p.id);
      if (!cur) return;
      const was = cur.state;
      Object.assign(cur, p, op === 'delete' ? { deletedAt: p.deletedAt ?? Date.now() } : {});
      repaint(p.id);
      if (p.turn?.sessionId && was !== p.state && !LIVE.has(p.state)) tools.refresh(p.turn.sessionId, { force: true });
    }
    afterPosts();
    // 走っている間の道具の行は、投稿の更新（1 秒に 1 回まで）に合わせて取り直す（間隔は thread-tools の REFRESH_MS）
    if (p.turn?.sessionId && (LIVE.has(p.state) || op === 'add')) tools.refresh(p.turn.sessionId, { force: op === 'add' });
    if (stick || p.author?.kind === 'human') toBottom(); else jump.hidden = false;
  }

  function onRoot(op, p) {
    const cur = S.index.get(p.id);
    if (!cur) return;
    Object.assign(cur, p, op === 'delete' ? { deletedAt: p.deletedAt ?? Date.now() } : {});
    repaint(p.id);
    paintHead();
    toc.refresh();
  }

  tools.onLoaded((sessionId) => {
    if (!S.ready) return;
    const stick = nearBottom();
    repaintTurns(sessionId);
    if (stick) toBottom();
  });

  const events = {
    channelPost(ev) {
      if (ev.channelId !== S.channelId || !S.threadId) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = ev.post;
      if (!p) return;
      if (p.threadId === S.threadId) onReply(ev.op, p);
      else if (!p.threadId && p.id === S.threadId) onRoot(ev.op, p);
    },
    channelReaction(ev) {
      if (ev.channelId !== S.channelId || !S.threadId) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = S.index.get(ev.postId);
      if (p) { p.reactions = ev.reactions ?? {}; repaint(p.id); }
    },
    channelThread(ev) {
      if (ev.channelId !== S.channelId || ev.threadId !== S.threadId || !ev.thread) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const idle = S.thread?.state !== 'idle' && ev.thread.state === 'idle';
      S.thread = ev.thread;
      paintBand();
      paintPlaceholder();
      paintPendingPerms();
      if (idle) head.setSession(activeSession(), { force: true });   // ターンが終わったら git の変更の有無を取り直す
    },
    channelsChanged(ev) {
      if (!S.channelId) return;
      if (ev.removed === S.channelId) { close(); return; }
      if (ev.channel?.id === S.channelId) { S.channel = ev.channel; paintHead(); composer.setDisabled(Boolean(ev.channel.archivedAt), t('channels:feed.archived')); }
    },
    botsChanged(ev) {
      if (ev.removed) S.bots.delete(ev.removed);
      if (ev.bot) S.bots.set(ev.bot.id, ev.bot);
      if (!S.threadId || !S.ready) return;
      for (const id of postEls.keys()) repaint(id);
      bandSig = '';
      paintBand();
      paintPlaceholder();
      composer.refresh();
    },
    permission(ev) {
      if (S.ready && S.threadId) showCard(ev);
    },
    running() {
      // client.mjs が承認の残りを数え直した後に、答え済みのカードを外す
      if (S.threadId) setTimeout(settleCards, 0);
    },
  };

  // ---------------------------------------------------------------- 開く・閉じる
  /** 流れの側で選んでいるスレッドの根の投稿に印（左の線と背景）を付ける。流れが描き直されても付け直す */
  function markSelected() {
    for (const n of feedRoot.querySelectorAll('.post[data-open]')) delete n.dataset.open;
    if (S.threadId) { const n = feedRoot.querySelector(`.post[data-post-id="${CSS.escape(S.threadId)}"]`); if (n) n.dataset.open = ''; }
  }
  const feedLog = feedRoot.querySelector('.ch-log');
  if (feedLog) new MutationObserver(() => { if (S.threadId) markSelected(); }).observe(feedLog, { childList: true });

  function saveDraft() {
    if (S.threadId) drafts.set(S.threadId, composer.input.value ?? '');
  }

  function open(channelId, threadId) {
    if (!channelId || !threadId) return;
    const same = S.channelId === channelId && S.threadId === threadId;
    saveDraft();
    S.channelId = channelId;
    S.threadId = threadId;
    deck.setThread(true);
    if (same) {
      markSelected();
      composer.focus();
      return;
    }
    S.seq++;
    reset();
    composer.input.value = drafts.get(threadId) ?? '';
    composer.refresh();
    toc.close();
    head.setTitle({ channel: document.getElementById('channelsPageTitle')?.title ?? '', title: '' });
    markSelected();
    load();
  }

  function close() {
    if (!S.threadId) return;
    saveDraft();
    toc.close();
    S.seq++;
    S.threadId = null;
    markSelected();
    deck.setThread(false);
    feedRoot.querySelector('.ch-input')?.focus({ preventScroll: true });
  }

  return {
    openThread: open,
    show(view) {
      if (view?.kind !== 'channel') { if (S.threadId) close(); return; }
      if (S.channelId && view.id !== S.channelId && S.threadId) close();
      S.channelId = view.id;
    },
    hide() { /* スレッドは開いたまま（Chats へ移って戻っても同じ所から） */ },
    onEvent(ev) { events[ev?.type]?.(ev); },
    contextForPanel(anchor) {
      if (!anchor?.closest?.('#chThread')) return null;
      return { sessionId: activeSession(), at: undefined };
    },
    sideTabChanged() {},
    /** テスト・ほかの部品が見る */
    get state() { return { deck: deck.state, threadId: S.threadId, channelId: S.channelId }; },
  };
}
