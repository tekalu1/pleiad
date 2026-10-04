// git パネルの差分の組み立て（docs/design-system.md「git の動き」、ADR 0135）。行番号（旧・新）・語の強調・変わっていない行の畳みと展開・
// インライン / 左右。色は --diff-*（差分と状態の文字だけに使う族）。DOM に触れない buildItems / wordRange と、文字列を返す diffHTML。
import { t } from './i18n.mjs';
import { moreIcon } from './icons.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 削除の行と追加の行の、共通の頭と尻を除いた所 [from, to)（同じ・全部違うときは null） */
export function wordRange(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  // 絵文字などのサロゲートペアの間で切らない（頭は上位サロゲートの手前へ、尻は下位サロゲートの手前を含める）
  const high = (c) => c >= 0xD800 && c <= 0xDBFF, low = (c) => c >= 0xDC00 && c <= 0xDFFF;
  if (p > 0 && high(a.charCodeAt(p - 1))) p--;
  if (q > 0 && low(a.charCodeAt(a.length - q))) q--;
  return p + q < Math.max(a.length, b.length) ? { a: [p, a.length - q], b: [p, b.length - q] } : null;
}

/**
 * 差分（core の { hunks: [{ oldStart, oldCount, newStart, newCount, section, lines }] }）→ 並び。
 * 要素は { rows: [{ t: 'a'|'d'|'c', s, o?, n?, w? }] }（変更のかたまり）か { gap: true, from, to, delta }（変わっていない行。新側の from〜to）。
 * after（差分の後ろ側のファイルの全行）があれば、畳みの前後も作る。無ければ、ハンクの間だけ畳む（開けない）
 */
export function buildItems(diff) {
  const items = [];
  let prevN = 0, lastDelta = 0;
  const after = diff.after ?? null;
  const gap = (from, to, delta, section = '') => { if (to >= from) items.push({ gap: true, from, to, delta, section }); };
  for (const h of diff.hunks ?? []) {
    // 「-3,0」「+3,0」は「3 行目の後ろ」の意味なので、行は 4 行目から数える
    let o = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    let n = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    if (n > prevN + 1) gap(prevN + 1, n - 1, o - n, h.section ?? '');
    const rows = [];
    for (const line of h.lines) {
      if (line.t === '+') rows.push({ t: 'a', s: line.s, n: n++ });
      else if (line.t === '-') rows.push({ t: 'd', s: line.s, o: o++ });
      else rows.push({ t: 'c', s: line.s, o: o++, n: n++ });
    }
    for (let i = 0; i < rows.length;) {
      if (rows[i].t !== 'd') { i++; continue; }
      let j = i; while (j < rows.length && rows[j].t === 'd') j++;
      let k = j; while (k < rows.length && rows[k].t === 'a') k++;
      for (let x = 0; x < Math.min(j - i, k - j); x++) {
        const range = wordRange(rows[i + x].s, rows[j + x].s);
        if (range) { rows[i + x].w = range.a; rows[j + x].w = range.b; }
      }
      i = k;
    }
    items.push({ rows });
    prevN = n - 1;
    lastDelta = o - n;
  }
  if (after && after.length > prevN) gap(prevN + 1, after.length, lastDelta);
  return items;
}

const code = (r) => {
  if (!r.w || r.w[1] <= r.w[0]) return esc(r.s);
  return `${esc(r.s.slice(0, r.w[0]))}<span class="wd">${esc(r.s.slice(r.w[0], r.w[1]))}</span>${esc(r.s.slice(r.w[1]))}`;
};
const sign = (type) => (type === 'a' ? '+' : type === 'd' ? '−' : ' ');
const inlineRow = (r) => `<div class="dl ${r.t}"><span class="ln o">${r.o ?? ''}</span><span class="ln n">${r.n ?? ''}</span><span class="sg">${sign(r.t)}</span><span class="code">${code(r)}</span></div>`;
const half = (r, side) => (r
  ? `<div class="hc ${r.t}"><span class="ln">${side === 'L' ? r.o : r.n}</span><span class="sg">${sign(r.t)}</span><span class="code">${code(r)}</span></div>`
  : '<div class="hc f" aria-hidden="true"><span class="ln"></span><span class="sg"></span><span class="code"> </span></div>');

/** 左右の行（削除の連なりと続く追加の連なりを横に組にする） */
function sideRows(rows) {
  let html = '';
  for (let i = 0; i < rows.length;) {
    if (rows[i].t === 'c') { html += half(rows[i], 'L') + half(rows[i], 'R'); i++; continue; }
    const dels = [], adds = [];
    let j = i;
    while (j < rows.length && rows[j].t === 'd') dels.push(rows[j++]);
    while (j < rows.length && rows[j].t === 'a') adds.push(rows[j++]);
    for (let x = 0; x < Math.max(dels.length, adds.length); x++) html += half(dels[x], 'L') + half(adds[x], 'R');
    i = j;
  }
  return html;
}

/** 畳みの行の文。節の見出し（直前の関数）が分かれば添える */
function gapLabel(g, after) {
  // 直前の関数は、続くハンクの見出し（git の funcname。言語によらない）を使う。無ければ JS の関数・クラスの行を探す
  const section = g.section || (after ? [...after.slice(0, g.from - 1)].reverse().find((s) => /^(export )?(default )?(async )?(function|class) /.test(s)) : null);
  return `<span>${moreIcon}${esc(t('git.gapLines', { count: g.to - g.from + 1 }))}${section ? ` · <code>${esc(section.trim().slice(0, 60))}</code>` : ''}</span>`;
}

/**
 * 差分の本文の HTML。mode は 'inline' | 'side'、open は開いた畳みの番号の Set。
 * 変更のかたまりの先頭の行に data-ch（前の変更・次の変更の移動先）を付ける。changes は変更のかたまりの数
 */
export function diffHTML(diff, { mode = 'inline', open = new Set() } = {}) {
  const items = buildItems(diff);
  const after = diff.after ?? null;
  let html = '', gi = 0, ci = 0;
  for (const it of items) {
    if (it.gap) {
      const id = gi++;
      if (open.has(id) && after) {
        const rows = Array.from({ length: it.to - it.from + 1 }, (_, x) => ({ t: 'c', s: after[it.from - 1 + x] ?? '', o: it.from + x + it.delta, n: it.from + x }));
        html += `<div class="dgap-lines">${mode === 'side' ? sideRows(rows) : rows.map(inlineRow).join('')}</div>`;
      } else html += `<button type="button" class="dgap" data-gap="${id}" aria-expanded="false"${after ? '' : ' disabled'} title="${esc(t('git.gapOpen'))}">${gapLabel(it, after)}</button>`;
      continue;
    }
    if (mode === 'side') {
      let i = 0;
      while (i < it.rows.length) {
        if (it.rows[i].t === 'c') { html += half(it.rows[i], 'L') + half(it.rows[i], 'R'); i++; continue; }
        let j = i; while (j < it.rows.length && it.rows[j].t !== 'c') j++;
        html += sideRows(it.rows.slice(i, j)).replace('<div class="hc', `<div data-ch="${ci++}" class="hc`);
        i = j;
      }
    } else {
      let prev = 'c';
      for (const r of it.rows) {
        html += r.t !== 'c' && prev === 'c' ? inlineRow(r).replace('<div class="dl', `<div data-ch="${ci++}" class="dl`) : inlineRow(r);
        prev = r.t;
      }
    }
  }
  return { html: mode === 'side' ? `<div class="sbs">${html}</div>` : `<div class="din">${html}</div>`, changes: ci, gaps: gi };
}
