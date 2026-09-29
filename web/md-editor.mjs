// 入力欄の編集欄（ADR 0060）。contenteditable の 1 要素を、Markdown をその場で整える編集欄にする（外部のライブラリは使わない）。
//
// - 正本は Markdown の文字列。ソースの 1 行 = 1 つのブロック（div.md-b）。行の種類（見出し・箇条書き・引用・コード・添付）と
//   インラインの強調は DOM に描く。往復では文字が変わらない（web/md-doc.mjs）。
// - 文字を打つ・IME・選択・行の中の削除は、ブラウザーの編集にそのまま任せ、そのあとで DOM から文書を読み直す（DOM が正）。
//   行の分け・つなぎ・複数行の削除・貼り付け・元に戻す・添付の出し入れは、beforeinput で止めて文書モデルの操作にする。
// - 変換中（compositionstart〜end）は整形も構造の操作もしない（変換が終わってから読み直す）。
// - 元に戻す・やり直しは自前の履歴（記号のままの状態と整えた後を別々に積む）。ブラウザーの履歴は使わない。
// - textarea と同じ窓口（value・selectionStart / End・setSelectionRange・setRangeText・placeholder・disabled・readOnly・focus・input イベント）を
//   要素に生やす。呼び出し側（web/client.mjs・slash-skills.mjs・shell-composer.mjs・composer-wait.mjs）はほとんど変えずに済む。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { formatBytes } from './folder-upload.mjs';
import { attachmentHtml } from './user-message.mjs';
import { baseName } from './file-reference.mjs';
import {
  markdownToDoc, docToMarkdown, mergeRuns, runsText, runsLength, newMark, blockRaw, fenceRoles, normalizeFences, ensureShape, emptyBlock,
  caret, isCollapsed, orderSel, deleteSelection, insertText, enter, backspaceAtStart, deleteAtEnd, insertAtom, removeAtoms, newAtom,
  atomKey, atomKeys, normalizeAttachmentPath, pasteText, applyTriggers, toggleMark, marksInRange, selectionMarkdown, createHistory,
  posToOffset, offsetToPos, insertPlain,
} from './md-doc.mjs';

const KINDS = new Set(['p', 'h', 'ul', 'ol', 'quote', 'code', 'att']);

/**
 * @param {HTMLElement} root 編集欄にする要素（#prompt）
 * @param {object} o
 * @param {(path:string) => object|null} o.resolve 添付のパス → { path, name, kind, dataUri, from }（無ければ null）
 * @param {(pid:string) => object|null} [o.pending] 送っている途中の添付の仮の ID → { name, state: 'sending'|'failed', percent, error }
 * @param {() => string} [o.locale] 添付の印の言語（'ja' | 'en'）
 * @param {() => boolean} [o.isPlain] 整形も添付もしない平文の間か（シェルの形）
 * @param {(change:{added:Set<string>, removed:Set<string>}) => void} [o.onAtoms] 利用者の操作で添付の出入りがあった（キーは p:パス / i:仮の ID）
 * @param {(info:object, anchor:HTMLElement) => void} [o.onZoom] 画像の縮小を押した
 * @param {(info:object, anchor:HTMLElement) => void} [o.onOpenFile] ファイルの札を押した
 * @param {(action:string, key:string) => void} [o.onAtomAction] 送信中・失敗の札のボタン（cancel / retry / remove）
 */
export function createMarkdownEditor(root, o) {
  const opts = { pending: () => null, locale: () => 'ja', isPlain: () => false, onAtoms: () => {}, onZoom: () => {}, onOpenFile: () => {}, onAtomAction: () => {}, ...o };
  const resolve = (path) => opts.resolve(path);
  const plain = () => Boolean(opts.isPlain());
  const history = createHistory();
  const resolvedPids = new Map();
  let composing = false, synthetic = false, known = new Set(), lastSel = null, selAtom = null, bar = null;
  // 強調・コード・リンクを整えた直後の位置。打つ字はその外へ入れる（ブラウザーは要素の中の末尾へ入れてしまう）
  let outside = null, zwsp = null;

  // ------------------------------------------------------------ 属性
  root.setAttribute('contenteditable', 'true');
  root.setAttribute('role', 'textbox');
  root.setAttribute('aria-multiline', 'true');
  root.setAttribute('spellcheck', 'true');
  root.setAttribute('enterkeyhint', 'enter');
  root.classList.add('md-editor');

  // ------------------------------------------------------------ DOM を読む
  const nodeText = (n) => n.nodeValue.replace(/ /g, ' ');

  function markFor(n, type) {
    let id = Number(n.dataset.mid);
    if (!id) { const m = newMark(type); id = m.id; n.dataset.mid = String(id); }
    const d = n.dataset.d;
    return { id, t: type, ...(type === 'link' ? { url: n.dataset.url ?? n.getAttribute('href') ?? '' } : d ? { d } : {}) };
  }

  function walk(node, marks, out) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const text = nodeText(n); if (text) out.push({ text, marks }); continue; }
      if (n.nodeType !== 1 || n.tagName === 'BR') continue;
      const tag = n.tagName;
      const m = tag === 'STRONG' || tag === 'B' ? markFor(n, 'strong') : tag === 'EM' || tag === 'I' ? markFor(n, 'em')
        : tag === 'CODE' ? markFor(n, 'code') : tag === 'A' ? markFor(n, 'link') : null;
      walk(n, m ? [...marks, m] : marks, out);
    }
  }

  function readBlock(div) {
    const kind = KINDS.has(div.dataset.k) ? div.dataset.k : 'p';
    if (kind === 'att') {
      return { kind, marker: '', runs: [], raw: div.dataset.raw ?? '', ...(div.dataset.path ? { path: div.dataset.path } : {}), ...(div.dataset.pid ? { pid: div.dataset.pid } : {}) };
    }
    const runs = [];
    walk(div, [], runs);
    let merged = mergeRuns(runs);
    if (kind === 'code' || plain()) merged = mergeRuns(merged.map(r => ({ text: r.text, marks: [] })));
    const b = { kind, marker: div.dataset.m ?? '', runs: merged };
    if (div.dataset.pad !== undefined && !runsLength(merged)) b.pad = true;
    return b;
  }

  const blockDivs = () => [...root.children].filter(n => n.classList?.contains('md-b'));
  const readDoc = () => blockDivs().map(readBlock);

  /** ブラウザーの編集で block の外に出た字・空の欄を直す */
  function sanitize() {
    let stray = null;
    for (const n of [...root.childNodes]) {
      if (n.nodeType === 1 && n.classList.contains('md-b')) { stray = null; continue; }
      if (n.nodeType === 1 && n.tagName === 'BR') { n.remove(); continue; }
      if (!stray) { stray = renderBlock(emptyBlock(), 0, []); stray.replaceChildren(); root.insertBefore(stray, n); }
      stray.append(n);
    }
    if (!root.firstChild) root.append(renderBlock(emptyBlock(), 0, []));
    for (const div of blockDivs()) if (div.dataset.k !== 'att' && !div.firstChild) div.append(document.createElement('br'));
  }

  // ------------------------------------------------------------ 選択の対応
  const blockOf = (node) => { let n = node; while (n && n.parentNode !== root) n = n.parentNode; return n && n.parentNode === root ? n : null; };
  const textLen = (div) => { const r = document.createRange(); r.selectNodeContents(div); return r.toString().length; };

  function domToPos(node, off) {
    const divs = blockDivs();
    if (!divs.length) return null;
    if (node === root) {
      if (off >= divs.length) return { b: divs.length - 1, v: divs.at(-1).dataset.k === 'att' ? 0 : textLen(divs.at(-1)) };
      return { b: off, v: 0 };
    }
    const div = blockOf(node);
    const b = divs.indexOf(div);
    if (b < 0) return null;
    if (div.dataset.k === 'att') return { b, v: 0 };
    const r = document.createRange();
    r.setStart(div, 0);
    r.setEnd(node, off);
    return { b, v: r.toString().length };
  }

  function posToDom(pos, after = false) {
    const divs = blockDivs();
    const div = divs[Math.max(0, Math.min(pos.b, divs.length - 1))];
    if (!div) return [root, 0];
    if (div.dataset.k === 'att') { const next = divs[divs.indexOf(div) + 1]; return next ? [next, 0] : [div, 0]; }
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let acc = 0, n, lastEnd = null;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (pos.v < acc + len || (!after && pos.v === acc + len)) return [n, pos.v - acc];
      if (pos.v === acc + len) lastEnd = n;
      acc += len;
    }
    if (lastEnd) {
      // 強調の直後に置きたい（打った字は強調の外へ入る）。次の字の node が無ければ空の node を足す
      let top = lastEnd;
      while (top.parentNode !== div) top = top.parentNode;
      if (top !== lastEnd) { const empty = document.createTextNode(''); top.after(empty); return [empty, 0]; }
      return [lastEnd, lastEnd.nodeValue.length];
    }
    return [div, div.querySelector('br') ? 0 : div.childNodes.length];
  }

  function getSel() {
    const s = getSelection();
    if (!s?.rangeCount || !root.contains(s.anchorNode)) return null;
    const a = domToPos(s.anchorNode, s.anchorOffset), f = domToPos(s.focusNode, s.focusOffset);
    return a && f ? orderSel(a, f) : null;
  }

  const hasFocus = () => document.activeElement === root;

  function setDomSel(sel, after) {
    const [sn, so] = posToDom(sel.s, false);
    const [en, eo] = isCollapsed(sel) ? [sn, so] : posToDom(sel.e, false);
    if (isCollapsed(sel) && after) { const [an, ao] = posToDom(sel.s, true); getSelection().setBaseAndExtent(an, ao, an, ao); return; }
    getSelection().setBaseAndExtent(sn, so, en, eo);
  }

  const endSel = (blocks) => { const b = blocks.length - 1; return caret(b, blocks[b].kind === 'att' ? 0 : runsLength(blocks[b].runs)); };

  const getState = () => {
    const blocks = readDoc();
    const sel = getSel() ?? (lastSel && lastSel.s.b < blocks.length ? lastSel : endSel(blocks));
    return { blocks, sel };
  };

  // ------------------------------------------------------------ DOM に描く
  function appendRuns(div, runs) {
    let stack = [];   // { mark, node }
    let parent = div;
    for (const r of runs) {
      let p = 0;
      while (p < stack.length && p < r.marks.length && stack[p].mark.id === r.marks[p].id) p++;
      stack = stack.slice(0, p);
      parent = p ? stack[p - 1].node : div;
      for (let k = p; k < r.marks.length; k++) {
        const m = r.marks[k];
        const node = document.createElement(m.t === 'strong' ? 'strong' : m.t === 'em' ? 'em' : m.t === 'code' ? 'code' : 'a');
        node.dataset.mid = String(m.id);
        if (m.d) node.dataset.d = m.d;
        if (m.t === 'link') { node.dataset.url = m.url ?? ''; node.className = 'md-link'; node.title = m.url ?? ''; }
        parent.append(node);
        stack.push({ mark: m, node });
        parent = node;
      }
      parent.append(document.createTextNode(r.text));
    }
  }

  function indentOf(marker) {
    const ws = /^[ \t]*/.exec(marker)[0];
    return Math.min(4, Math.floor(ws.replace(/\t/g, '    ').length / 2));
  }

  function atomInfo(b) {
    if (b.path) {
      const info = resolve(b.path);
      return info ?? { path: b.path, name: baseName(b.path), kind: 'file' };
    }
    const p = resolvedPids.get(b.pid);
    if (p) { const info = resolve(p); if (info) return info; }
    return null;
  }

  function fillAtom(div, b) {
    div.replaceChildren();
    div.dataset.state = 'ok';
    const info = atomInfo(b);
    if (info) {
      div.innerHTML = attachmentHtml({ kind: info.kind === 'image' ? 'image' : 'file', path: info.path, dataUri: info.path ? undefined : info.dataUri, captionParams: { name: info.name } });
      div.querySelector('img')?.setAttribute('draggable', 'false');
      const body = div.querySelector('.msg-att');
      body?.classList.add('md-att-body');
      // 出どころは札に触れたときの説明に。同じ名前の札にだけ、見分けの付くフォルダーを添える（web/composer-layout.mjs の attachFolderHints）
      if (body && (info.from === 'host' || info.from === 'device')) body.title = info.from === 'host' ? t('chat.attach.fromHost', { path: info.path }) : t('chat.attach.fromDevice', { name: info.name });
      if (info.hint) div.querySelector('figcaption, a')?.append(el('span', 'md-att-dir', info.hint));
      return;
    }
    const pend = opts.pending(b.pid) ?? { name: '', state: 'failed', error: t('chat.composerAtt.cancelled') };
    div.dataset.state = pend.state === 'sending' ? 'sending' : 'failed';
    const box = el('div', 'md-att-up');
    if (pend.state === 'sending') box.title = t('chat.attach.sendingTitle', { name: pend.name, size: formatBytes(pend.size ?? 0) });
    box.append(el('span', 'md-att-up-name', pend.name));
    if (pend.state === 'sending') {
      const pct = el('span', 'md-att-up-pct', t('chat.attach.sending', { percent: pend.percent ?? 0 }));
      pct.setAttribute('role', 'status');
      const bar = el('span', 'md-att-up-bar');
      bar.style.setProperty('--p', `${pend.percent ?? 0}%`);
      box.append(pct, bar, actionButton('cancel', t('chat.attach.cancelSending')));
    } else {
      box.append(el('span', 'md-att-up-err', t('chat.composerAtt.failed', { error: pend.error ?? '' })), actionButton('retry', t('chat.composerAtt.retry')), actionButton('remove', t('chat.attach.remove')));
    }
    div.append(box);
  }

  function actionButton(act, label) {
    const b = el('button', 'btn btn-quiet md-att-act', label);
    b.type = 'button';
    b.dataset.act = act;
    return b;
  }

  function renderBlock(b, i, roles) {
    const div = document.createElement('div');
    div.className = `md-b md-${b.kind}`;
    div.dataset.k = b.kind;
    if (b.marker) div.dataset.m = b.marker;
    if (b.pad) div.dataset.pad = '';
    if (b.kind === 'att') {
      div.contentEditable = 'false';
      div.dataset.raw = b.raw ?? '';
      if (b.path) div.dataset.path = b.path;
      if (b.pid) div.dataset.pid = b.pid;
      fillAtom(div, b);
      return div;
    }
    if (b.kind === 'h') div.dataset.l = String(Math.min(4, /#+/.exec(b.marker)?.[0].length ?? 1));
    if (b.kind === 'ul') div.dataset.mk = '•';
    if (b.kind === 'ol') div.dataset.mk = b.marker.trim();
    if (b.kind === 'ul' || b.kind === 'ol') div.style.setProperty('--ind', String(indentOf(b.marker)));
    if (b.kind === 'quote') div.style.setProperty('--q', String((b.marker.match(/>/g) ?? []).length));
    if (b.kind === 'code') {
      div.spellcheck = false;
      const role = roles[i], nextRole = roles[i + 1];
      div.dataset.pos = `${role === 'open' ? 'top' : ''}${!nextRole || nextRole === 'open' || role === 'close' ? 'bottom' : ''}` || 'mid';
    }
    if (b.runs.length) appendRuns(div, b.runs); else div.append(document.createElement('br'));
    return div;
  }

  const keyOf = (b, i, roles) => (b.kind === 'att'
    ? `att|${b.raw}|${b.path ?? ''}|${b.pid ?? ''}|${b.path ? '' : opts.pending(b.pid)?.state ?? (resolvedPids.has(b.pid) ? 'r' : 'x')}`
    : `${b.kind}|${b.marker}|${b.pad ? 1 : 0}|${b.kind === 'code' ? roles[i] ?? '' : ''}${b.kind === 'code' ? roles[i + 1] ?? '' : ''}|${JSON.stringify(b.runs.map(r => [r.text, r.marks.map(m => [m.id, m.t, m.d, m.url])]))}`);

  /**
   * 文書に合わせて DOM を作り直す。頭と尻で同じ行はそのまま残す（添付の画像を読み直さない）。
   * 同じかどうかは、いまの DOM を読んだ中身で比べる（打った字は DOM にだけあるので、描いたときの印は当てにならない）
   */
  function paint(blocks, { force = false } = {}) {
    const roles = fenceRoles(blocks.map(blockRaw));
    const keys = blocks.map((b, i) => keyOf(b, i, roles));
    const old = blockDivs();
    const oldBlocks = old.map(readBlock);
    const oldRoles = fenceRoles(oldBlocks.map(blockRaw));
    const oldKeys = force ? [] : oldBlocks.map((b, i) => keyOf(b, i, oldRoles));
    let head = 0;
    while (head < old.length && head < blocks.length && oldKeys[head] === keys[head]) head++;
    let tail = 0;
    while (tail < old.length - head && tail < blocks.length - head && oldKeys.at(-1 - tail) === keys.at(-1 - tail)) tail++;
    const fresh = [];
    for (let i = head; i < blocks.length - tail; i++) fresh.push(renderBlock(blocks[i], i, roles));
    const after = tail ? old.at(-tail) : null;
    for (let i = head; i < old.length - tail; i++) old[i].remove();
    for (const d of fresh) root.insertBefore(d, after);
    syncEmpty();
  }

  function syncEmpty() {
    const divs = blockDivs();
    const empty = divs.length === 1 && divs[0].dataset.k === 'p' && !textLen(divs[0]);
    root.dataset.empty = String(empty);
  }

  // ------------------------------------------------------------ 状態の反映
  function report() {
    const next = atomKeys(readDoc());
    const added = new Set([...next].filter(k => !known.has(k))), removed = new Set([...known].filter(k => !next.has(k)));
    known = next;
    if (added.size || removed.size) opts.onAtoms({ added, removed });
  }

  function fire() {
    synthetic = true;
    try { root.dispatchEvent(new Event('input', { bubbles: true })); } finally { synthetic = false; }
  }

  function clearAtomSel() {
    if (selAtom === null) return;
    selAtom = null;
    for (const n of root.querySelectorAll('.md-att.sel')) n.classList.remove('sel');
    root.classList.remove('md-atom-sel');
  }

  /** 文書を反映する。reason は履歴の分け方（'type' 以外はまとめない）。native: false なら input イベントを自分で出す */
  function apply(next, reason = 'edit', { silent = false } = {}) {
    clearAtomSel();
    fixPids(next.blocks);
    paint(next.blocks);
    if (hasFocus()) { setDomSel(next.sel, next.sel.after); reveal(next.sel); } else lastSel = next.sel;
    history.push(next, reason);
    report();
    if (!silent) fire();
  }

  /** 欄の中でキャレットの行が見えるところまでスクロールする（プログラムから動かしたキャレットはブラウザーが追わない） */
  function reveal(sel) {
    blockDivs()[Math.min(sel.s.b, root.children.length - 1)]?.scrollIntoView?.({ block: 'nearest' });
  }

  function fixPids(blocks) {
    for (const b of blocks) if (b.kind === 'att' && !b.path && resolvedPids.has(b.pid)) { b.path = resolvedPids.get(b.pid); b.raw = newAtom({ path: b.path, locale: opts.locale() }).raw; delete b.pid; }
  }

  // ------------------------------------------------------------ ブラウザーの編集のあと
  function syncFromDom(ch) {
    sanitize();
    let st = getState();
    if (ch && !plain()) {
      const trig = applyTriggers(st, ch);
      if (trig) {
        history.push(st, 'type');
        st = trig.state;
        normalizeFences(st.blocks, { resolve });
        fixPids(st.blocks);
        paint(st.blocks);
        setDomSel(st.sel, st.sel.after);
        outside = st.sel.after ? { b: st.sel.s.b, v: st.sel.s.v } : null;
        history.push(st, 'format');
        report();
        syncEmpty();
        return;
      }
    }
    outside = null;
    if (normalizeFences(st.blocks, { resolve, plain: plain() })) { paint(st.blocks); if (hasFocus()) setDomSel(st.sel); }
    history.push(st, 'type');
    syncEmpty();
    report();
  }

  // ------------------------------------------------------------ イベント
  const isOutside = (sel) => outside && sel && isCollapsed(sel) && sel.s.b === outside.b && sel.s.v === outside.v;
  root.addEventListener('compositionstart', () => {
    // 整えた直後の位置で変換を始めるときは、要素の外に立たせるために、見えない字（変換の後で取り除く）を置いて始める
    if (isOutside(getSel())) {
      const s = getSelection(), node = s.anchorNode, block = blockOf(node);
      let top = node;
      while (top && top.parentNode !== block) top = top.parentNode;
      if (top) {
        if (top.nodeType === 3 && !top.nodeValue) { top.nodeValue = '\u200b'; zwsp = top; }
        else { zwsp = document.createTextNode('\u200b'); top.after(zwsp); }
        s.setBaseAndExtent(zwsp, 1, zwsp, 1);
      }
    }
    outside = null;
    composing = true;
  });
  root.addEventListener('compositionend', () => {
    // Safari は compositionend のあとに最後の input が来る。読み直しはその後にする
    setTimeout(() => {
      composing = false;
      if (zwsp) {
        const s = getSelection();
        const at = s.anchorNode === zwsp ? s.anchorOffset : null;
        const removed = zwsp.nodeValue.slice(0, at ?? undefined).split('\u200b').length - 1;
        zwsp.nodeValue = zwsp.nodeValue.replace(/\u200b/g, '');
        if (at !== null) s.setBaseAndExtent(zwsp, Math.max(0, at - removed), zwsp, Math.max(0, at - removed));
        zwsp = null;
      }
      syncFromDom(null);
    }, 0);
  });

  const singleBlockRange = (sel) => sel.s.b === sel.e.b && blockDivs()[sel.s.b]?.dataset.k !== 'att';

  root.addEventListener('beforeinput', (e) => {
    if (composing || e.isComposing) return;
    const type = e.inputType;
    if (root.getAttribute('contenteditable') !== 'true') return;
    const st = () => getState();
    const done = (next, reason) => { e.preventDefault(); apply(next, reason); };
    if (type === 'insertParagraph' || type === 'insertLineBreak') return done(enter(st(), { plain: plain() || type === 'insertLineBreak' }), 'enter');
    if (type === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (type === 'historyRedo') { e.preventDefault(); redo(); return; }
    if (type.startsWith('format')) { e.preventDefault(); return; }
    if (type === 'insertText' || type === 'insertReplacementText') {
      const s = st();
      const data = e.data ?? '';
      if (data.includes('\n')) return done(pasteText(s, data, { plain: plain(), resolve }), 'paste');
      if (isOutside(s.sel) && data) { outside = null; return done(insertPlain(s, data), 'type'); }
      if (!isCollapsed(s.sel) && !singleBlockRange(s.sel)) return done(insertText(s, data), 'type');
      return;   // 打った字はブラウザーに任せる（input で読み直し、整形を見る）
    }
    if (type === 'insertFromDrop' || type === 'insertFromYank' || type === 'insertLink') {
      e.preventDefault();
      const text = e.dataTransfer?.getData('text/plain');
      if (type === 'insertFromDrop' && text) {
        let s = st();
        const r = e.getTargetRanges?.()[0];
        if (r) { const p = domToPos(r.startContainer, r.startOffset); if (p) s = { blocks: s.blocks, sel: caret(p.b, p.v) }; }
        apply(pasteText(s, text, { plain: plain(), resolve }), 'paste');
      }
      return;
    }
    if (type.startsWith('deleteContent') || type.startsWith('deleteWord') || type.startsWith('deleteSoft') || type.startsWith('deleteHard') || type === 'deleteByDrag' || type === 'deleteByCut') {
      const s = st();
      if (!isCollapsed(s.sel)) { if (!singleBlockRange(s.sel)) done(deleteSelection(s), 'delete'); return; }
      const backward = /Backward$/.test(type);
      const forward = /Forward$/.test(type);
      const blk = s.blocks[s.sel.s.b];
      if (backward && s.sel.s.v === 0) return done(backspaceAtStart(s), 'delete');
      if (forward && s.sel.s.v >= (blk.kind === 'att' ? 0 : runsLength(blk.runs))) return done(deleteAtEnd(s), 'delete');
    }
  });

  root.addEventListener('input', (e) => {
    if (synthetic) return;
    if (composing || e.isComposing) { syncEmpty(); return; }
    const ch = e.inputType === 'insertText' && typeof e.data === 'string' && e.data.length === 1 ? e.data : null;
    syncFromDom(ch);
  });

  const undo = () => { const s = history.undo(); if (s) restore(s); };
  const redo = () => { const s = history.redo(); if (s) restore(s); };
  function restore(s) {
    clearAtomSel();
    fixPids(s.blocks);
    paint(s.blocks);
    if (hasFocus()) { setDomSel(s.sel); reveal(s.sel); } else lastSel = s.sel;
    history.touch(s.sel);
    report();
    fire();
  }

  root.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (selAtom !== null) { atomKeydown(e); return; }
    // 添付のすぐ隣で矢印を押したら、添付を選ぶ（文字は入れられないので、先に外す・間に行を足す）
    if (e.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const sel = getSel();
    if (!sel || !isCollapsed(sel)) return;
    const divs = blockDivs();
    const cur = divs[sel.s.b];
    if (!cur || cur.dataset.k === 'att') return;
    const len = textLen(cur);
    const back = e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && sel.s.v === 0);
    const fwd = e.key === 'ArrowDown' || (e.key === 'ArrowRight' && sel.s.v >= len);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && back && sel.s.v === 0 && divs[sel.s.b - 1]?.dataset.k === 'att') { e.preventDefault(); selectAtom(sel.s.b - 1); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && fwd && sel.s.v >= len && divs[sel.s.b + 1]?.dataset.k === 'att') { e.preventDefault(); selectAtom(sel.s.b + 1); }
  });

  // ------------------------------------------------------------ 添付を選んでいる間のキー
  function selectAtom(i) {
    clearAtomSel();
    const div = blockDivs()[i];
    if (!div) return;
    selAtom = i;
    div.classList.add('sel');
    root.classList.add('md-atom-sel');
    div.scrollIntoView?.({ block: 'nearest' });
  }

  function atomKeydown(e) {
    const s = getState();
    const i = selAtom;
    const divs = blockDivs();
    const key = atomKey(s.blocks[i]);
    const caretAt = (b, v) => { clearAtomSel(); setDomSel(caret(b, v)); };
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); apply(removeAtoms({ ...s, sel: caret(i, 0) }, (b) => atomKey(b) === key), 'delete'); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = { blocks: s.blocks.slice(), sel: caret(i + 1, 0) };
      next.blocks.splice(i + 1, 0, emptyBlock());
      apply(next, 'enter');
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (divs[i - 1]?.dataset.k === 'att') selectAtom(i - 1);
      else if (i > 0) caretAt(i - 1, textLen(divs[i - 1]));
      else caretAt(Math.min(1, divs.length - 1), 0);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (divs[i + 1]?.dataset.k === 'att') selectAtom(i + 1); else caretAt(Math.min(i + 1, divs.length - 1), 0);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); caretAt(Math.min(i + 1, divs.length - 1), 0); return; }
    if (e.key === 'Tab' || e.key.length !== 1) { clearAtomSel(); return; }
    // 文字を打った: 添付の次に行を足して入れる
    e.preventDefault();
    const next = { blocks: s.blocks.slice(), sel: caret(i + 1, 0) };
    next.blocks.splice(i + 1, 0, emptyBlock());
    apply(insertText(next, e.key), 'type');
  }

  root.addEventListener('pointerdown', (e) => {
    const att = e.target.closest?.('.md-att');
    if (att && !e.target.closest('button, a')) { e.preventDefault(); root.focus(); selectAtom(blockDivs().indexOf(att)); return; }
    clearAtomSel();
  });
  root.addEventListener('blur', () => { clearAtomSel(); hideBar(); });

  // ------------------------------------------------------------ コピー・切り取り・貼り付け
  root.addEventListener('copy', (e) => {
    const s = getState();
    if (isCollapsed(s.sel)) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionMarkdown(s));
  });
  root.addEventListener('cut', (e) => {
    const s = getState();
    if (isCollapsed(s.sel)) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionMarkdown(s));
    apply(deleteSelection(s), 'delete');
  });
  root.addEventListener('paste', (e) => {
    // ファイル（画像）は client.mjs の paste が添付にする
    if (e.clipboardData?.files?.length) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    apply(pasteText(getState(), text, { plain: plain(), resolve }), 'paste');
  });

  // ------------------------------------------------------------ 添付のボタン
  root.addEventListener('click', (e) => {
    const div = e.target.closest?.('.md-att');
    if (!div) return;
    const act = e.target.closest('[data-act]');
    const key = div.dataset.path ? `p:${normalizeAttachmentPath(div.dataset.path)}` : `i:${div.dataset.pid}`;
    if (act) { e.preventDefault(); opts.onAtomAction(act.dataset.act, key, div); return; }
    const info = div.dataset.path ? (resolve(div.dataset.path) ?? { path: div.dataset.path, name: baseName(div.dataset.path), kind: 'file' }) : null;
    if (!info) return;
    const zoom = e.target.closest('.msg-att-zoom');
    if (zoom) { e.preventDefault(); e.stopPropagation(); opts.onZoom(info, zoom); return; }
    if (e.target.closest('a')) { e.preventDefault(); e.stopPropagation(); opts.onOpenFile(info, e.target.closest('a')); }
  });

  // ------------------------------------------------------------ 選択の追跡と書式バー
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (!s?.rangeCount || !root.contains(s.anchorNode)) { hideBar(); return; }
    const sel = getSel();
    if (sel) lastSel = sel;
    if (selAtom !== null && !root.classList.contains('md-atom-sel')) clearAtomSel();
    requestAnimationFrame(updateBar);
  });

  function hideBar() { if (bar) bar.hidden = true; }

  function ensureBar() {
    if (bar) return bar;
    bar = el('div', 'md-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('chat.composerFormat.label'));
    bar.hidden = true;
    bar.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
    // i18n-dynamic: chat.composerFormat.
    for (const [type, label, cls] of [['strong', 'B', 'b'], ['em', 'I', 'i'], ['code', '</>', 'c'], ['link', t('chat.composerFormat.link'), 'l']]) {
      const b = el('button', `md-bar-btn md-bar-${cls}`, label);
      b.type = 'button';
      b.dataset.mark = type;
      b.setAttribute('aria-label', t(`chat.composerFormat.${type}`));
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => (type === 'link' ? askLink() : apply(toggleMark(getState(), type), 'format'));
      bar.append(b);
    }
    (root.parentElement ?? document.body).append(bar);
    return bar;
  }

  let linkSel = null;
  function askLink() {
    const s = getState();
    if (marksInRange(s).has('link')) { apply(toggleMark(s, 'link'), 'format'); return; }
    linkSel = s.sel;
    const box = ensureBar();
    const input = el('input', 'md-bar-input');
    input.type = 'url';
    input.placeholder = 'https://';
    input.setAttribute('aria-label', t('chat.composerFormat.url'));
    const back = () => { input.remove(); for (const b of box.querySelectorAll('.md-bar-btn')) b.hidden = false; };
    const commit = () => {
      const url = input.value.trim();
      back();
      root.focus();
      if (!url || !linkSel) return;
      apply(toggleMark({ ...getState(), sel: linkSel }, 'link', { url }), 'format');
    };
    input.onkeydown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); root.focus(); }
    };
    for (const b of box.querySelectorAll('.md-bar-btn')) b.hidden = true;
    box.append(input);
    input.focus();
  }

  function updateBar() {
    if (plain() || composing || !hasFocus()) { if (!bar?.querySelector('.md-bar-input')) hideBar(); return; }
    const sel = getSel();
    const divs = blockDivs();
    const ok = sel && !isCollapsed(sel) && sel.s.b === sel.e.b && !['att', 'code'].includes(divs[sel.s.b]?.dataset.k);
    if (!ok) { if (!bar?.querySelector('.md-bar-input')) hideBar(); return; }
    const box = ensureBar();
    if (box.querySelector('.md-bar-input')) return;
    const range = getSelection().getRangeAt(0).getBoundingClientRect();
    if (!range.width && !range.height) { hideBar(); return; }
    const state = { blocks: readDoc(), sel };
    const on = marksInRange(state);
    for (const b of box.querySelectorAll('.md-bar-btn')) b.setAttribute('aria-pressed', String(on.has(b.dataset.mark)));
    box.hidden = false;
    const host = (root.parentElement ?? document.body).getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(4, Math.min(range.left - host.left + range.width / 2 - w / 2, host.width - w - 4));
    box.style.left = `${left}px`;
    box.style.top = `${range.top - host.top - h - 6}px`;
  }

  // ------------------------------------------------------------ textarea と同じ窓口
  function setValue(md) {
    const blocks = markdownToDoc(String(md ?? ''), { resolve, plain: plain() });
    paint(blocks);
    const sel = endSel(blocks);
    lastSel = sel;
    if (hasFocus()) setDomSel(sel);
    history.reset({ blocks, sel });
    known = atomKeys(blocks);
    clearAtomSel();
    syncEmpty();
  }

  function offsets() {
    const blocks = readDoc();
    const sel = getSel() ?? lastSel ?? endSel(blocks);
    return { start: posToOffset(blocks, sel.s), end: posToOffset(blocks, sel.e) };
  }

  function setRange(a, b) {
    const blocks = readDoc();
    const sel = orderSel(offsetToPos(blocks, a), offsetToPos(blocks, b));
    lastSel = sel;
    if (hasFocus()) setDomSel(sel);
  }

  Object.defineProperties(root, {
    value: { configurable: true, get: () => docToMarkdown(readDoc()), set: setValue },
    selectionStart: { configurable: true, get: () => offsets().start, set: (n) => setRange(n, Math.max(n, offsets().end)) },
    selectionEnd: { configurable: true, get: () => offsets().end, set: (n) => setRange(Math.min(n, offsets().start), n) },
    placeholder: {
      configurable: true, get: () => root.getAttribute('placeholder') ?? '',
      set: (v) => { root.setAttribute('placeholder', v); root.setAttribute('aria-label', v); },
    },
    readOnly: {
      configurable: true, get: () => root.getAttribute('aria-readonly') === 'true',
      set: (v) => { if (v) root.setAttribute('aria-readonly', 'true'); else root.removeAttribute('aria-readonly'); syncEditable(); },
    },
    disabled: {
      configurable: true, get: () => root.getAttribute('aria-disabled') === 'true',
      set: (v) => { if (v) root.setAttribute('aria-disabled', 'true'); else root.removeAttribute('aria-disabled'); syncEditable(); },
    },
  });
  function syncEditable() {
    root.setAttribute('contenteditable', root.readOnly || root.disabled ? 'false' : 'true');
    root.tabIndex = root.disabled ? -1 : 0;
  }
  root.setSelectionRange = (a, b) => setRange(a, b);
  root.setRangeText = (text, start = offsets().start, end = offsets().end) => {
    const s = getState();
    const p1 = offsetToPos(s.blocks, start), p2 = offsetToPos(s.blocks, end);
    if (p1.b === p2.b) { apply(insertText({ blocks: s.blocks, sel: orderSel(p1, p2) }, text), 'edit', { silent: true }); return; }
    const md = docToMarkdown(s.blocks);
    setValue(md.slice(0, start) + text + md.slice(end));
    setRange(start + text.length, start + text.length);
  };
  root.setAttribute('placeholder', root.getAttribute('placeholder') ?? '');

  // ------------------------------------------------------------ 外から使う窓口
  const editor = {
    getState,
    /** 打ち込み中の位置が、コードブロック・インラインコードの中か（スキル候補を出さない） */
    inCode() {
      const sel = getSel();
      if (!sel) return false;
      const div = blockDivs()[sel.s.b];
      if (div?.dataset.k === 'code') return true;
      const s = getSelection();
      const n = s?.anchorNode?.nodeType === 1 ? s.anchorNode : s?.anchorNode?.parentElement;
      return Boolean(n?.closest?.('code'));
    },
    /** 添付の位置の記憶（クリップを開く前の位置） */
    rememberCaret() { return lastSel ? structuredClone(lastSel) : null; },
    /** 座標から位置（ドロップ） */
    posFromPoint(x, y) {
      const r = document.caretRangeFromPoint?.(x, y);
      const cp = !r && document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
      const node = r?.startContainer ?? cp?.offsetNode, off = r?.startOffset ?? cp?.offset;
      if (!node || !root.contains(node)) return null;
      const p = domToPos(node, off);
      return p ? caret(p.b, p.v) : null;
    },
    /** 添付を入れる。'inserted' | 'duplicate' | 'unavailable'（平文の間・書けない間） */
    insertAttachment({ path, pid }, { at = null } = {}) {
      if (plain() || root.disabled || root.readOnly) return 'unavailable';
      const s = getState();
      if (path && atomKeys(s.blocks).has(`p:${normalizeAttachmentPath(path)}`)) return 'duplicate';
      const sel = at && at.s.b < s.blocks.length ? at : (hasFocus() ? s.sel : lastSel && lastSel.s.b < s.blocks.length ? lastSel : endSel(s.blocks));
      const start = { blocks: s.blocks, sel: caret(sel.s.b, Math.min(sel.s.v, s.blocks[sel.s.b].kind === 'att' ? 0 : runsLength(s.blocks[sel.s.b].runs))) };
      apply(insertAtom(start, newAtom({ path, pid, locale: opts.locale() })), 'attach');
      return 'inserted';
    },
    /** 送っている途中の添付が届いた。仮の ID をパスに替える（履歴には積まない） */
    resolvePending(pid, path) {
      resolvedPids.set(pid, path);
      const blocks = readDoc();
      if (!blocks.some(b => b.pid === pid)) return false;
      fixPids(blocks);
      paint(blocks);
      history.touch(getSel() ?? lastSel ?? endSel(blocks));
      known = atomKeys(blocks);
      fire();
      return true;
    },
    /** 送っている途中の添付の進み具合・失敗を描き直す */
    updatePending(pid) {
      const div = root.querySelector(`.md-att[data-pid="${CSS.escape(String(pid))}"]`);
      if (!div) return;
      const p = opts.pending(pid);
      const same = div.dataset.state === (p?.state === 'sending' ? 'sending' : p ? 'failed' : 'failed');
      if (same && p?.state === 'sending') {
        const pct = p.percent ?? 0;
        const label = div.querySelector('.md-att-up-pct'), bar = div.querySelector('.md-att-up-bar');
        if (label) label.textContent = t('chat.attach.sending', { percent: pct });
        bar?.style.setProperty('--p', `${pct}%`);
        return;
      }
      const blocks = readDoc();
      const i = blockDivs().indexOf(div);
      if (i < 0) return;
      div.replaceWith(renderBlock(blocks[i], i, []));
    },
    /** 添付を外す（キーは p:パス / i:仮の ID）。外したら true */
    removeAttachment(key) {
      const s = getState();
      if (!atomKeys(s.blocks).has(key)) return false;
      apply(removeAtoms(s, (b) => atomKey(b) === key), 'delete');
      return true;
    },
    hasAttachment(key) { return atomKeys(readDoc()).has(key); },
    attachmentKeys() { return atomKeys(readDoc()); },
    /** 添付の位置へ移動（見える所へ寄せ、短く強調） */
    reveal(key) {
      const div = blockDivs().find(d => d.dataset.k === 'att' && (d.dataset.path ? `p:${normalizeAttachmentPath(d.dataset.path)}` : `i:${d.dataset.pid}`) === key);
      if (!div) return false;
      div.scrollIntoView?.({ block: 'nearest' });
      div.classList.add('jump');
      setTimeout(() => div.classList.remove('jump'), 1600);
      const i = blockDivs().indexOf(div);
      root.focus({ preventScroll: true });
      const b = Math.min(i + 1, blockDivs().length - 1);
      setDomSel(caret(b, 0));
      return true;
    },
    /** 末尾に Markdown の文字を足す（入力欄へ写す。記法は整える）。input イベントは出さない（呼び出し側が出す） */
    append(text) {
      const s = getState();
      apply(pasteText({ blocks: s.blocks, sel: endSel(s.blocks) }, text, { plain: plain(), resolve }), 'paste', { silent: true });
    },
    /** 整形の内部の文字列（テスト・診断用）: いまの文書の Markdown */
    markdown: () => docToMarkdown(readDoc()),
    undo, redo,
    /** 平文の形が変わった（シェルの形に入った・出た）。書式は読み直さず、次の入力から効く */
    modeChanged() { hideBar(); syncEmpty(); },
    /** 添付の印の言語が変わった・添付の情報が変わった。札を描き直す */
    refresh() { paint(getState().blocks, { force: true }); },
  };
  root.editor = editor;

  // ------------------------------------------------------------ 初期化
  sanitize();
  root.replaceChildren();
  paint([emptyBlock()]);
  history.reset(getState());
  syncEmpty();
  return editor;
}

export { markdownToDoc, docToMarkdown, ensureShape };
