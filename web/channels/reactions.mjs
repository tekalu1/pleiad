// 投稿のリアクション（チャンネルの流れ。docs/design-system.md「チャンネルの流れ」）。
// 任意の絵文字。札（.react-pill）を押すと自分の分を付け外し、＋（.react-add）で絵文字ピッカー（web/emoji-picker.mjs）を開く。
// 書き込みは channels.react（人も bot も同じ操作）。ここは描画と、押したときの意図（on / off）を決めるだけ。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { openEmojiPicker } from '../emoji-picker.mjs';

/** 画面の人（あなた）の分か。Author の kind が human のものだけ。この画面の操作主体は常に人 */
export const isMine = (author) => author?.kind === 'human';

/**
 * reactions（{ 絵文字: Author[] }）→ 札の並び。付いた順（オブジェクトの順）。空の絵文字は出さない。
 * @returns {{ emoji: string, authors: object[], count: number, mine: boolean }[]}
 */
export function pillsOf(reactions) {
  return Object.entries(reactions ?? {})
    .filter(([, authors]) => Array.isArray(authors) && authors.length)
    .map(([emoji, authors]) => ({ emoji, authors, count: authors.length, mine: authors.some(isMine) }));
}

/** 札を押したときの次の状態に、手元の reactions を先に進める（サーバーの返りが来るまでの見かけ）。元は変えない */
export function withReaction(reactions, emoji, on) {
  const next = {};
  for (const [e, authors] of Object.entries(reactions ?? {})) next[e] = [...authors];
  const list = (next[emoji] ??= []);
  const at = list.findIndex(isMine);
  if (on && at < 0) list.push({ kind: 'human' });
  if (!on && at >= 0) list.splice(at, 1);
  if (!list.length) delete next[emoji];
  return next;
}

const smilePlus = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 11, cy: 13, r: 7.5 }), svgEl('path', { d: 'M8 15c1.6 1.7 4.4 1.7 6 0M8.6 11h.01M13.4 11h.01' }), svgEl('path', { d: 'M19.5 2.5v4M17.5 4.5h4' }));
  return svg;
};
export const reactionIcon = smilePlus;

/**
 * リアクションの行を作る。札が 1 つも無いときは空（CSS で畳む）。
 * @param {object} post
 * @param {object} o
 * @param {(author: object) => string} o.nameOf 発言者の表示名（札に触れたときの「誰が付けたか」）
 * @param {(emoji: string, on: boolean) => void} o.onToggle 札を押した・ピッカーで選んだ
 */
export function renderReactions(post, { nameOf, onToggle }) {
  const row = el('div', 'reactions');
  const pills = pillsOf(post.reactions);
  for (const p of pills) {
    const b = el('button', `react-pill${p.mine ? ' mine' : ''}`);
    b.type = 'button';
    b.dataset.emoji = p.emoji;
    b.setAttribute('aria-pressed', String(p.mine));
    const who = p.authors.map(nameOf).join(t('channels:feed.reactionSep'));
    b.title = who + (p.mine ? t('channels:feed.reactionOff') : t('channels:feed.reactionOn'));
    b.setAttribute('aria-label', `${p.emoji} ${p.count} · ${who}`);
    b.append(el('span', 'react-emoji', p.emoji), el('span', 'react-n', String(p.count)));
    b.onclick = () => onToggle(p.emoji, !p.mine);
    row.append(b);
  }
  if (pills.length) row.append(addButton(post, onToggle));
  return row;
}

/** ＋（リアクションを足す）。札の行の右と、ホバーの道具の 2 か所で使う */
export function addButton(post, onToggle, cls = 'react-add') {
  const b = el('button', cls);
  b.type = 'button';
  b.title = t('channels:feed.react');
  b.setAttribute('aria-label', t('channels:feed.react'));
  b.setAttribute('aria-haspopup', 'dialog');
  b.append(smilePlus());
  b.onclick = (e) => {
    e.stopPropagation();
    const mine = new Set(pillsOf(post.reactions).filter((p) => p.mine).map((p) => p.emoji));
    openEmojiPicker({ anchor: b, title: t('channels:feed.reactPicker'), onPick: (emoji) => onToggle(emoji, true, mine.has(emoji)) });
  };
  return b;
}
