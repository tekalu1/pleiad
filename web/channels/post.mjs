// 投稿 1 件の描画（チャンネルの流れ。docs/design-system.md「チャンネルの流れ」）。
//   .post[data-post-id] > .post-av・.post-main（.post-head・.post-body・.post-state・.reactions・.thread-summary）・.post-tools
// 本文は host.renderAssistantMarkdown（エスケープ済みの HTML。bot の返事と同じ描き方）。@ の呼びかけだけ後から色を付ける。
// 発言者は Author（core/channels/types.mjs）。bot は bots.list の定義（アイコン・名前・バックエンド）から引く。
import { el, svgEl } from '../dom.mjs';
import { fmt, t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { placeAttachments, attachmentHtml } from '../user-message.mjs';
import { renderReactions, addButton } from './reactions.mjs';
import { botIcon } from './bot-icon.mjs';

/** 同じ日か */
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** 投稿の時刻。今日は時分、それ以外は月日と時分 */
export function whenText(at, now = Date.now()) {
  if (sameDay(at, now)) return fmt.time(at);
  return fmt.dateTime(at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 日の区切りの文字。今日・昨日・月日（曜日） */
export function dayText(at, now = Date.now()) {
  if (sameDay(at, now)) return t('channels:feed.day.today');
  if (sameDay(at, now - 86_400_000)) return t('channels:feed.day.yesterday');
  return fmt.dateTime(at, { month: 'long', day: 'numeric', weekday: 'short' });
}

/**
 * 発言者の表示。bot は定義から（消えた bot は名前を持たない）。
 * @param {object} author Author
 * @param {{ bots: Map<string, object>, sessionTitle?: (id: string) => string|null }} ctx
 * @returns {{ kind: string, name: string, avatar: string, backend: string|null, you: boolean }}
 */
export function authorInfo(author, ctx) {
  switch (author?.kind) {
    case 'human': {
      const name = t('channels:feed.you');
      return { kind: 'human', name, avatar: [...name][0] ?? '?', backend: null, you: true };
    }
    case 'bot': {
      const bot = ctx.bots.get(author.botId);
      return { kind: 'bot', name: bot?.name ?? t('channels:feed.unknownBot'), avatar: bot?.icon || '🤖', backend: bot?.backend ?? null, you: false };
    }
    case 'agent':
      return { kind: 'agent', name: ctx.sessionTitle?.(author.sessionId) || t('channels:feed.agent'), avatar: '◇', backend: null, you: false };
    case 'routine':
      return { kind: 'routine', name: t('channels:feed.routine'), avatar: '⏱', backend: null, you: false };
    default:
      return { kind: 'system', name: t('channels:feed.system'), avatar: '·', backend: null, you: false };
  }
}

/** 札・一覧の「誰が」に出す名前 */
export const nameOfAuthor = (author, ctx) => authorInfo(author, ctx).name;

/** bot の名前を、@ の呼びかけとして色付けする。コード（code・pre）と、すでにリンクの中は触らない */
export function highlightMentions(root, names) {
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return;
  const escaped = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${escaped.join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  const texts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) texts.push(child);
      else if (child.nodeType === 1 && !/^(CODE|PRE|A|SCRIPT|STYLE)$/.test(child.tagName)) walk(child);
    }
  };
  walk(root);
  for (const node of texts) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      // メールの形（直前が英数字・_）は呼びかけではない
      const before = m.index > 0 ? text[m.index - 1] : '';
      if (/[A-Za-z0-9_]/.test(before)) continue;
      frag.append(text.slice(last, m.index), el('span', 'mention', m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** 投稿の添付（Post.attachments）を、札・画像の描き方の部品（web/user-message.mjs の attachmentHtml）が読む形にする */
const presentOf = (a) => ({ kind: a.kind === 'image' ? 'image' : 'file', path: a.path, captionParams: { name: a.name }, size: a.size, origin: a.origin });

/**
 * 添付つきの投稿の本文の HTML。本文の `[添付] パス` の行は、その位置で添付（画像は縮小、ほかは札）に置き換わる（Chats の自分の発言と同じ。
 * web/user-message.mjs の placeAttachments）。印の無い添付は本文の後ろに並ぶ。文字の区間は renderMarkdown（bot の返事と同じ描き方）
 * @param {string} text 投稿の本文（原文）
 * @param {object[]} attachments Post.attachments
 * @param {(text: string) => string} renderMarkdown エスケープ済みの HTML を返す
 */
export function attachedBodyHtml(text, attachments, renderMarkdown) {
  let html = '', run = [];
  const flush = () => { if (run.length) html += `<div class="msg-atts">${run.map(attachmentHtml).join('')}</div>`; run = []; };
  for (const seg of placeAttachments(text, attachments.map(presentOf))) {
    if (seg.type === 'attachment') { run.push(seg.present); continue; }
    flush();
    if (seg.text.trim()) html += renderMarkdown(seg.text);
  }
  flush();
  return html;
}

/** 添付の画像を押すと大きく見る（Chats の会話と同じライトボックス。host.openImage）。log は投稿の列 */
export function wireAttachmentZoom(log, host) {
  log.addEventListener('click', (e) => {
    const img = e.target.closest?.('.msg-att-zoom')?.querySelector('img');
    if (img) host.openImage?.(img.src, img.alt, img.dataset.filePath, img);
  });
}

const replyIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z' }));
  return svg;
};
const moreIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const cx of [5.5, 12, 18.5]) svg.append(svgEl('circle', { cx, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }));
  return svg;
};

const iconButton = (cls, label, child) => {
  const b = el('button', `post-tool ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(child);
  return b;
};

const tickMark = () => {
  const svg = svgEl('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M3.5 7.3 6 9.8l4.6-5.3' }));
  return svg;
};
const ringMark = () => {
  const svg = svgEl('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 7, cy: 7, r: 4.2 }));
  return svg;
};
const CHECK = /^\s*\[( |x|X)\]\s?/;

/**
 * 本文の「- [x] …」「- [ ] …」の並びを、進捗のチェックリストにする（済みは✓・いま走っているものは弧・これからは輪）。
 * bot のターンの投稿の本文（bot が同じ投稿の編集で更新する進捗）だけが対象。全部の行が [ ] か [x] で始まる一番外の箇条書きだけで、ほかの箇条書きは触らない
 * @param {HTMLElement} body 本文の要素（renderAssistantMarkdown の HTML が入っている）
 * @param {boolean} working ターンが走っているか（最初の未完了の行に弧を出す）
 */
export function paintChecklist(body, working) {
  for (const ul of body.querySelectorAll('ul')) {
    if (ul.parentElement?.closest('li')) continue;
    const items = [...ul.children].filter((li) => li.tagName === 'LI');
    if (!items.length || !items.every((li) => CHECK.test(li.textContent))) continue;
    ul.classList.add('ck');
    const done = items.map((li) => CHECK.exec(li.textContent)?.[1].toLowerCase() === 'x');
    const current = working ? done.findIndex((d) => !d) : -1;
    items.forEach((li, i) => {
      // 先頭の「[x] 」の印を外す（入れ子の <p> の中にあることもある）
      const first = document.createTreeWalker(li, NodeFilter.SHOW_TEXT).nextNode();
      if (first) first.nodeValue = first.nodeValue.replace(CHECK, '');
      const mark = el('span', 'mk');
      if (done[i]) mark.append(tickMark());
      else if (i === current) mark.append(runMark(t('channels:feed.state.working')));
      else mark.append(ringMark());
      const text = el('span', 'ck-text');
      text.append(...li.childNodes);
      li.append(mark, text);
      li.classList.add(done[i] ? 'done' : i === current ? 'cur' : 'todo');
    });
  }
}

/** 状態の行（bot のターンの投稿・ルーティンの実行の根）。成功を緑の ✓ で見せない（終了は文字だけ） */
function stateLine(post) {
  const state = post.state;
  if (!state) return null;
  if (state === 'done' && !post.routine) return null;
  const softFailure = state === 'failed' && post.turn && post.failedWithBody;
  const row = el('div', `post-state ${softFailure ? 'failed-body' : state}`);
  if (state === 'working') row.append(runMark(t('channels:feed.state.working')));
  else if (state === 'waiting') row.append(el('span', 'post-state-mark', '◆'));
  else if (state === 'failed' && !softFailure) row.append(el('span', 'post-state-mark', '✕'));
  // i18n-dynamic: channels:feed.state.
  const label = t(`channels:feed.state.${softFailure ? 'failedWithBody' : state}`);
  const reason = post.routine?.missed ? t('channels:feed.state.missed') : post.routine?.reason;
  row.append(el('span', 'post-state-text', reason && (state === 'skipped' || post.routine?.missed) ? `${label} · ${reason}` : label));
  return row;
}

/** スレッドの要約の行。「💬 3 件の返信 · 🦉 Owl 作業中」。返信が無ければ null */
/**
 * スレッドで実際に動いている bot。状態（ThreadState.state）はスレッド全体の集計なので、名前は bot ごとの印（ThreadState.live）から選ぶ。
 * あなた待ち（waiting）のときは待っている bot、作業中のときは作業している bot。印が無ければ空（名前を出さない）
 * @returns {string[]} botId の並び（印の並び）
 */
export function liveBotIds(th) {
  const want = th?.state === 'waiting' ? 'waiting' : 'working';
  return Object.entries(th?.live ?? {}).filter(([, state]) => state === want).map(([botId]) => botId);
}

/** 動いている bot の名前の並び: 1 体は名前、2 体は「A・B」、3 体以上は「A ほか n」 */
export function liveNamesText(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return t('channels:feed.liveJoin', { a: names[0], b: names[1] });
  return t('channels:feed.liveMore', { first: names[0], count: names.length - 1 });
}

export function renderSummary(post, ctx) {
  const s = ctx.summaryOf?.(post.id);
  if (!s?.count || post.threadId) return null;
  const th = ctx.threadOf?.(post.id);
  const b = el('button', 'thread-summary');
  b.type = 'button';
  b.setAttribute('aria-label', t('channels:feed.openThread', { count: s.count }));
  b.append(el('span', 'ts-count', `💬 ${t('channels:feed.replies', { count: s.count })}`));
  // 動いている bot は ThreadState.live から選ぶ（返信した最後の bot や最初の会話の bot ではない。いま動いているのは別の bot のことがある）
  const live = liveBotIds(th).map((id) => ctx.bots.get(id)).filter(Boolean);
  const names = liveNamesText(live.map((b) => b.name));
  const status = el('span', 'ts-status');
  if (th?.state === 'working') {
    status.classList.add('working');
    status.append('· ');
    if (live.length) {
      for (const bot of live.slice(0, 2)) status.append(botIcon(bot, 'ts-bot-icon'));
      status.append(` ${names}`);
    } else status.append(t('channels:feed.unknownBot'));
    status.append(` ${t('channels:feed.threadWorking')}`, runMark(t('channels:feed.state.working')));
  } else if (th?.state === 'waiting') {
    status.classList.add('waiting');
    status.append('· ', el('span', 'ts-mark', '◆'), ` ${t('channels:feed.threadWaiting', { name: names || t('channels:feed.unknownBot') })}`);
  } else if (th?.state === 'failed') {
    status.classList.add('failed');
    status.append('· ', el('span', 'ts-mark', '✕'), ` ${t('channels:feed.state.failed')}`);
  } else if (s.lastAt) {
    status.append(`· ${t('channels:feed.lastReply', { when: whenText(s.lastAt) })}`);
  }
  b.append(status);
  b.onclick = () => ctx.actions.openThread(post);
  return b;
}

/**
 * 投稿の中身を（再）描画する。root は renderPost が作った .post
 * @param {HTMLElement} root
 * @param {object} post Post
 * @param {object} ctx { bots, summaryOf, threadOf, sessionTitle, host, actions: { react, openThread, menu, quick } }
 */
export function fillPost(root, post, ctx) {
  const info = authorInfo(post.author, ctx);
  root.className = `post${post.deletedAt ? ' deleted' : ''}${info.you ? ' mine' : ''}`;
  root.dataset.postId = post.id;
  root.dataset.author = info.kind;
  const av = info.kind === 'bot' ? botIcon(ctx.bots.get(post.author.botId), 'post-av') : el('span', `post-av${info.you ? ' you' : ''}`, info.avatar);
  av.setAttribute('aria-hidden', 'true');
  const main = el('div', 'post-main');

  const head = el('div', 'post-head');
  head.append(el('b', 'post-name', info.name));
  if (info.backend) {
    const label = ctx.host.state?.backends?.find((b) => b.id === info.backend)?.label ?? info.backend;
    head.append(backendLogo(info.backend, label));
  }
  if (post.routine) head.append(el('span', 'post-kind', t('channels:feed.routine')));
  const when = el('time', 'post-when', whenText(post.at));
  when.dateTime = new Date(post.at).toISOString();
  when.title = fmt.dateTime(post.at);
  head.append(when);
  if (post.editedAt && !post.deletedAt) head.append(el('span', 'post-edited', t('channels:feed.edited')));
  main.append(head);

  const body = el('div', 'post-body');
  if (post.deletedAt) {
    body.append(el('span', 'post-deleted', t('channels:feed.deleted')));
  } else {
    body.innerHTML = post.attachments?.length
      ? attachedBodyHtml(post.text ?? '', post.attachments, (s) => ctx.host.renderAssistantMarkdown(s))
      : ctx.host.renderAssistantMarkdown(post.text ?? '');
    const names = (post.mentions ?? []).map((m) => (m === 'you' ? t('channels:feed.you') : ctx.bots.get(m)?.name));
    if (post.mentions?.includes('you')) names.push('you');
    highlightMentions(body, names);
    if (post.turn) paintChecklist(body, post.state === 'working');
  }
  main.append(body);

  if (!post.deletedAt) {
    const state = stateLine(post);
    if (state) main.append(state);
    const nameOf = (a) => nameOfAuthor(a, ctx);
    const row = renderReactions(post, { nameOf, onToggle: (emoji, on, had) => ctx.actions.react(post, emoji, on, had) });
    main.append(row);
    const summary = renderSummary(post, ctx);
    if (summary) main.append(summary);
  }

  root.replaceChildren(av, main);
  if (!post.deletedAt) {
    const tools = el('div', 'post-tools');
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', t('channels:feed.tools'));
    const quick = iconButton('quick', t('channels:feed.quick', { emoji: '👍' }), document.createTextNode('👍'));
    quick.onclick = () => ctx.actions.quick(post, '👍');
    const add = addButton(post, (emoji, on, had) => ctx.actions.react(post, emoji, on, had), 'post-tool add');
    const reply = iconButton('reply', t('channels:feed.reply'), replyIcon());
    reply.onclick = () => ctx.actions.openThread(post);
    const more = iconButton('more', t('channels:feed.more'), moreIcon());
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); ctx.actions.menu(post, r.right, r.bottom + 4, more); };
    tools.append(quick, add, reply, more);
    root.append(tools);
  }
  return root;
}

export function renderPost(post, ctx) {
  const root = el('div', 'post');
  root.tabIndex = -1;
  return fillPost(root, post, ctx);
}
