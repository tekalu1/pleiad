// スレッドの空間モデル（W3。ADR 0111、docs/channels.md「画面」）。
// 横に並んだ 3 枚［チャンネルの流れ 4｜スレッド 6｜右パネルの道具 4］を 2 枚分の窓で見る。道具（右パネル）は body の 3 列目にあるので、ここが持つのは流れとスレッドの 2 枚だけ。
//   feed … 流れだけ（スレッドを開いていない）   split … ［流れ｜スレッド］（右パネルが閉じていて、幅が足りる）   solo … スレッドだけ（右パネルが開いている・幅が足りない）
// 窓の幅（= メインの幅）が 900px 未満なら、右パネルが閉じていても solo。右パネルを開く・スレッドを開く閉じる・幅が変わるで状態が替わり、
// 替わるときは「前にあった位置」から「今の位置」へ 2 枚を transform で滑らせるだけ（FLIP。約 200ms。動きを減らす設定では切り替えだけ）。
// 中身は作り直さない（スクロール位置・下書き・入力欄の位置が保たれる）。隠れている板は visibility で隠すだけで、DOM も下書きも残す。
import { el } from '../dom.mjs';

/** メインの幅がこれ未満なら、流れを出さずスレッドだけを全幅で出す */
export const SOLO_BELOW = 900;

/**
 * 窓の状態。スレッドが無ければ feed、右パネルが開いているか幅が足りなければ solo、そうでなければ split。
 * @param {{ hasThread: boolean, panelOpen: boolean, width: number }} o
 * @returns {'feed'|'split'|'solo'}
 */
export function deckState({ hasThread, panelOpen, width }) {
  if (!hasThread) return 'feed';
  return panelOpen || width < SOLO_BELOW ? 'solo' : 'split';
}

/** 右パネルが（全面に広げずに）開いているか。広げているとき（file-preview-wide）は main が隠れる */
const panelOpen = () => document.body.classList.contains('file-preview-open');

const msOf = (node) => {
  const raw = getComputedStyle(node).getPropertyValue('--dur-deck').trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
};

/**
 * @param {object} o
 * @param {HTMLElement} o.view  #channelsView
 * @param {HTMLElement} o.body  #channelsBody
 * @param {HTMLElement} o.feed  #chFeed（流れの部品が作った板。ここへ移す）
 * @param {HTMLElement} o.thread  #chThread
 * @param {HTMLElement} o.top  #channelsView > .top（流れの見出し。流れが出ている間は流れの板の頭に置く）
 * @param {(state: string) => void} [o.onState]
 */
export function createDeck({ view, body, feed, thread, top, onState = () => {} }) {
  const deck = el('div', 'deck');
  deck.id = 'chDeck';
  deck.dataset.deck = 'feed';
  deck.hidden = feed.hidden;
  body.prepend(deck);
  deck.append(feed, thread);
  thread.hidden = false;

  let hasThread = false;
  let last = null;   // 落ち着いているときの 2 枚の位置（画面の座標）。レイアウトが替わった後でも「前の位置」を引くために控える
  const rects = () => ({ feed: feed.getBoundingClientRect(), thread: thread.getBoundingClientRect() });
  const running = new Set();   // 動いている最中の滑り（全部終わるまで moving を付けておく）
  const animating = () => deck.classList.contains('moving');

  /** スレッドの板が見えているか（隠れている板には触らない: フォーカスもキーも受けない） */
  const settle = (state) => {
    feed.inert = state === 'solo';
    thread.inert = state === 'feed';
    feed.setAttribute('aria-hidden', String(state === 'solo'));
    thread.setAttribute('aria-hidden', String(state === 'feed'));
  };

  function play(before, after) {
    const dur = msOf(deck);
    if (!before || !dur) return;
    const moves = [];
    for (const [name, node] of [['feed', feed], ['thread', thread]]) {
      const b = before[name], a = after[name];
      const dx = b.left - a.left;
      // 流れは幅も変わる（全幅 ⇄ 4 割）。スレッドは幅を動かさず滑らせるだけ（中身を組み直さない）
      const dw = name === 'feed' ? b.width - a.width : 0;
      if (Math.abs(dx) < 1 && Math.abs(dw) < 1) continue;
      const from = { transform: `translateX(${dx}px)` };
      const to = { transform: 'translateX(0)' };
      if (name === 'feed') { from.width = `${b.width}px`; to.width = `${a.width}px`; }
      moves.push(node.animate([from, to], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)' }));
    }
    if (!moves.length) return;
    deck.classList.add('moving');   // 隠れる側も動き終わるまでは見せる（visibility）。流れの入力欄も畳んだまま
    for (const m of moves) {
      running.add(m);
      const end = () => {
        running.delete(m);
        if (running.size) return;
        deck.classList.remove('moving');
        last = deck.hidden ? null : rects();
      };
      m.finished.then(end, end);
    }
  }

  /** 状態を決め直す。変わったら前の位置から滑らせる */
  function sync() {
    const width = deck.getBoundingClientRect().width;
    if (!width) { last = null; return; }   // 見えていない（別のタブ・bot のページ）間は決めない。次に見えたときに動きは付けない
    const next = deckState({ hasThread, panelOpen: panelOpen(), width });
    const prev = deck.dataset.deck;
    if (next === prev) { if (!animating()) last = rects(); return; }
    const before = animating() ? rects() : last;
    deck.dataset.deck = next;
    settle(next);
    const after = rects();
    play(before, after);
    if (!animating()) last = after;
    onState(next, prev);
  }

  new ResizeObserver(() => sync()).observe(deck);
  // 右パネルの開閉（body.file-preview-open）。ここは右パネルの幅を待たずに、クラスが付いた直後に決める
  new MutationObserver(() => sync()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // 流れの見出し: 流れが出ている間は流れの板の頭に置く（スレッドの見出しと横に並ぶ）。bot のページなど流れが無い面では元の位置（全幅）
  const placeTop = () => {
    deck.hidden = feed.hidden;
    if (!feed.hidden) { if (top.parentNode !== feed) feed.prepend(top); } else if (top.parentNode !== view) view.prepend(top);
    sync();
  };
  new MutationObserver(placeTop).observe(feed, { attributes: true, attributeFilter: ['hidden'] });
  settle('feed');
  placeTop();

  return {
    el: deck,
    get state() { return deck.dataset.deck; },
    get hasThread() { return hasThread; },
    /** スレッドを開く・閉じる */
    setThread(on) {
      if (hasThread === on) return;
      hasThread = on;
      sync();
    },
    sync,
  };
}
