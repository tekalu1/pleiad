// 会話の移動の画面（docs/design-system.md「会話の移動」、ADR 0063）。
//   A 問いが上に残る: 返答を読んでいる間、その返答を生んだ発言の抜粋を #log の上端に 1 行で残す
//   C 最新へ: 末尾から離れたときだけ出る丸いボタン。読んでいる間の新着は青い丸、走っている間は弧
//   キーボード: 会話にフォーカスがあるとき Alt+↑ / Alt+↓ で前後の自分の発言、End で最新へ
//   地図（web/conversation-rail.mjs）へ、発言の並び・位置・いまの発言を渡す
//
// 性能（AGENTS.md の性能の記述）: スクロールのたびに全発言の位置を測らない。
//   - 位置は、筋の高さが変わったとき（画面の外の発言が実寸に伸びる）に ResizeObserver の中（レイアウトの直後で、読んでも
//     追加のレイアウトを起こさない）で全発言を 1 度に測って持つ。200ms より速くは測り直さない
//   - スクロールでは持っている位置と scrollTop だけを使う（二分探索。DOM を読まない）
//   - 測るときは読みだけを続け、間に書き込みを挟まない。書くのは変わったときだけ
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { userPieces, piecesText, appendPieces } from './conversation-nav.mjs';

/** 末尾からこの距離（px）以上離れたときだけ「最新へ」を出す */
export const AWAY = 120;
/** 上端から見て、この位置より上に始まった発言を「いまの発言」とする */
const PROBE = 48;
/** 問いの下端がこの位置より上に出たときだけ、上に残す */
const STICKY_EDGE = 8;
/** 全発言の位置を測り直す間隔の下限（ms） */
const MEASURE_EVERY = 200;

/** 利用者の発言の行（.mw）。コマンド・シェルの行（.m.user.cmd）は問いではないので数えない */
const TURN_USER = ':scope > .mw > .mw-body > .m.user:not(.cmd)';

const arrowIcon = () => {
  const svg = svgEl('svg', { class: 'i nav-arrow', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M12 5v14M6 13l6 6 6-6' }));
  return svg;
};

/**
 * @param {{ frame:HTMLElement, log:HTMLElement, thread:HTMLElement,
 *   scrollToEnd:()=>void, isRunning:()=>boolean, narrow:MediaQueryList, openToc?:()=>void }} o
 *   frame は #log を包む相対位置の入れ物。scrollToEnd は client.mjs の末尾追従（実寸の確定を待つ）
 */
export function createConversationNav({ frame, log, thread, scrollToEnd, isRunning, narrow, openToc = null }) {
  // ---- 部品
  const sticky = el('div', 'nav-sticky');
  sticky.hidden = true;
  const stickyButton = el('button', 'nav-sticky-button');
  stickyButton.type = 'button';
  sticky.append(stickyButton);
  const latest = el('button', 'nav-latest');
  latest.type = 'button';
  latest.hidden = true;
  latest.setAttribute('aria-keyshortcuts', 'End');
  const unread = el('span', 'nav-unread');
  unread.hidden = true;
  latest.append(arrowIcon(), unread);
  frame.append(sticky, latest);

  // 会話の本文はキーボードで届き、Alt+↑↓・End が効く領域
  log.tabIndex = 0;
  log.setAttribute('role', 'region');
  log.setAttribute('aria-label', t('nav.log.label'));
  log.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown End');

  // ---- 発言の並び
  /**
   * @type {{ user:HTMLElement, row:HTMLElement, top:number, ub:number }[]}
   * top は全数測定（measureAll）の結果（会話の内容の上端からの行の上端）。ub は行の上端から吹き出しの下端まで（いまの発言になったとき 1 度だけ測る）。
   * 画面の外の行は中身のレイアウトを省いている（content-visibility）ので、その中の要素の位置を全数で読むと、省いた分を全部レイアウトしてしまう。
   * 全数で読むのは行そのものの位置だけにする
   */
  let turns = [];
  let width = 0, turnsDirty = true, raf = 0, measureTimer = 0, lastMeasure = -Infinity, measured = false;
  const texts = new WeakMap();
  let stickyFor = null, stickyShown = null, newReplies = 0, running = false, runningMark = null, latestState = '';
  const listeners = new Set();

  const collect = () => {
    const users = [...thread.querySelectorAll(TURN_USER)];
    // 発言の並びが同じなら、同じ配列を保つ（地図の点を作り直さない）
    if (users.length === turns.length && users.every((user, i) => user === turns[i].user)) return;
    // 静かな読み直し（web/history-sync.mjs）は、変わった所から後ろの行だけを描き直す。残った行の発言は同じ要素なので、測った値を引き継ぐ
    const before = new Map(turns.map((turn) => [turn.user, turn]));
    turns = users.map((user) => { const kept = before.get(user); return kept?.row === user.closest('.mw') ? kept : { user, row: user.closest('.mw'), top: 0, ub: -1 }; });
    measured = false;
  };
  /** 全発言の位置を 1 度に測る。読みだけ。fresh は「地図が点を置き直す」合図（次の update で 1 度だけ渡す） */
  let fresh = false;
  const measureAll = () => {
    lastMeasure = performance.now();
    const box = log.getBoundingClientRect().top, y = log.scrollTop;
    for (const turn of turns) turn.top = turn.row.getBoundingClientRect().top - box + y;
    measured = true;
    fresh = true;
  };
  const fullText = (turn) => {
    // 発言の原文は .body の dataset.raw（web/client.mjs の userRaw。本文は Markdown で描くので、字だけでは印の行・コードの囲みが分からない）。
    // 添付が後から結び付いて描き直されることがあるので、原文が変わっていたら作り直す
    const body = turn.user.querySelector(':scope > .body');
    const raw = body?.dataset.raw ?? body?.textContent ?? '';
    let text = texts.get(turn.user);
    if (text === undefined || text.raw !== raw) {
      text = { raw, pieces: userPieces(raw), at: turn.user.querySelector(':scope > .who .when')?.textContent ?? '' };
      text.plain = piecesText(text.pieces);
      texts.set(turn.user, text);
    }
    return text;
  };
  const ensureTurns = () => { if (turnsDirty) { collect(); turnsDirty = false; } return turns; };

  const distance = () => log.scrollHeight - log.clientHeight - log.scrollTop;
  /** 上端（PROBE）より上に始まった最後の発言。持っている位置の二分探索（DOM を読まない）。無ければ 0（発言が無ければ -1） */
  const currentIndex = () => {
    if (!turns.length) return -1;
    const y = log.scrollTop;
    let lo = 0, hi = turns.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (turns[mid].top <= y + PROBE) lo = mid + 1; else hi = mid; }
    return Math.max(0, lo - 1);
  };

  function paintSticky() {
    const index = currentIndex(), turn = turns[index];
    let show = false;
    if (turn) {
      if (turn.ub < 0) turn.ub = turn.user.getBoundingClientRect().bottom - turn.row.getBoundingClientRect().top;
      show = turn.top + turn.ub <= log.scrollTop + STICKY_EDGE;
    }
    if (show !== stickyShown) { stickyShown = show; sticky.hidden = !show; }
    if (!show || stickyFor === turn) return;
    stickyFor = turn;
    const info = fullText(turn);
    const head = [el('span', 'nav-sticky-mark', '↳'), ' '];
    if (info.at) head.push(el('span', 'nav-sticky-time', info.at), ' ', el('span', 'nav-sticky-sep', '·'), ' ');
    const body = el('span', 'nav-sticky-text');
    appendPieces(body, info.pieces);
    stickyButton.replaceChildren(...head, body);
    stickyButton.title = narrow.matches && openToc ? t('nav.sticky.openToc') : t('nav.sticky.title', { text: info.plain });
  }

  function paintLatest() {
    const away = distance() > AWAY;
    if (!away) newReplies = 0;
    // 末尾へ戻って消えるとき、ボタンにあったフォーカスは会話へ返す（body に落とさない）
    if (!away && !latest.hidden && latest.contains(document.activeElement)) log.focus({ preventScroll: true });
    if (latest.hidden === away) latest.hidden = !away;
    // 変わったときだけ書く（スクロールのたびに書くと、その分の再計算がスクロールに乗る）
    const state = `${running}|${newReplies}`;
    if (state !== latestState) {
      latestState = state;
      latest.classList.toggle('running', running);
      unread.hidden = running || !newReplies;
      const extra = running ? t('nav.latest.running') : newReplies ? t('nav.latest.new', { count: newReplies }) : '';
      const label = extra ? t('nav.latest.withNote', { note: extra }) : t('nav.latest.label');
      latest.setAttribute('aria-label', label);
      latest.title = label;
    }
    // 走っている印は走っている間だけ DOM に置く（web/arc.mjs）。隠れている間は置かない
    if (running && away && !runningMark) { runningMark = runMark(); latest.prepend(runningMark); }
    else if ((!running || !away) && runningMark) { runningMark.remove(); runningMark = null; }
  }

  function update() {
    raf = 0;
    ensureTurns();
    // 並びが変わって全数測定がまだなら、最初の 1 回だけ待たずに測る（地図の点を置くため）
    if (!measured && turns.length) measureAll();
    const remeasured = fresh;
    fresh = false;
    paintSticky();
    paintLatest();
    for (const fn of listeners) fn(remeasured);
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  /** 筋の高さ・窓の大きさが変わった（ResizeObserver の中＝レイアウトの直後）。全数を測り直す。速すぎるときは間引いて、少し後に 1 度 */
  const invalidate = () => {
    if (measureTimer) return;
    const wait = MEASURE_EVERY - (performance.now() - lastMeasure);
    const run = () => {
      measureTimer = 0;
      ensureTurns();
      // 幅が変わると吹き出しの高さが変わる。測り直しを許す
      if (log.clientWidth !== width) { width = log.clientWidth; for (const turn of turns) turn.ub = -1; }
      measureAll();
      schedule();
    };
    if (wait <= 0) run();
    else measureTimer = setTimeout(run, wait);
  };

  // ---- 移動
  let settle = null;
  /**
   * 行の上端を会話欄の上端から gap の位置へ送る。画面の外の発言は仮の高さで並ぶので（style.css の content-visibility）、
   * 送った後に見えた分が実寸に伸びて位置がずれる。数フレームは合わせ直し、利用者が触れたらやめる
   */
  function scrollToRow(row, gap = 12) {
    settle?.abort();
    const run = settle = new AbortController();
    const want = () => !row.isConnected ? log.scrollTop : row.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - gap;
    log.scrollTop = want();
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) log.addEventListener(type, () => run.abort(), { signal: run.signal, passive: true });
    let frames = 0, calm = 0;
    const tick = () => {
      if (run.signal.aborted) return;
      const target = want();
      if (Math.abs(target - log.scrollTop) > 1) { log.scrollTop = target; calm = 0; } else calm++;
      if (++frames > 30 || calm >= 3) return run.abort();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    schedule();
  }
  function goTo(index) {
    const turn = ensureTurns()[Math.max(0, Math.min(turns.length - 1, index))];
    if (turn) scrollToRow(turn.row);
  }
  /** いまの位置より前（direction < 0）・後に始まる発言。無ければ -1。並びは上から順なので二分探索 */
  function neighbour(direction) {
    ensureTurns();
    if (!measured) measureAll();
    // 送り先は「行の上端 − 12px」。それが今の位置より 2px 以上前（後）にある発言
    const y = log.scrollTop;
    const before = (turn) => turn.top - 12 < y - 2;
    const after = (turn) => turn.top - 12 > y + 2;
    let lo = 0, hi = turns.length;
    if (direction < 0) {
      while (lo < hi) { const mid = (lo + hi) >> 1; if (before(turns[mid])) lo = mid + 1; else hi = mid; }
      return lo - 1;
    }
    while (lo < hi) { const mid = (lo + hi) >> 1; if (after(turns[mid])) hi = mid; else lo = mid + 1; }
    return lo < turns.length ? lo : -1;
  }
  function toLatest() {
    const hadFocus = latest.contains(document.activeElement);
    settle?.abort();
    scrollToEnd();
    if (hadFocus) log.focus({ preventScroll: true });
  }

  // ---- 操作
  stickyButton.addEventListener('click', () => {
    if (narrow.matches && openToc) return openToc();
    goTo(currentIndex());
  });
  latest.addEventListener('click', toLatest);
  log.addEventListener('scroll', schedule, { passive: true });
  log.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    if (target.closest?.('input,textarea,select,[contenteditable="true"],[role="slider"]')) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const index = neighbour(event.key === 'ArrowUp' ? -1 : 1);
      event.preventDefault();
      if (index >= 0) goTo(index);
    } else if (event.key === 'End' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (target === log || !target.closest?.('summary,button,a,pre'))) {
      event.preventDefault();
      toLatest();
    }
  });

  // ---- 見張り
  // 筋の高さが変わったとき（発言の追記・畳みの開閉・実寸の確定）と、窓の大きさが変わったときは、全数測定を間引いて 1 度だけ
  const resize = new ResizeObserver(invalidate);
  resize.observe(thread);
  resize.observe(log);
  // 発言の増減だけは並びから取り直す（中身の変化では取り直さない）
  new MutationObserver((records) => {
    if (records.some((r) => r.addedNodes.length || r.removedNodes.length)) { turnsDirty = true; schedule(); }
  }).observe(thread, { childList: true });
  narrow.addEventListener('change', () => { stickyFor = null; schedule(); });

  return {
    /** 発言の並びが変わった（会話を開いた・描き直した） */
    refresh() { turnsDirty = true; schedule(); },
    /** 会話を替えた。新着と位置の記憶を捨てる */
    reset() { newReplies = 0; stickyFor = null; turnsDirty = true; measured = false; schedule(); },
    /** 返答が 1 件届いた（ターンの終わり）。末尾から離れているときだけ新着に数える */
    replyArrived() { if (distance() > AWAY) { newReplies++; schedule(); } },
    /** 走っているか（弧を出すか）が変わった */
    syncRunning() { const now = isRunning(); if (now !== running) { running = now; schedule(); } },
    goTo, neighbour, currentIndex, scrollToRow, schedule, invalidate,
    /** 発言の並びと、最後に測った位置（top）。地図の点用 */
    turns: () => ensureTurns(),
    turnInfo: fullText,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
