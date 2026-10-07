// 目次と会話の中の検索（docs/design-system.md「会話の移動」D、ADR 0063）。
// 広い画面では右パネル（web/file-preview.mjs の openPanel。ファイルプレビューと同じ枠）、狭い画面（700px 以下）では下からのシート。
// 中身は同じ部品: 検索欄（pill）・対象の区分（発言 / ＋返答 / ＋ツール）・並び順・一覧。
//
// 探す先は描かれた会話（DOM）。この画面は履歴を全部描くので、描かれていない範囲は無い（画面の外の発言も content-visibility で
// 中身のレイアウトを省くだけで、DOM には居る）。一致の数え方と印の付け方は同じ走査（テキストノード）を使うので、数と印が食い違わない。
// 印（<mark>）は、一致のある発言のうち画面の近くに来たものと、いま指している一致の発言にだけ付ける（大きな会話で全部に付けない）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { closeIcon } from './icons.mjs';
import { turnKinds } from './conversation-rail.mjs';
import { bundleOf } from './tool-bundle.mjs';
import { revealFold } from './fold.mjs';
import { SCOPES, inScope, matchRanges, countMatches, scopeTallies, assignHits, entryOfHit, listRows, excerptAround, toolTarget, appendPieces, badge } from './conversation-nav.mjs';

const KEY = 'conversation-toc';
/** 右パネルの幅（px）。モックの 340px */
const PANEL_WIDTH = 340;
/** 検索の入力から一致を数えるまでの待ち（ms） */
const TYPING_WAIT = 120;
/** 印を付ける範囲（会話欄の上下からの距離） */
const MARK_MARGIN = '700px 0px';

const icons = {
  search: ['circle:11,11,6', 'M20 20l-4.5-4.5'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6'],
  close: ['M6 6l12 12M18 6 6 18'],
  sort: ['M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5'],
};
function svg(name) {
  const node = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of icons[name]) {
    if (d.startsWith('circle:')) { const [cx, cy, r] = d.slice(7).split(','); node.append(svgEl('circle', { cx, cy, r })); } else node.append(svgEl('path', { d }));
  }
  return node;
}

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** 検索・抜粋に使わない文字（コピーのボタンなど） */
const usable = (node) => !node.parentElement?.closest('button,summary,.code-copy');

/**
 * @param {{ thread:HTMLElement, log:HTMLElement, nav:object, preview:object, narrow:MediaQueryList, button:HTMLElement, entriesOf?:Function }} o
 *   preview は web/file-preview.mjs の返り値（openPanel・close・panelOpen）。button は見出しの目次のボタン
 *   entriesOf は項目の作り方（既定は Chats の会話の筋）。チャンネルのスレッドは投稿の列から作る（web/channels/thread.mjs）:
 *   ({ turns, kinds, turnInfo }) → { kind: 'user'|'answer'|'tool', turn, row, el, bodies?, at, pending? }[]（bodies は探す対象の要素）
 */
export function createConversationToc({ thread, log, nav, preview, narrow, button, entriesOf = null }) {
  // ---- 状態（会話を開いている間は保つ。会話を替えたら reset）
  let query = '', scope = 'user', newestFirst = false, hitIndex = -1, total = 0;
  let entries = [], entriesDirty = true, opened = false, sheet = null, opener = null, typing = 0, active = -1;
  /** 脇の検索から語を引き継いだ（carry）。パネルを開いていなくても、本文の一致に印を付けておく。開く・語を替える・会話を替えると終わる */
  let carried = false;
  /** @type {Map<number, HTMLButtonElement>} 発言（ターン）→ 目次の行 */
  let turnRows = new Map();
  const markedEntries = new Set();
  let observer = null;

  // ---- 部品
  const root = el('div', 'toc');
  const input = el('input');
  input.type = 'text';
  input.className = 'toc-query';
  input.setAttribute('role', 'searchbox');
  input.setAttribute('aria-label', t('nav.toc.search'));
  input.placeholder = t('nav.toc.search');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const count = el('span', 'toc-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  count.hidden = true;
  const iconButton = (className, label, name) => {
    const b = el('button', `toc-nb ${className}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(svg(name));
    b.hidden = true;
    return b;
  };
  const prevHit = iconButton('toc-prev', t('nav.toc.prevHit'), 'up');
  const nextHit = iconButton('toc-next', t('nav.toc.nextHit'), 'down');
  const clear = iconButton('toc-clear', t('nav.toc.clear'), 'close');
  const combo = el('div', 'toc-combo');
  combo.append(svg('search'), input, count, prevHit, nextHit, clear);
  const seg = el('div', 'toc-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', t('nav.toc.scopeLabel'));
  const scopeButtons = SCOPES.map((key, i) => {
    const b = el('button', 'toc-scope');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.scope = key;
    // i18n-dynamic: nav.toc.scope.
    b.append(el('span', null, t(`nav.toc.scope.${key}`)));
    const tally = el('span', 'toc-badge');
    tally.setAttribute('aria-hidden', 'true');
    b.append(tally);
    b.tabIndex = i === 0 ? 0 : -1;
    seg.append(b);
    return b;
  });
  const sortButton = el('button', 'toc-sort');
  sortButton.type = 'button';
  sortButton.append(svg('sort'));
  const scopeRow = el('div', 'toc-scope-row');
  scopeRow.append(seg, sortButton);
  const list = el('div', 'toc-list');
  const searchbox = el('div', 'toc-searchbox');
  searchbox.append(combo);
  root.append(searchbox, scopeRow, list);

  // ---- 発言の一覧（DOM から作る）
  /** 会話の筋を 1 度走査して、発言・返答・ツールの項目を文書の順に並べる */
  function build() {
    const turns = nav.turns();
    const kinds = turnKinds(thread, turns);
    if (entriesOf) {
      entries = entriesOf({ turns, kinds, turnInfo: nav.turnInfo }).map((e, id) => ({ ...e, id, ...(e.kind === 'user' ? { turnObj: turns[e.turn] } : {}), hits: 0, hitStart: -1, marks: [] }));
      entriesDirty = false;
      return;
    }
    const turnOf = new Map(turns.map((turn, i) => [turn.row, i]));
    const out = [];
    let turn = -1;
    const at = (node) => node?.querySelector(':scope > .who .when')?.textContent ?? '';
    for (const child of thread.children) {
      if (turnOf.has(child)) {
        turn = turnOf.get(child);
        out.push({ id: out.length, kind: 'user', turn, row: child, el: turns[turn].user, turnObj: turns[turn], at: nav.turnInfo(turns[turn]).at, pending: kinds[turn] === 'pending', hits: 0, hitStart: -1, marks: [] });
        continue;
      }
      const ai = child.querySelector?.(':scope > .mw-body > .m.ai');
      if (!ai) continue;
      let answer = null;
      for (const node of ai.children) {
        if (node.matches('.body')) {
          if (!answer) { answer = { id: out.length, kind: 'answer', turn, row: child, el: ai, bodies: [], at: at(ai), hits: 0, hitStart: -1, marks: [] }; out.push(answer); }
          answer.bodies.push(node);
        } else if (node.matches('.tc') || node.matches('.bundle')) {
          // ツールのまとまり（web/tool-bundle.mjs、ADR 0061）の中の行も、1 件ずつ項目にする
          const cards = node.matches('.tc') ? [node] : [...node.querySelectorAll('.tc')].filter((c) => !c.parentElement.closest('.tc'));
          for (const card of cards) out.push({ id: out.length, kind: 'tool', turn, row: child, el: card, at: at(ai), hits: 0, hitStart: -1, marks: [] });
        }
      }
    }
    entries = out;
    entriesDirty = false;
  }
  /** 項目の中で探す・印を付ける対象の要素 */
  const targets = (entry) => (entry.bodies && entry.kind !== 'tool' ? entry.bodies : entry.kind === 'user' ? [entry.el.querySelector(':scope > .body')].filter(Boolean)
    : entry.kind === 'answer' ? entry.bodies : [...entry.el.querySelectorAll('.tc-output')]);
  const textNodes = (target) => {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (usable(walker.currentNode)) nodes.push(walker.currentNode);
    return nodes;
  };
  /** 項目の本文（畳んだ 1 行）。作り直すまで覚える（一覧の描き直しのたびに全文を読まない） */
  const entryText = (entry) => (entry.text ??= collapse(targets(entry).map((x) => x.textContent).join(' ')));

  // ---- 検索
  function clearMarks() {
    for (const entry of markedEntries) {
      for (const mark of entry.marks) if (mark.isConnected) mark.replaceWith(document.createTextNode(mark.textContent));
      entry.marks = [];
      for (const target of targets(entry)) target.normalize();
    }
    markedEntries.clear();
    observer?.disconnect();
  }
  function markEntry(entry) {
    if (!query || entry.marks.length || !entry.hits) return;
    for (const target of targets(entry)) {
      for (const node of textNodes(target)) {
        const ranges = matchRanges(node.nodeValue, query);
        if (!ranges.length) continue;
        const frag = document.createDocumentFragment();
        let from = 0;
        for (const r of ranges) {
          if (r.start > from) frag.append(node.nodeValue.slice(from, r.start));
          const mark = el('mark', 'searchhit', node.nodeValue.slice(r.start, r.end));
          frag.append(mark);
          entry.marks.push(mark);
          from = r.end;
        }
        if (from < node.nodeValue.length) frag.append(node.nodeValue.slice(from));
        node.replaceWith(frag);
      }
    }
    markedEntries.add(entry);
    if (hitIndex >= entry.hitStart && hitIndex < entry.hitStart + entry.hits) entry.marks[hitIndex - entry.hitStart]?.classList.add('active');
  }
  function observeMarks() {
    observer?.disconnect();
    if (!query || !(opened || carried)) return;
    observer ??= new IntersectionObserver((records) => {
      for (const r of records) if (r.isIntersecting) { const entry = entryByRow.get(r.target); if (entry) for (const e of entry) markEntry(e); observer.unobserve(r.target); }
    }, { root: log, rootMargin: MARK_MARGIN });
    entryByRow = new Map();
    for (const entry of entries) {
      if (entry.hitStart < 0) continue;
      if (!entryByRow.has(entry.row)) { entryByRow.set(entry.row, []); observer.observe(entry.row); }
      entryByRow.get(entry.row).push(entry);
    }
  }
  let entryByRow = new Map();

  /** 検索語・対象が変わった。一致を数え直し、印・件数・一覧を合わせる。select なら最初の一致を指す */
  function search({ select = true } = {}) {
    if (entriesDirty) build();
    clearMarks();
    const q = query;
    for (const entry of entries) {
      entry.hits = 0;
      if (!q) continue;
      for (const target of targets(entry)) for (const node of textNodes(target)) entry.hits += countMatches(node.nodeValue, q);
    }
    total = q ? assignHits(entries, scope) : 0;
    const previous = hitIndex;
    hitIndex = -1;
    paintControls();
    paintList();
    observeMarks();
    if (total) selectHit(select ? 0 : Math.min(Math.max(previous, 0), total - 1), { scroll: select });
    else paintCount();
  }

  function paintCount() {
    const searching = Boolean(query);
    count.hidden = prevHit.hidden = nextHit.hidden = !searching;
    clear.hidden = !searching;
    count.textContent = total ? t('nav.toc.count', { index: hitIndex + 1, total }) : t('nav.toc.none');
    prevHit.disabled = nextHit.disabled = !total;
  }
  function paintControls() {
    const tallies = scopeTallies(entries, Boolean(query));
    for (const b of scopeButtons) {
      const key = b.dataset.scope, on = key === scope;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.querySelector('.toc-badge').textContent = badge(tallies[key]);
      // i18n-dynamic: nav.toc.scopeFull.
      const full = t(`nav.toc.scopeFull.${key}`);
      const label = query ? t('nav.toc.scopeMatches', { scope: full, count: tallies[key] }) : t('nav.toc.scopeItems', { scope: full, count: tallies[key] });
      b.title = label;
      b.setAttribute('aria-label', label);
    }
    sortButton.setAttribute('aria-pressed', String(newestFirst));
    sortButton.title = newestFirst ? t('nav.toc.sortNewest') : t('nav.toc.sortOldest');
    sortButton.setAttribute('aria-label', t('nav.toc.sortLabel'));
    paintCount();
  }

  /** 指す一致を替える。scroll なら、その一致が見える位置へ送る（畳まれたツールの出力は開く） */
  function selectHit(index, { scroll = true } = {}) {
    if (!total) return;
    const previous = entryOfHit(entries, hitIndex);
    hitIndex = ((index % total) + total) % total;
    if (previous) for (const m of previous.marks) m.classList.remove('active');
    const entry = entryOfHit(entries, hitIndex);
    if (!entry) return;
    markEntry(entry);
    const mark = entry.marks[hitIndex - entry.hitStart];
    for (const m of entry.marks) m.classList.toggle('active', m === mark);
    paintCount();
    if (scroll) sendTo(mark ?? entry.row, mark ?? entry.el, 90);
  }
  /**
   * 畳まれたところ（<details>・閉じたツールのまとまり・長い発言の畳み。ADR 0061）を開いて見せる。まとまりは開く動き（240ms）があるので、終わってから送る
   * （動いている間に送ると、行の高さが伸びる前の位置へ着いてしまう）
   */
  function sendTo(target, inside, gap) {
    let animated = false;
    const card = inside.closest?.('.tc');
    const bundle = card && bundleOf(card);
    if (bundle && !bundle.expanded && card !== bundle.cur) { bundle.reveal(card); animated = true; }
    for (let node = inside.closest?.('details'); node; node = node.parentElement?.closest('details')) node.open = true;
    revealFold(inside);   // 長い発言の畳まれた部分（動かさずに開く。web/fold.mjs）
    if (animated) setTimeout(() => nav.scrollToRow(target, gap), 320); else nav.scrollToRow(target, gap);
  }

  // ---- 一覧
  function rowExcerpt(entry) {
    const body = el('span', 'toc-excerpt');
    const searching = Boolean(query);
    if (entry.kind === 'tool') {
      const label = entry.el.querySelector('.tc-label')?.textContent ?? '';
      body.append(el('span', 'toc-verb', label), ' ');
      if (searching) {
        const line = [...entry.el.querySelectorAll('.tc-output')].flatMap((x) => x.textContent.split(/\r?\n/)).find((l) => matchRanges(l, query).length);
        appendWindow(body, line ?? '', 8);
      } else body.append(toolTarget(entry.el.querySelector('.tc-input')?.textContent ?? '') || collapse(entry.el.querySelector('.tc-head')?.textContent).replace(label, '').trim());
      return body;
    }
    if (entry.pending) body.append(el('span', 'toc-pending', '◆'), ' ');
    if (searching) { appendWindow(body, entryText(entry), entry.kind === 'user' ? 14 : 8); return body; }
    if (entry.kind === 'user') appendPieces(body, nav.turnInfo(entry.turnObj).pieces);
    else body.append(entryText(entry).slice(0, 200));
    return body;
  }
  function appendWindow(body, text, before) {
    const w = excerptAround(text, query, { before });
    if (!w) { body.append(collapse(text).slice(0, 140)); return; }
    body.append(`${w.cut ? '…' : ''}${w.head}`, el('b', 'searchhit', w.hit), w.tail);
  }
  /** 行の title（全文）。発言は抜粋の規則で畳んだ全文、返答は先頭 600 字、ツールは行の文字 */
  function fullLabel(entry, excerpt) {
    if (entry.kind === 'user') return nav.turnInfo(entry.turnObj).plain;
    return entry.kind === 'answer' ? entryText(entry).slice(0, 600) : collapse(excerpt.textContent);
  }

  function paintList() {
    const rows = listRows(entries, { scope, searching: Boolean(query), newestFirst });
    const frag = document.createDocumentFragment();
    turnRows = new Map();
    for (const entry of rows) {
      const b = el('button', `toc-row k-${entry.kind}`);
      b.type = 'button';
      b.dataset.id = String(entry.id);
      const excerpt = rowExcerpt(entry);
      b.append(excerpt, el('small', null, entry.at));
      b.title = fullLabel(entry, excerpt);
      if (entry.kind === 'user') { b.dataset.turn = String(entry.turn); turnRows.set(entry.turn, b); }
      frag.append(b);
    }
    if (!rows.length) frag.append(el('p', 'toc-empty', query ? t('nav.toc.noMatch') : t('nav.toc.noItems')));
    list.replaceChildren(frag);
    active = -1;
    paintCurrent();
  }
  function paintCurrent() {
    const current = nav.currentIndex();
    if (current === active) return;
    turnRows.get(active)?.removeAttribute('aria-current');
    active = current;
    turnRows.get(current)?.setAttribute('aria-current', 'true');
  }

  function go(entry) {
    if (narrow.matches) close();
    if (query && entry.hitStart >= 0) return selectHit(entry.hitStart);
    if (entry.kind === 'user') return nav.goTo(entry.turn);
    if (entry.kind === 'tool') { const d = entry.el.querySelector('details'); if (d) d.open = true; }
    sendTo(entry.kind === 'tool' ? entry.el : entry.row, entry.el, 12);
  }

  // ---- 開閉
  function fill() {
    if (entriesDirty) build();
    search({ select: false });
  }
  function open(source) {
    opener = source ?? (narrow.matches ? document.activeElement : button);
    if (opened) { input.focus(); input.select(); return; }
    opened = true;
    button.setAttribute('aria-expanded', 'true');
    if (narrow.matches) openSheet(); else {
      preview.openPanel({ key: KEY, title: t('nav.toc.title'), body: root, label: t('nav.toc.title'), element: button, width: PANEL_WIDTH, onClose: cleanup });
    }
    fill();
    requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.select(); });
  }
  function close() {
    if (!opened) return;
    if (sheet) closeSheet(); else if (preview.panelOpen(KEY)) preview.close();
    else cleanup();
  }
  /** パネル・シートが閉じた後（どちらの経路でも）。印を外し、状態（検索語・対象・並び順）は残す */
  function cleanup() {
    if (!opened) return;
    opened = false;
    carried = false;
    clearMarks();
    button.setAttribute('aria-expanded', 'false');
  }
  const isOpen = () => opened;

  // ---- 下からのシート（狭い画面）
  function openSheet() {
    sheet = el('div', 'toc-sheet-wrap');
    const veil = el('div', 'toc-veil');
    const box = el('section', 'toc-sheet');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', t('nav.toc.title'));
    const head = el('div', 'toc-sheet-head');
    head.append(el('b', null, t('nav.toc.title')));
    const closeButton = el('button', 'toc-sheet-close');
    closeButton.type = 'button';
    closeButton.title = t('nav.toc.close');
    closeButton.setAttribute('aria-label', t('nav.toc.close'));
    closeButton.innerHTML = closeIcon;
    closeButton.onclick = close;
    head.append(closeButton);
    box.append(el('div', 'toc-grip'), head, root);
    sheet.append(veil, box);
    veil.onclick = close;
    document.body.append(sheet);
    for (const node of [document.querySelector('body > main'), document.getElementById('sidebar')]) if (node) node.inert = true;
  }
  function closeSheet() {
    for (const node of [document.querySelector('body > main'), document.getElementById('sidebar')]) if (node) node.inert = false;
    sheet.remove();
    sheet = null;
    cleanup();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  narrow.addEventListener('change', () => { if (opened) close(); });
  document.addEventListener('keydown', (event) => {
    if (!sheet || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') {
      const items = [...sheet.querySelectorAll('button:not(:disabled),input')].filter((n) => n.getClientRects().length && n.tabIndex >= 0);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  // ---- 操作
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { query = input.value.trim(); search(); }, TYPING_WAIT);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(typing);
      if (input.value.trim() !== query) { query = input.value.trim(); search(); } else selectHit(hitIndex + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('.toc-row')?.focus(); }
  });
  prevHit.onclick = () => selectHit(hitIndex - 1);
  nextHit.onclick = () => selectHit(hitIndex + 1);
  clear.onclick = () => { input.value = ''; query = ''; search(); input.focus({ preventScroll: true }); };
  function setScope(key) { scope = key; search(); }
  scopeButtons.forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
  seg.addEventListener('keydown', (event) => {
    let k = scopeButtons.indexOf(document.activeElement);
    if (k < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') k = (k + 1) % scopeButtons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') k = (k + scopeButtons.length - 1) % scopeButtons.length;
    else if (event.key === 'Home') k = 0;
    else if (event.key === 'End') k = scopeButtons.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setScope(scopeButtons[k].dataset.scope);
    scopeButtons[k].focus();
  });
  sortButton.onclick = () => { newestFirst = !newestFirst; paintControls(); paintList(); list.scrollTop = 0; };
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.toc-row');
    if (row) go(entries[Number(row.dataset.id)]);
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll('.toc-row')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && i === 0) input.focus(); else rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  button.addEventListener('click', () => { if (opened) close(); else open(button); });

  // 会話が変わった（発言の増減・ターンの終わり）とき、開いていれば一覧を取り直す。閉じていれば次に開くときに作る
  let refreshTimer = 0;
  new MutationObserver((records) => {
    if (!records.some((r) => r.addedNodes.length || r.removedNodes.length)) return;
    entriesDirty = true;
    if (!opened) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { entriesDirty = true; search({ select: false }); }, 300);
  }).observe(thread, { childList: true });
  nav.onUpdate(() => {
    const has = nav.turns().length > 0;
    if (button.hidden === has) button.hidden = !has;
    if (opened) paintCurrent();
  });

  return {
    open, close, isOpen,
    toggle(source) { if (opened) close(); else open(source); },
    /** Ctrl+F: 開いていなければ開き、開いていれば検索欄へ（全選択） */
    focusSearch() { if (opened) { input.focus(); input.select(); } else open(button); },
    /** ターンの終わりなど、内容が変わった。開いていれば取り直す */
    refresh() { entriesDirty = true; if (opened) search({ select: false }); },
    /**
     * 脇の検索の結果から会話へ飛んだとき、探した語を引き継ぐ（パネルは開かない。ADR 0063 の D・docs/design-system.md「会話の移動」）。
     * 語は検索欄に入り、本文の一致に印を付け、飛んだ先の発言の一致を指す。Ctrl+F・目次のボタンで開けば、同じ語で残りの一致へ進める。
     * scope は対象の段（自分の発言だけを探したなら user、返答も当たるなら answer）。uuid は飛んだ先の発言
     */
    carry(word, { scope: next = 'answer', uuid = null } = {}) {
      const text = String(word ?? '').trim();
      if (!text) return;
      query = text;
      input.value = text;
      if (SCOPES.includes(next)) scope = next;
      carried = true;
      entriesDirty = true;
      search({ select: false });
      const entry = uuid ? entries.find((e) => e.el?.dataset?.uuid === uuid && e.hitStart >= 0) : null;
      if (entry) selectHit(entry.hitStart, { scroll: false });
    },
    /** 会話を替えた。検索語・対象・並び順を初期に戻す */
    reset() {
      if (opened) close();
      clearMarks();
      carried = false;
      query = ''; scope = 'user'; newestFirst = false; hitIndex = -1; total = 0; input.value = '';
      entries = []; entriesDirty = true;
    },
  };
}
