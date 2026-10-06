// 入力欄の Markdown 文書モデル（DOM を触らない。ADR 0060）。
//
// 入力欄（web/md-editor.mjs）は「ソースの 1 行 = 1 ブロック」の編集欄。正本は Markdown の文字列で、この文書モデルとの往復では
// 文字が 1 つも変わらない（docToMarkdown(markdownToDoc(s)) === s）。往復を保つため、ブロックの記号（`## `・`- `・`> `）と、
// インラインの区切り（`**`・`_`・`` ` ``・URL）は捨てずにモデルが持つ。読み取れない構造（表・HTML・入れ子の引用の中身など）は
// 平文の行のまま残す。
//
// ブロック: { kind, marker, runs, raw?, path?, pid?, pad? }
//   kind   'p' | 'h' | 'ul' | 'ol' | 'quote' | 'code' | 'att'
//   marker 行頭の記号（`## `・`  - `・`3. `・`> `）。p・code は ''
//   runs   インラインの並び [{ text, marks: [{ id, t: 'strong'|'em'|'code'|'link', d?, url? }] }]。code の行は印の無い 1 つの run
//   att    添付の 1 行（原子）。raw は送る 1 行（`[添付] パス`）、path は解決済みのパス、pid は送っている途中の仮の ID
//   pad    添付の前後・閉じたコードブロックの後ろに、キャレットを置くために足した空行。空のうちは Markdown に出さない
// 位置: { b: ブロックの添字, v: ブロックの見える文字の中の位置 }（記号・区切りは数えない）。選択は { s, e }（s ≤ e）
//
// 操作はどれも状態 { blocks, sel } を受けて新しい状態を返す（元は変えない）。DOM との結び付けは md-editor.mjs。
import { codeFenceMask } from './render.mjs';
import { ATTACHMENT_LINE, ATTACHMENT_MARKS, attachmentLine, normalizeAttachmentPath } from './timeline.mjs';

export { attachmentLine, normalizeAttachmentPath };

let markSeq = 0;
export const newMark = (t, props = {}) => ({ id: ++markSeq, t, ...props });
const sameMark = (a, b) => a.id === b.id;
const sameMarks = (a, b) => a.length === b.length && a.every((m, i) => sameMark(m, b[i]));
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i].id === b[i].id) i++; return i; };
const clone = (x) => structuredClone(x);

// ------------------------------------------------------------------ runs
export const runsText = (runs) => runs.map(r => r.text).join('');
export const runsLength = (runs) => runs.reduce((n, r) => n + r.text.length, 0);

/** 隣り合って同じ印を持つ run をまとめる（空の run は捨てる） */
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, r.marks)) last.text += r.text;
    else out.push({ text: r.text, marks: r.marks });
  }
  return out;
}

/** 見える文字の [a, b) を切り出す */
export function sliceRuns(runs, a, b = Infinity) {
  const out = [];
  let at = 0;
  for (const r of runs) {
    const from = Math.max(a - at, 0), to = Math.min(b - at, r.text.length);
    if (to > from) out.push({ text: r.text.slice(from, to), marks: r.marks });
    at += r.text.length;
    if (at >= b) break;
  }
  return out;
}

const plainRun = (text) => (text ? [{ text, marks: [] }] : []);

// ------------------------------------------------------------------ インラインの読み取り
const WORD = /[\p{L}\p{N}]/u;
const PUNCT = /[\\`*_{}\[\]()#+\-.!>~|<]/;

function findCodeClose(s, from, n) {
  let k = from;
  while (k < s.length) {
    if (s[k] !== '`') { k++; continue; }
    let e = k;
    while (s[e] === '`') e++;
    if (e - k === n) return k;
    k = e;
  }
  return -1;
}

/** 太字・斜体の閉じの区切りを探す。コードスパンの中とエスケープは飛ばす。斜体（1 字）は連続 1 つだけ、太字（2 字）は 2 つ以上の連続の頭 */
function findEmphasisClose(s, from, d) {
  const c = d[0], n = d.length;
  let k = from;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '`') {
      let e = k;
      while (s[e] === '`') e++;
      const close = findCodeClose(s, e, e - k);
      k = close >= 0 ? close + (e - k) : e;
      continue;
    }
    if (ch === c) {
      let e = k;
      while (s[e] === c) e++;
      const run = e - k;
      if (n === 1 ? run === 1 : run >= 2) return k;
      k = e;
      continue;
    }
    k++;
  }
  return -1;
}

const LINK = /^\[((?:\\.|[^\[\]\\])+)\]\(([^()\s]+)\)/;

function scan(s, marks, out, depth) {
  let buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ text: buf, marks }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += c + s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let e = i;
      while (s[e] === '`') e++;
      const n = e - i, close = findCodeClose(s, e, n);
      if (close > e) {
        let content = s.slice(e, close);
        // 中身が ` で始まる・終わるときに足す空白（serializeRuns が同じ条件で足す）
        if (content.length > 2 && content[0] === ' ' && content.at(-1) === ' ' && (content[1] === '`' || content.at(-2) === '`')) content = content.slice(1, -1);
        flush();
        out.push({ text: content, marks: [...marks, newMark('code', { d: s.slice(i, e) })] });
        i = close + n;
        continue;
      }
      buf += s.slice(i, e);
      i = e;
      continue;
    }
    if ((c === '*' || c === '_') && depth < 4) {
      const d = s[i + 1] === c ? c + c : c;
      // 斜体は、開きが別の * のすぐ隣なら読まない（太字が閉じないまま残っている形）
      const open = i + d.length, close = d.length === 2 || s[i + 1] !== c ? findEmphasisClose(s, open, d) : -1;
      const content = close > open ? s.slice(open, close) : '';
      const ok = content && !/^\s|\s$/.test(content)
        && !(c === '_' && ((i > 0 && WORD.test(s[i - 1])) || WORD.test(s[close + d.length] ?? '')));
      if (ok) {
        flush();
        scan(content, [...marks, newMark(d.length === 2 ? 'strong' : 'em', { d })], out, depth + 1);
        i = close + d.length;
        continue;
      }
    }
    if (c === '[' && depth < 4 && s[i - 1] !== '!') {
      const m = LINK.exec(s.slice(i));
      if (m) {
        flush();
        scan(m[1], [...marks, newMark('link', { url: m[2] })], out, depth + 1);
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
}

/** 1 行の中身を run の並びにする。serializeRuns で必ず元の文字に戻る */
export function parseInline(text) {
  const out = [];
  scan(String(text ?? ''), [], out, 0);
  return mergeRuns(out);
}

// ------------------------------------------------------------------ インラインの書き出し
const codeTick = (mark, text) => {
  const used = new Set([...text.matchAll(/`+/g)].map(m => m[0].length));
  let n = Math.max(1, (mark.d ?? '`').length);
  while (used.has(n)) n++;
  return '`'.repeat(n);
};

/**
 * run の並びを Markdown の文字にする。text は文字、after[v]（v 番目の見える文字の直後で閉じの区切りの前）と
 * before[v]（v 番目の見える文字の頭。開きの区切りの後）は、見える位置から文字の位置への写し
 */
export function serializeRunsMapped(runs) {
  const codeText = new Map();
  for (const r of runs) for (const m of r.marks) if (m.t === 'code') codeText.set(m.id, (codeText.get(m.id) ?? '') + r.text);
  const ticks = new Map();
  const padded = (m) => /^`|`$/.test(codeText.get(m.id) ?? '');
  const tickOf = (m) => { if (!ticks.has(m.id)) ticks.set(m.id, codeTick(m, codeText.get(m.id) ?? '')); return ticks.get(m.id); };
  const open = (m) => (m.t === 'strong' || m.t === 'em' ? (m.d ?? (m.t === 'strong' ? '**' : '*')) : m.t === 'code' ? tickOf(m) + (padded(m) ? ' ' : '') : '[');
  const close = (m) => (m.t === 'strong' || m.t === 'em' ? (m.d ?? (m.t === 'strong' ? '**' : '*')) : m.t === 'code' ? (padded(m) ? ' ' : '') + tickOf(m) : `](${m.url ?? ''})`);
  let out = '', stack = [], v = 0;
  const before = [], after = [0];
  for (const r of runs) {
    const p = commonPrefix(stack, r.marks);
    for (let k = stack.length - 1; k >= p; k--) out += close(stack[k]);
    for (let k = p; k < r.marks.length; k++) out += open(r.marks[k]);
    stack = r.marks;
    for (let k = 0; k < r.text.length; k++) {
      before[v] = out.length;
      out += r.text[k];
      after[++v] = out.length;
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) out += close(stack[k]);
  before[v] = out.length;
  return { text: out, before, after };
}

export const serializeRuns = (runs) => serializeRunsMapped(runs).text;

/** [a, b) を Markdown の文字で取り出す（コピー）。全部が範囲に入っている強調・リンクだけ区切りを付ける */
export function sliceRaw(runs, a, b) {
  const extent = new Map();
  let at = 0;
  for (const r of runs) {
    for (const m of r.marks) { const e = extent.get(m.id); if (e) e[1] = at + r.text.length; else extent.set(m.id, [at, at + r.text.length]); }
    at += r.text.length;
  }
  const clipped = sliceRuns(runs, a, b).map(r => ({ text: r.text, marks: r.marks.filter(m => { const e = extent.get(m.id); return e[0] >= a && e[1] <= b; }) }));
  return serializeRuns(mergeRuns(clipped));
}

// ------------------------------------------------------------------ ブロック
export const emptyBlock = (kind = 'p') => ({ kind, marker: '', runs: [] });
export const isEmptyBlock = (b) => b.kind !== 'att' && !runsLength(b.runs);
const isPending = (b) => b.kind === 'att' && !b.path;
/** Markdown に出さないブロック（送っている途中の添付・空の pad） */
const omitted = (b) => (b.pad && isEmptyBlock(b)) || isPending(b);

export function blockRaw(b) {
  if (b.kind === 'att') return b.raw ?? '';
  if (b.kind === 'code') return runsText(b.runs);
  return b.marker + serializeRuns(b.runs);
}

const RE_HEAD = /^[ ]{0,3}#{1,6}[ \t]+/;
const RE_QUOTE = /^[ ]{0,3}(?:>[ \t]?)+/;
const RE_UL = /^[ \t]*[-*+][ \t]+/;
const RE_OL = /^[ \t]*\d{1,9}[.)][ \t]+/;

/** フェンスの行の役割: 'open' | 'close' | 'in' | null。web/render.mjs の codeFenceMask と同じ範囲を返す */
const RE_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`]{0,30})/;
export function fenceRoles(lines) {
  const roles = [];
  let close = null;
  for (const line of lines) {
    if (close) {
      if (close.test(line)) { roles.push('close'); close = null; } else roles.push('in');
      continue;
    }
    const f = RE_FENCE.exec(line);
    roles.push(f ? 'open' : null);
    if (f) close = new RegExp(`^[ ]{0,3}${f[2][0] === '`' ? '`' : '~'}{${f[2].length},}[ \\t]*$`);
  }
  return roles;
}

const codeBlock = (line) => ({ kind: 'code', marker: '', runs: plainRun(line) });

/** 行 1 つを（コードの外として）ブロックにする。resolve(path) が truthy な添付の印は原子にする */
export function classifyLine(line, { resolve = () => null, plain = false } = {}) {
  if (plain) return { kind: 'p', marker: '', runs: plainRun(line) };
  const mark = ATTACHMENT_LINE.exec(line.trim());
  if (mark && resolve(mark[1])) return { kind: 'att', marker: '', runs: [], raw: line, path: mark[1] };
  let m;
  if ((m = RE_HEAD.exec(line))) return { kind: 'h', marker: m[0], runs: parseInline(line.slice(m[0].length)) };
  if ((m = RE_QUOTE.exec(line))) return { kind: 'quote', marker: m[0], runs: parseInline(line.slice(m[0].length)) };
  if ((m = RE_UL.exec(line))) return { kind: 'ul', marker: m[0], runs: parseInline(line.slice(m[0].length)) };
  if ((m = RE_OL.exec(line))) return { kind: 'ol', marker: m[0], runs: parseInline(line.slice(m[0].length)) };
  return { kind: 'p', marker: '', runs: parseInline(line) };
}

/** キャレットを置けるように、添付の前後・閉じたコードブロックの後ろに空の pad を足す（Markdown には出ない） */
export function ensureShape(blocks) {
  if (!blocks.length) blocks.push(emptyBlock());
  if (blocks[0].kind === 'att') blocks.unshift({ ...emptyBlock(), pad: true });
  const last = blocks.at(-1);
  if (last.kind === 'att') blocks.push({ ...emptyBlock(), pad: true });
  else if (last.kind === 'code' && fenceRoles(blocks.map(blockRaw)).at(-1) === 'close') blocks.push({ ...emptyBlock(), pad: true });
  return blocks;
}

/** Markdown の文字列 → ブロック。docToMarkdown で必ず元に戻る */
export function markdownToDoc(md, opts = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const roles = opts.plain ? lines.map(() => null) : fenceRoles(lines);
  const blocks = lines.map((line, i) => (roles[i] ? codeBlock(line) : classifyLine(line, opts)));
  return ensureShape(blocks);
}

export function docToMarkdown(blocks) {
  return blocks.filter(b => !omitted(b)).map(blockRaw).join('\n');
}

/**
 * 文字列での位置の対応。lines は Markdown に出るブロックだけ { b, start, marker, map }。
 * 出ないブロック（送っている途中の添付・空の pad）は、次に出るブロックの頭と同じ位置に写る
 */
export function docLayout(blocks, memo = null) {
  const lines = [];
  let start = 0;
  blocks.forEach((b, i) => {
    if (omitted(b)) return;
    // memo（WeakMap）を渡すと、変わらないブロックの分を使い回す。渡す側は、ブロックを作った後に書き換えないこと
    let e = memo?.get(b);
    if (!e) {
      const raw = blockRaw(b);
      const map = b.kind === 'att' || b.kind === 'code' ? null : serializeRunsMapped(b.runs);
      e = { raw, marker: b.kind === 'att' || b.kind === 'code' ? '' : b.marker, map, len: b.kind === 'att' || b.kind === 'code' ? raw.length : runsLength(b.runs) };
      memo?.set(b, e);
    }
    lines.push({ b: i, start, ...e });
    start += e.raw.length + 1;
  });
  return { lines, length: Math.max(0, start - 1) };
}

/** ブロックの Markdown の文字（blockRaw）を、変わらないブロックの分だけ使い回す関数にする（cache は WeakMap。ブロックは作った後に書き換えない） */
export const memoRaw = (cache) => (b) => {
  let r = cache.get(b);
  if (r === undefined) { r = blockRaw(b); cache.set(b, r); }
  return r;
};

/** 位置 → Markdown の文字列の位置（v 番目の見える文字の直後）。layout は docLayout(blocks) の結果を使い回すとき */
export function posToOffset(blocks, pos, layout = docLayout(blocks)) {
  if (!layout.lines.length) return 0;
  const line = layout.lines.find(l => l.b >= pos.b) ?? layout.lines.at(-1);
  if (line.b > pos.b) return line.start;
  if (line.b < pos.b) return layout.length;
  if (!line.map) return line.start + Math.min(pos.v, line.raw.length);
  return line.start + line.marker.length + line.map.after[Math.min(pos.v, line.len)];
}

/** Markdown の文字列の位置 → 位置（その手前までにある見える文字の数） */
export function offsetToPos(blocks, offset, layout = docLayout(blocks)) {
  if (!layout.lines.length) return { b: 0, v: 0 };
  let line = layout.lines[0];
  for (const l of layout.lines) if (l.start <= offset) line = l;
  const r = Math.max(0, Math.min(offset - line.start, line.raw.length));
  if (!line.map) return { b: line.b, v: r };
  const inner = r - line.marker.length;
  let v = 0;
  while (v < line.len && line.map.after[v + 1] <= inner) v++;
  return { b: line.b, v: inner < 0 ? 0 : v };
}

// ------------------------------------------------------------------ 状態と選択
export const caret = (b, v) => ({ s: { b, v }, e: { b, v } });
export const isCollapsed = (sel) => sel.s.b === sel.e.b && sel.s.v === sel.e.v;
const before = (p, q) => p.b < q.b || (p.b === q.b && p.v <= q.v);
export const orderSel = (a, f) => (before(a, f) ? { s: a, e: f } : { s: f, e: a });

/** ブロックを raw の文字にして、別の種類の 1 行にする（コードブロックに入る・出るとき） */
function toCodeLine(b) { return codeBlock(blockRaw(b)); }

// ------------------------------------------------------------------ 選択の削除
export function deleteSelection(st) {
  if (isCollapsed(st.sel)) return st;
  const next = clone(st);
  const { s, e } = next.sel;
  const bs = next.blocks[s.b], be = next.blocks[e.b];
  if (s.b === e.b) {
    if (bs.kind === 'att') { next.blocks.splice(s.b, 1); ensureShape(next.blocks); next.sel = caret(Math.min(s.b, next.blocks.length - 1), 0); return next; }
    bs.runs = mergeRuns([...sliceRuns(bs.runs, 0, s.v), ...sliceRuns(bs.runs, e.v)]);
    next.sel = caret(s.b, s.v);
    return next;
  }
  const head = bs.kind === 'att' ? null : sliceRuns(bs.runs, 0, s.v);
  const tail = be.kind === 'att' ? null : sliceRuns(be.runs, e.v);
  let merged;
  if (head && tail) {
    merged = { ...bs, runs: mergeRuns([...head, ...tail]) };
    // コードの行と本文の行をつなぐときは、つないだ側の種類に合わせて文字にそろえる
    if (bs.kind === 'code') merged.runs = plainRun(runsText(head) + (be.kind === 'code' ? runsText(tail) : (e.v === 0 ? be.marker : '') + serializeRuns(tail)));
    else if (be.kind === 'code') merged.runs = mergeRuns([...head, ...plainRun(runsText(tail))]);
  } else if (tail) merged = { ...be, runs: tail, marker: e.v === 0 ? be.marker : '' };
  else if (head) merged = { ...bs, runs: head };
  else merged = null;
  const at = s.b;
  // 行をまたいで消して何も残らなければ、見出し・箇条書きの記号も残さず、ふつうの空行にする（全部選んで消したとき）
  if (merged && merged.kind !== 'att' && !runsLength(merged.runs) && s.v === 0) { merged.kind = 'p'; merged.marker = ''; }
  next.blocks.splice(s.b, e.b - s.b + 1, ...(merged ? [merged] : []));
  ensureShape(next.blocks);
  const idx = Math.min(at, next.blocks.length - 1);
  next.sel = caret(idx, merged ? s.v : 0);
  return next;
}

// ------------------------------------------------------------------ 文字の挿入
/** キャレットの位置の印を引き継ぐ run にする（リンク・コードは引き継がない） */
function marksAt(runs, v) {
  let at = 0, marks = [];
  for (const r of runs) {
    if (at + r.text.length >= v && at < v + (v === 0 ? 1 : 0)) { marks = r.marks.filter(m => m.t !== 'link' && m.t !== 'code'); break; }
    at += r.text.length;
  }
  return marks;
}

/** 選択を消して runs を入れる */
export function insertRuns(st, ins) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  const { b, v } = next.sel.s;
  const blk = next.blocks[b];
  if (blk.kind === 'att') return cur;
  const add = blk.kind === 'code' ? plainRun(runsText(ins)) : ins;
  blk.runs = mergeRuns([...sliceRuns(blk.runs, 0, v), ...add, ...sliceRuns(blk.runs, v)]);
  next.sel = caret(b, v + runsLength(add));
  return next;
}

/** 選択を消して文字を入れる（書式は引き継ぐ。改行は入れない） */
export function insertText(st, text) {
  const cur = deleteSelection(st);
  const { b, v } = cur.sel.s;
  return insertRuns(cur, plainRun(text).map(r => ({ ...r, marks: cur.blocks[b].kind === 'code' ? [] : marksAt(cur.blocks[b].runs, v) })));
}

/** 選択を消して、印の無い文字を入れる（強調・コード・リンクの直後で、その外へ打つとき） */
export function insertPlain(st, text) {
  return insertRuns(st, plainRun(text));
}

// ------------------------------------------------------------------ Enter
const nextOrderedMarker = (marker) => marker.replace(/(\d+)([.)])/, (_, n, d) => `${Number(n) + 1}${d}`);

/** 新しい行の記号: 番号は 1 つ進め、箇条書き・引用は同じ */
const continuedMarker = (b) => (b.kind === 'ol' ? nextOrderedMarker(b.marker) : b.marker);

export function enter(st, { plain = false } = {}) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  const { b, v } = next.sel.s;
  const blk = next.blocks[b];
  // 添付・閉じフェンスの次に足してあった pad は、そのまま本物の行にする（空行を重ねない）
  const below = () => {
    if (next.blocks[b + 1]?.pad && isEmptyBlock(next.blocks[b + 1])) delete next.blocks[b + 1].pad;
    else next.blocks.splice(b + 1, 0, emptyBlock());
    next.sel = caret(b + 1, 0);
    return next;
  };
  if (blk.kind === 'att') return below();
  const left = sliceRuns(blk.runs, 0, v), right = sliceRuns(blk.runs, v);
  delete blk.pad;
  const listLike = !plain && (blk.kind === 'ul' || blk.kind === 'ol' || blk.kind === 'quote');
  if (listLike) {
    if (!blk.runs.length) { blk.kind = 'p'; blk.marker = ''; next.sel = caret(b, 0); return next; }
    blk.runs = left;
    next.blocks.splice(b + 1, 0, { kind: blk.kind, marker: continuedMarker(blk), runs: right });
    next.sel = caret(b + 1, 0);
    return next;
  }
  if (blk.kind === 'h' && v === 0 && blk.runs.length) {
    next.blocks.splice(b, 0, emptyBlock());
    next.sel = caret(b + 1, 0);
    return next;
  }
  if (blk.kind === 'code') {
    const roles = fenceRoles(next.blocks.map(blockRaw));
    if (roles[b] === 'close' && v >= runsLength(blk.runs)) return below();
    const indent = /^[ \t]*/.exec(runsText(left))[0];
    blk.runs = left;
    next.blocks.splice(b + 1, 0, codeBlock(indent + runsText(right)));
    next.sel = caret(b + 1, indent.length);
    return next;
  }
  blk.runs = left;
  next.blocks.splice(b + 1, 0, { kind: 'p', marker: '', runs: right });
  next.sel = caret(b + 1, 0);
  return next;
}

// ------------------------------------------------------------------ Backspace / Delete（ブロックの端）
/** 行頭の Backspace。書式の行は本文に戻し、本文の行は前の行とつなぐ（前が添付ならその添付を外す） */
export function backspaceAtStart(st) {
  const next = clone(deleteSelection(st));
  const { b } = next.sel.s;
  const blk = next.blocks[b];
  if (blk.kind !== 'att' && (blk.kind === 'h' || blk.kind === 'ul' || blk.kind === 'ol' || blk.kind === 'quote')) {
    blk.kind = 'p'; blk.marker = '';
    next.sel = caret(b, 0);
    return next;
  }
  if (b === 0) return next;
  const prev = next.blocks[b - 1];
  if (prev.kind === 'att') {
    next.blocks.splice(b - 1, 1);
    ensureShape(next.blocks);
    next.sel = caret(Math.min(b - 1, next.blocks.length - 1), 0);
    return next;
  }
  const at = runsLength(prev.runs);
  const runs = prev.kind === 'code' || blk.kind === 'code'
    ? plainRun(runsText(prev.runs) + runsText(blk.runs))
    : mergeRuns([...prev.runs, ...blk.runs]);
  const kind = prev.kind === 'code' && blk.kind !== 'code' ? 'code' : prev.kind;
  next.blocks.splice(b - 1, 2, { ...prev, kind, marker: kind === 'code' ? '' : prev.marker, runs, pad: undefined });
  ensureShape(next.blocks);
  next.sel = caret(b - 1, at);
  return next;
}

/** 行末の Delete。次が添付ならその添付を外し、そうでなければ次の行をつなぐ */
export function deleteAtEnd(st) {
  const next = clone(deleteSelection(st));
  const { b } = next.sel.s;
  if (b >= next.blocks.length - 1) return next;
  const after = next.blocks[b + 1];
  const here = next.blocks[b];
  if (after.kind === 'att') {
    next.blocks.splice(b + 1, 1);
    ensureShape(next.blocks);
    next.sel = caret(b, next.sel.s.v);
    return next;
  }
  const at = runsLength(here.runs);
  const runs = here.kind === 'code' || after.kind === 'code'
    ? plainRun(runsText(here.runs) + runsText(after.runs))
    : mergeRuns([...here.runs, ...after.runs]);
  next.blocks.splice(b, 2, { ...here, kind: here.kind === 'att' ? 'p' : here.kind, runs, pad: undefined });
  ensureShape(next.blocks);
  next.sel = caret(b, at);
  return next;
}

// ------------------------------------------------------------------ 添付（原子）
/**
 * キャレットの位置に添付を入れる。空の行なら置き換え、行の途中なら前後に割る。コードブロックの中なら閉じの後ろ。
 * 入れた後のキャレットは、添付の次の行の頭（無ければ pad を足す）
 */
export function insertAtom(st, atom) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  let { b, v } = next.sel.s;
  const blk = next.blocks[b];
  let at;   // 添付を置く添字
  if (blk.kind === 'code') {
    const roles = fenceRoles(next.blocks.map(blockRaw));
    let end = b;
    while (end < next.blocks.length - 1 && roles[end] !== 'close') end++;
    at = end + 1;
    next.blocks.splice(at, 0, atom);
  } else if (blk.kind === 'att') {
    at = b + 1;
    next.blocks.splice(at, 0, atom);
  } else if (!blk.runs.length) {
    at = b;
    next.blocks.splice(b, 1, atom);
  } else if (v === 0) {
    at = b;
    next.blocks.splice(b, 0, atom);
  } else if (v >= runsLength(blk.runs)) {
    at = b + 1;
    next.blocks.splice(at, 0, atom);
  } else {
    const left = sliceRuns(blk.runs, 0, v), right = sliceRuns(blk.runs, v);
    blk.runs = left;
    at = b + 1;
    const tail = { kind: blk.kind === 'h' ? 'p' : blk.kind, marker: blk.kind === 'h' ? '' : continuedMarker(blk), runs: right };
    next.blocks.splice(at, 0, atom, tail);
    next.sel = caret(at + 1, 0);
    ensureShape(next.blocks);
    return next;
  }
  const after = next.blocks[at + 1];
  if (!after || after.kind === 'att') next.blocks.splice(at + 1, 0, { ...emptyBlock(), pad: true });
  ensureShape(next.blocks);
  next.sel = caret(next.blocks.indexOf(atom) + 1, 0);
  return next;
}

/** 条件に合う添付を外す */
export function removeAtoms(st, pred) {
  const next = clone(st);
  const at = next.sel.s.b;
  let shift = 0;
  next.blocks = next.blocks.filter((b, i) => {
    const drop = b.kind === 'att' && pred(b);
    if (drop && i < at) shift++;
    return !drop;
  });
  ensureShape(next.blocks);
  const idx = Math.max(0, Math.min(at - shift, next.blocks.length - 1));
  next.sel = caret(idx, Math.min(next.sel.s.v, next.blocks[idx].kind === 'att' ? 0 : runsLength(next.blocks[idx].runs)));
  return next;
}

/** removeAtoms の後で、添付の隣でも閉じたコードの後ろでもなくなった余白の行（pad）も外す（取れなかった画像の札を、何も残さずに消すとき） */
export function removeAtomsTidy(st, pred) {
  const next = removeAtoms(st, pred);
  const at = next.sel.s.b;
  let shift = 0;
  const keep = next.blocks.filter((b, i, all) => {
    const stray = b.pad && isEmptyBlock(b) && all.length > 1 && all[i - 1]?.kind !== 'att' && all[i + 1]?.kind !== 'att'
      && !(all[i - 1]?.kind === 'code' && fenceRoles(all.map(blockRaw))[i - 1] === 'close');
    if (stray && i < at) shift++;
    return !stray;
  });
  next.blocks = ensureShape(keep);
  const idx = Math.max(0, Math.min(at - shift, next.blocks.length - 1));
  next.sel = caret(idx, Math.min(next.sel.s.v, next.blocks[idx].kind === 'att' ? 0 : runsLength(next.blocks[idx].runs)));
  return next;
}

export const atomKey = (b) => (b.path ? `p:${normalizeAttachmentPath(b.path)}` : b.pid ? `i:${b.pid}` : null);
export const atomKeys = (blocks) => new Set(blocks.filter(b => b.kind === 'att').map(atomKey).filter(Boolean));

export function newAtom({ path, pid, locale = 'ja' }) {
  return { kind: 'att', marker: '', runs: [], ...(path ? { path, raw: attachmentLine(locale, path) } : {}), ...(pid ? { pid } : {}) };
}
export { ATTACHMENT_MARKS };

// ------------------------------------------------------------------ 貼り付け
/** 文字を貼る。1 行なら今の行へ（記法は整える）。複数行なら行ごとにブロックへ（空の行なら置き換え） */
export function pasteText(st, text, { plain = false, resolve = () => null } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const cur = deleteSelection(st);
  const { b, v } = cur.sel.s;
  const blk = cur.blocks[b];
  if (!src.includes('\n')) return insertRuns(cur, plain || blk.kind === 'code' ? plainRun(src) : parseInline(src));
  const parsed = blk.kind === 'code' ? src.split('\n').map(codeBlock) : markdownToDoc(src, { resolve, plain }).filter(x => !x.pad);
  return spliceParsed(cur, parsed, { resolve, plain });
}

/**
 * 貼り付けの HTML（web/html-paste.mjs）を入れる。parts は { md: 1 行の Markdown } と { atom: 添付のブロック } の並び。
 * 1 行の字だけなら今の行へ（記法は整える）。ほかは行ごとにブロックへ。先頭がふつうの段落なら今の行につなぎ、見出し・リスト・引用・コード・添付なら次の行から始める
 */
export function pasteRich(st, parts, { resolve = () => null } = {}) {
  if (parts.length === 1 && parts[0].md !== undefined && classifyLine(parts[0].md).kind === 'p' && !ATTACHMENT_LINE.test(parts[0].md.trim())) return pasteText(st, parts[0].md, { resolve });
  const cur = deleteSelection(st);
  const parsed = [];
  let lines = [];
  const flushLines = () => { if (lines.length) { parsed.push(...markdownToDoc(lines.join('\n'), { resolve }).filter(x => !x.pad)); lines = []; } };
  for (const part of parts) { if (part.md !== undefined) lines.push(part.md); else { flushLines(); parsed.push(part.atom); } }
  flushLines();
  if (!parsed.length) return cur;
  return spliceParsed(cur, parsed, { resolve, rich: true });
}

/** 解いたブロックを、キャレットの行へ差し込む（pasteText・pasteRich の本体）。cur は選択を消した後の状態 */
function spliceParsed(cur, parsed, { plain = false, resolve = () => null, rich = false } = {}) {
  const { b, v } = cur.sel.s;
  const blk = cur.blocks[b];
  const next = clone(cur);
  const inCode = blk.kind === 'code';
  const cutAt = blk.kind === 'att' ? null : v;
  const left = blk.kind === 'att' ? null : { ...blk, runs: sliceRuns(blk.runs, 0, cutAt), pad: undefined };
  const right = blk.kind === 'att' ? null : { kind: blk.kind === 'h' ? 'p' : blk.kind, marker: blk.kind === 'h' ? '' : blk.kind === 'code' ? '' : continuedMarker(blk), runs: sliceRuns(blk.runs, cutAt) };
  const seq = [];
  if (left && (left.runs.length || left.marker)) seq.push(left);
  const firstIdx = seq.length;
  seq.push(...clone(parsed));
  // 空の頭の行は貼った先頭の行と一体（記号ごと置き換える）。中身のある行なら、貼った先頭の行の中身を後ろにつなぐ
  if (firstIdx === 1 && seq[1].kind !== 'att' && seq[0].kind !== 'att' && !(inCode) && (!rich || seq[1].kind === 'p')) {
    seq[0] = { ...seq[0], runs: mergeRuns([...seq[0].runs, ...seq[1].runs]) };
    seq.splice(1, 1);
  } else if (firstIdx === 1 && inCode) {
    seq[0] = { ...seq[0], runs: plainRun(runsText(seq[0].runs) + runsText(seq[1].runs)) };
    seq.splice(1, 1);
  }
  let caretAt = seq.length - 1;
  let caretV = seq.at(-1).kind === 'att' ? 0 : runsLength(seq.at(-1).runs);
  if (right && right.runs.length) {
    const last = seq.at(-1);
    if (last.kind === 'att') { seq.push(right); caretAt = seq.length - 1; caretV = 0; }
    else {
      caretV = runsLength(last.runs);
      last.runs = last.kind === 'code' ? plainRun(runsText(last.runs) + runsText(right.runs)) : mergeRuns([...last.runs, ...right.runs]);
    }
  }
  next.blocks.splice(b, 1, ...seq);
  const idx = b + caretAt;
  normalizeFences(next.blocks, { resolve, plain });
  ensureShape(next.blocks);
  next.sel = caret(Math.min(idx, next.blocks.length - 1), caretV);
  return next;
}

// ------------------------------------------------------------------ フェンスの整合
/**
 * コードフェンスの範囲に合わせて、行の種類をそろえる（フェンスの中に入った行は code に、出た code の行は分類し直す）。
 * 書き換えたら true。undo で戻した「記号のままの行」を勝手に書式にしないよう、フェンス以外の種類は触らない
 */
export function normalizeFences(blocks, { resolve = () => null, plain = false, raw = blockRaw } = {}) {
  if (plain) return false;
  const roles = fenceRoles(blocks.map(raw));
  let changed = false;
  blocks.forEach((b, i) => {
    if (roles[i] && b.kind !== 'code') { blocks[i] = toCodeLine(b); changed = true; }
    else if (!roles[i] && b.kind === 'code') { blocks[i] = classifyLine(blockRaw(b), { resolve }); changed = true; }
  });
  return changed;
}

// ------------------------------------------------------------------ 打った直後の整形
const BLOCK_TRIGGER = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/;

function runAt(runs, v) {
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    if (v > at && v <= at + runs[i].text.length) return { i, o: v - at, at };
    at += runs[i].text.length;
  }
  return null;
}

function inlinePattern(prefix, ch) {
  const c = prefix.length - 1;   // 打った字（prefix の末尾）
  const escaped = (k) => prefix[k - 1] === '\\';
  if (ch === '`') {
    let k = c - 1;
    while (k >= 0 && prefix[k] !== '`') k--;
    if (k < 0 || k === c - 1 || prefix[k - 1] === '`' || escaped(k)) return null;
    const content = prefix.slice(k + 1, c);
    return content.includes('`') ? null : { t: 'code', start: k, content, d: '`' };
  }
  if (ch === ')') {
    const m = /\[([^\[\]]+)\]\(([^()\s]+)\)$/.exec(prefix);
    if (!m || prefix[m.index - 1] === '!' || prefix[m.index - 1] === '\\') return null;
    return { t: 'link', start: m.index, content: m[1], url: m[2] };
  }
  if (ch !== '*' && ch !== '_') return null;
  const wordBefore = (k) => ch === '_' && k > 0 && WORD.test(prefix[k - 1]);
  const okContent = (s) => s && !/^\s|\s$/.test(s);
  if (prefix[c - 1] === ch) {
    // 太字: 直前も同じ字（** を閉じた）
    const d = ch + ch, close = c - 1;
    let k = prefix.lastIndexOf(d, close - 1);
    while (k >= 0 && (prefix[k - 1] === ch || escaped(k))) k = k > 0 ? prefix.lastIndexOf(d, k - 1) : -1;
    if (k < 0) return null;
    const content = prefix.slice(k + 2, close);
    return okContent(content) && !wordBefore(k) ? { t: 'strong', start: k, content, d } : null;
  }
  for (let k = c - 1; k >= 0; k--) {
    if (prefix[k] !== ch) continue;
    if (prefix[k - 1] === ch || prefix[k + 1] === ch || escaped(k)) continue;
    const content = prefix.slice(k + 1, c);
    return okContent(content) && !wordBefore(k) ? { t: 'em', start: k, content, d: ch } : null;
  }
  return null;
}

/**
 * 字を 1 つ打った直後に整える。ch は打った字、キャレットは打った字の直後。整えたら { state, kind }、無ければ null。
 *   行頭 `# `・`- `・`1. `・`> ` で行の種類、行頭の ``` でコードブロック（閉じも足す）
 *   `code`・**太字**・*斜体*・[文字](URL) は閉じた字を打った時点で
 */
export function applyTriggers(st, ch, { plain = false } = {}) {
  if (plain || !isCollapsed(st.sel)) return null;
  const { b, v } = st.sel.s;
  const blk = st.blocks[b];
  if (!blk || blk.kind === 'att' || blk.kind === 'code') return null;
  const text = runsText(blk.runs);
  if (blk.kind === 'p') {
    if (ch === ' ') {
      const head = text.slice(0, v);
      const m = BLOCK_TRIGGER.exec(head);
      if (m && runsText(sliceRuns(blk.runs, 0, v)) === head) {
        const next = clone(st);
        const kind = head[0] === '#' ? 'h' : head[0] === '>' ? 'quote' : /\d/.test(head[0]) ? 'ol' : 'ul';
        next.blocks[b] = { kind, marker: head, runs: sliceRuns(blk.runs, v) };
        next.sel = caret(b, 0);
        return { state: next, kind: 'block' };
      }
    }
    if (ch === '`' && text.slice(0, v) === '```') {
      const next = clone(st);
      next.blocks[b] = codeBlock('```' + text.slice(v));
      next.blocks.splice(b + 1, 0, codeBlock(''), codeBlock('```'));
      ensureShape(next.blocks);
      next.sel = caret(b, 3);
      return { state: next, kind: 'fence' };
    }
  }
  const at = runAt(blk.runs, v);
  if (!at) return null;
  const run = blk.runs[at.i];
  if (run.marks.length || run.text[at.o - 1] !== ch) return null;
  const pat = inlinePattern(run.text.slice(0, at.o), ch);
  if (!pat) return null;
  const next = clone(st);
  const target = next.blocks[b];
  const r = target.runs[at.i];
  const pre = r.text.slice(0, pat.start), post = r.text.slice(at.o);
  const mark = newMark(pat.t, pat.t === 'link' ? { url: pat.url } : { d: pat.d });
  const middle = pat.t === 'code' ? { text: pat.content, marks: [mark] } : { text: pat.content, marks: [mark] };
  target.runs = mergeRuns([...target.runs.slice(0, at.i), { text: pre, marks: [] }, middle, { text: post, marks: [] }, ...target.runs.slice(at.i + 1)]);
  next.sel = caret(b, at.at + pat.start + pat.content.length);
  next.sel.after = true;
  return { state: next, kind: 'inline' };
}

// ------------------------------------------------------------------ 書式バー
/** 選択の範囲に強調・コード・リンクを付ける（範囲がすべて付いていれば外す）。1 つのブロックの中だけ */
export function toggleMark(st, type, { url } = {}) {
  const { s, e } = st.sel;
  if (s.b !== e.b || s.v === e.v) return st;
  const next = clone(st);
  const blk = next.blocks[s.b];
  if (blk.kind === 'att' || blk.kind === 'code') return st;
  const left = sliceRuns(blk.runs, 0, s.v), mid = sliceRuns(blk.runs, s.v, e.v), right = sliceRuns(blk.runs, e.v);
  const all = mid.length && mid.every(r => r.marks.some(m => m.t === type));
  let midOut;
  if (all) midOut = mid.map(r => ({ text: r.text, marks: r.marks.filter(m => m.t !== type) }));
  else {
    const mark = newMark(type, type === 'link' ? { url } : type === 'strong' ? { d: '**' } : type === 'em' ? { d: '*' } : { d: '`' });
    midOut = mid.map(r => ({ text: r.text, marks: type === 'code' ? [mark] : [...r.marks.filter(m => m.t !== type), mark] }));
  }
  blk.runs = mergeRuns([...left, ...midOut, ...right]);
  next.sel = { s: { b: s.b, v: s.v }, e: { b: s.b, v: e.v } };
  return next;
}

/** 選択の範囲が今どの書式か（書式バーの押された状態） */
export function marksInRange(st) {
  const { s, e } = st.sel;
  if (s.b !== e.b || s.v === e.v) return new Set();
  const blk = st.blocks[s.b];
  if (blk.kind === 'att' || blk.kind === 'code') return new Set();
  const mid = sliceRuns(blk.runs, s.v, e.v);
  const out = new Set();
  for (const t of ['strong', 'em', 'code', 'link']) if (mid.length && mid.every(r => r.marks.some(m => m.t === t))) out.add(t);
  return out;
}

// ------------------------------------------------------------------ 選択の Markdown（コピー・切り取り）
export function selectionMarkdown(st) {
  const { s, e } = st.sel;
  if (isCollapsed(st.sel)) return '';
  const lines = [];
  for (let i = s.b; i <= e.b; i++) {
    const b = st.blocks[i];
    if (b.kind === 'att') { if (!omitted(b)) lines.push(blockRaw(b)); continue; }
    const from = i === s.b ? s.v : 0, to = i === e.b ? e.v : runsLength(b.runs);
    const whole = from === 0 && to >= runsLength(b.runs);
    if (b.kind === 'code') { lines.push(runsText(sliceRuns(b.runs, from, to))); continue; }
    lines.push((whole || from === 0 ? b.marker : '') + sliceRaw(b.runs, from, to));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ 元に戻す
const sameBlock = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => sameBlock(x, b[i]));
/** 履歴の 1 件分。ブロックの並びだけ写し、ブロック自体は共有する（作った後に書き換えない約束）。選択は写す */
const keep = (state) => ({ blocks: state.blocks.slice(), sel: clone(state.sel) });

/**
 * 元に戻す・やり直しの履歴。状態（{ blocks, sel }）を並べる。ブロックは書き換えない前提で、変わらないブロックは履歴の間で共有する
 * （長い下書きで 1 打鍵ごとに文書全体を写さない）。
 * 文字を打つだけの変更は同じ行の中で続けて 1 つにまとめる（reason: 'type'）。整形・構造の変更はまとめない。
 * 整形の直前（記号のままの状態）と直後を別々に積むので、整えた直後の元に戻すで記号に戻る
 */
export function createHistory({ limit = 200, gap = 1000, now = () => Date.now() } = {}) {
  let stack = [], at = -1, lastAt = 0;
  return {
    reset(state) { stack = [{ state: keep(state), reason: 'init' }]; at = 0; lastAt = 0; },
    push(state, reason = 'edit') {
      const t = now();
      const top = stack[at];
      if (top && sameBlocks(top.state.blocks, state.blocks)) { top.state.sel = clone(state.sel); return false; }
      stack.length = at + 1;
      if (reason === 'type' && top?.reason === 'type' && state.sel.s.b === top.state.sel.s.b && t - lastAt < gap) {
        stack[at] = { state: keep(state), reason };
      } else {
        stack.push({ state: keep(state), reason });
        if (stack.length > limit) stack.shift();
        at = stack.length - 1;
      }
      lastAt = t;
      return true;
    },
    /**
     * すべての記録の状態を fn で書き換える（取れなかった画像の札を、戻す・やり直しにも出さない）。書き換えて同じになった隣の記録は 1 つにまとめる。
     * いまの位置は、同じ記録を指したまま
     */
    rewrite(fn) {
      const out = [];
      let to = 0;
      stack.forEach((entry, i) => {
        const state = fn(entry.state);
        const prev = out.at(-1);
        if (!(prev && sameBlocks(prev.state.blocks, state.blocks))) out.push({ state: keep(state), reason: entry.reason });
        if (i <= at) to = out.length - 1;
      });
      stack = out;
      at = to;
    },
    /** 選択だけを最新の記録に反映する（履歴は増やさない） */
    touch(sel) { if (stack[at]) stack[at].state.sel = clone(sel); },
    undo() { if (at <= 0) return null; at--; return keep(stack[at].state); },
    redo() { if (at >= stack.length - 1) return null; at++; return keep(stack[at].state); },
    get canUndo() { return at > 0; },
    get canRedo() { return at < stack.length - 1; },
    get size() { return stack.length; },
  };
}
