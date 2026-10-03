// 投稿 1 件の描画（チャンネルの流れ。docs/design-system.md「チャンネルの流れ」）。
//   .post[data-post-id] > .post-av・.post-main（.post-head・.post-body・.post-state・.reactions・.thread-summary）・.post-tools
// 本文は host.renderAssistantMarkdown（エスケープ済みの HTML。bot の返事と同じ描き方）。@ の呼びかけだけ後から色を付ける。
// 発言者は Author（core/channels/types.mjs）。bot は bots.list の定義（アイコン・名前・バックエンド）から引く。
import { el, svgEl } from '../dom.mjs';
import { fmt, t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { renderReactions, addButton } from './reactions.mjs';

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

/** 状態の行（bot のターンの投稿・ルーティンの実行の根）。成功を緑の ✓ で見せない（終了は文字だけ） */
function stateLine(post) {
  const state = post.state;
  if (!state) return null;
  if (state === 'done' && !post.routine) return null;
  const row = el('div', `post-state ${state}`);
  if (state === 'working') row.append(runMark(t('channels:feed.state.working')));
  else if (state === 'waiting') row.append(el('span', 'post-state-mark', '◆'));
  else if (state === 'failed') row.append(el('span', 'post-state-mark', '✕'));
  // i18n-dynamic: channels:feed.state.
  const label = t(`channels:feed.state.${state}`);
  const reason = post.routine?.missed ? t('channels:feed.state.missed') : post.routine?.reason;
  row.append(el('span', 'post-state-text', reason && (state === 'skipped' || post.routine?.missed) ? `${label} · ${reason}` : label));
  return row;
}

/** スレッドの要約の行。「💬 3 件の返信 · 🦉 Owl 作業中」。返信が無ければ null */
export function renderSummary(post, ctx) {
  const s = ctx.summaryOf?.(post.id);
  if (!s?.count || post.threadId) return null;
  const th = ctx.threadOf?.(post.id);
  const b = el('button', 'thread-summary');
  b.type = 'button';
  b.setAttribute('aria-label', t('channels:feed.openThread', { count: s.count }));
  b.append(el('span', 'ts-count', `💬 ${t('channels:feed.replies', { count: s.count })}`));
  const lastBot = [...(s.authors ?? [])].reverse().find((a) => a.kind === 'bot');
  const botId = lastBot?.botId ?? Object.keys(th?.sessions ?? {})[0];
  const bot = botId ? ctx.bots.get(botId) : null;
  const who = bot ? `${bot.icon} ${bot.name}` : t('channels:feed.unknownBot');
  const status = el('span', 'ts-status');
  if (th?.state === 'working') {
    status.classList.add('working');
    status.append(`· ${who} ${t('channels:feed.threadWorking')}`, runMark(t('channels:feed.state.working')));
  } else if (th?.state === 'waiting') {
    status.classList.add('waiting');
    status.append('· ', el('span', 'ts-mark', '◆'), ` ${t('channels:feed.threadWaiting', { name: bot?.name ?? t('channels:feed.unknownBot') })}`);
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
  const av = el('span', `post-av${info.you ? ' you' : ''}`, info.avatar);
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
    body.innerHTML = ctx.host.renderAssistantMarkdown(post.text ?? '');
    const names = (post.mentions ?? []).map((m) => (m === 'you' ? t('channels:feed.you') : ctx.bots.get(m)?.name));
    if (post.mentions?.includes('you')) names.push('you');
    highlightMentions(body, names);
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
