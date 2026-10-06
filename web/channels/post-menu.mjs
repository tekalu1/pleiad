// 投稿のメニュー（Chats の発言のメニューと同じ並び。web/message-actions.mjs の messageMenuPlan。ADR 9101）。
// あなたの投稿 = コピー・（エージェントに渡した原文を見る）・｜・リアクション。bot の返事 = 返答をコピー・｜・リアクション。
// 分岐・編集して再送信・再送信は、それぞれの段（分岐・送り直し）で足す。「会話を開く」は仕上げの段で消す（それまで残す）。
// 右クリック・長押し・Shift+F10・メニューキーは setupMessageMenu（Chats と同じ口）で受ける。
import { messageMenuPlan, copyToClipboard, hoverless, setupMessageMenu } from '../message-actions.mjs';

/**
 * 投稿のメニューの項目（host.showMenu に渡す形）と、ホバーの無い端末で先頭に置く時刻の行
 * @param {object} o
 * @param {object} o.post 投稿
 * @param {(key: string, params?: object) => string} o.t
 * @param {string} o.name 書いた人の名前
 * @param {string} o.time 投稿の時刻の字（13:17）
 * @param {HTMLElement|null} [o.copyButton] 投稿の道具のコピー（✓ を出す）
 * @param {() => void} o.react リアクションの面を開く
 * @param {(() => void)|null} [o.reply] 「スレッドで返信」（流れだけ）
 * @param {(() => void)|null} [o.source] エージェントに渡した原文を見る（bot が受けた人の投稿だけ）
 * @param {(() => void)|null} [o.openSession] 会話を開く（仕上げの段まで残す）
 * @returns {{ items: object[], title: string|undefined }}
 */
export function postMenu({ post, t, name, time, copyButton = null, react, reply = null, source = null, openSession = null }) {
  const kind = post.author?.kind === 'human' ? 'user' : 'ai';
  const plan = messageMenuPlan({ kind, canFork: false, editable: false, source: kind === 'user' && Boolean(source) });
  const run = { copy: () => copyToClipboard(post.text ?? '', copyButton), source: () => source?.() };
  const items = [
    ...(reply ? [{ label: t('channels:feed.reply'), onClick: reply }] : []),
    ...plan.map((p) => (p.sep ? { sep: true } : { label: p.label, onClick: run[p.key] })),
    { sep: true },
    { label: t('channels:feed.react'), onClick: react },
    ...(openSession ? [{ label: t('channels:feed.openSession'), onClick: openSession }] : []),
  ];
  // ホバーの無い端末は、時刻を出す手段が押すことしか無いので、メニューの先頭に置く（Chats と同じ）
  const title = hoverless() && time ? (kind === 'user' ? t('chat.message.sentAt', { time }) : `${time} · ${name}`) : name;
  return { items, title };
}

/**
 * 投稿の列（log）の右クリック・長押し・Shift+F10・メニューキーを受ける。open(post node, at) が開く。
 * at は { x, y } か、キーボードなら key: true（⋯ の下に出す）
 */
export function setupPostMenu(log, open) {
  setupMessageMenu(log, {
    resolve: (target) => {
      const node = target?.closest?.('.post');
      // 提示（.present）は自分のメニューを持つ。投稿の道具にフォーカスがあるときの Shift+F10 は投稿のメニュー
      if (!node || target.closest('.present')) return null;
      return { m: node };
    },
    open: ({ m }, at) => open(m, at),
  });
}

/** メニューを出す位置: 押した位置。キーボード・位置の無いときは ⋯ の下（右を揃える） */
export function menuPoint(node, at = {}) {
  if (at.key || (!at.x && !at.y)) {
    const more = node.querySelector('.post-tool.more');
    const r = (more ?? node).getBoundingClientRect();
    return { x: more ? r.right : r.left + 8, y: r.bottom + 4, alignRight: Boolean(more) };
  }
  return { x: at.x, y: at.y, alignRight: false };
}
