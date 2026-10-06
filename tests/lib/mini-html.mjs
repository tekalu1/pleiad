// ブラウザー無しで web/html-paste.mjs を動かすための最小の HTML パーサー（単体テスト専用）。
// 本物の DOMParser の代わりではなく、テストの fixture（Chrome の選択 HTML・Slack 風・色だけの span など、閉じ方の揃った断片）を読める範囲だけを持つ。
// 画面での本物の DOMParser は tests/browser/rich-paste.cjs が通す。
// 返す木は html-paste.mjs が使う口だけ: nodeType・nodeValue・tagName（大文字）・childNodes・getAttribute。
const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
const RAW = new Set(['SCRIPT', 'STYLE']);
const CLOSES_P = new Set(['DIV', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE', 'P', 'HR', 'LI']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' };

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

class Node {
  constructor(nodeType) { this.nodeType = nodeType; this.childNodes = []; this.parentNode = null; }
}
class Text extends Node {
  constructor(value) { super(3); this.nodeValue = value; }
}
class Element extends Node {
  constructor(tag, attrs) { super(1); this.tagName = tag.toUpperCase(); this.attrs = attrs; }
  getAttribute(name) { return Object.hasOwn(this.attrs, name.toLowerCase()) ? this.attrs[name.toLowerCase()] : null; }
}

/** HTML の断片を body として読む（DOMParser の parseFromString(html, 'text/html').body と同じ使い方） */
export function parseMini(html) {
  const body = new Element('BODY', {});
  const stack = [body];
  const top = () => stack.at(-1);
  const open = (el) => { top().childNodes.push(el); el.parentNode = top(); };
  const closeTo = (pred) => {
    for (let i = stack.length - 1; i > 0; i--) if (pred(stack[i])) { stack.length = i; return; }
  };
  let i = 0;
  const src = String(html);
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i] === '<' && /[!?]/.test(src[i + 1] ?? '')) { const e = src.indexOf('>', i); i = e < 0 ? src.length : e + 1; continue; }
    if (src.startsWith('</', i)) {
      const m = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(i));
      if (!m) { i++; continue; }
      const tag = m[1].toUpperCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tagName === tag) { stack.length = k; break; }
      i += m[0].length;
      continue;
    }
    if (src[i] === '<' && /[a-zA-Z]/.test(src[i + 1] ?? '')) {
      const m = /^<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(src.slice(i));
      if (!m) { i++; continue; }
      const tag = m[1].toUpperCase();
      const attrs = {};
      for (const a of m[2].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      // 閉じの省略（<p> の中のブロック・<li> の次の <li>・<td> の次の <td>・<tr> の次の <tr>）
      if (CLOSES_P.has(tag) && stack.some((n) => n.tagName === 'P')) closeTo((n) => n.tagName === 'P');
      if (tag === 'LI') { for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tagName === 'LI') { stack.length = k; break; } if (['UL', 'OL'].includes(stack[k].tagName)) break; } }
      if (tag === 'TD' || tag === 'TH') { for (let k = stack.length - 1; k > 0; k--) { if (/^T[DH]$/.test(stack[k].tagName)) { stack.length = k; break; } if (stack[k].tagName === 'TR') break; } }
      if (tag === 'TR') { for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tagName === 'TR') { stack.length = k; break; } if (stack[k].tagName === 'TABLE') break; } }
      const el = new Element(tag, attrs);
      open(el);
      i += m[0].length;
      if (RAW.has(tag)) {
        const e = src.toLowerCase().indexOf(`</${tag.toLowerCase()}`, i);
        const end = e < 0 ? src.length : e;
        el.childNodes.push(Object.assign(new Text(src.slice(i, end)), { parentNode: el }));
        i = e < 0 ? src.length : src.indexOf('>', e) + 1;
        continue;
      }
      if (!VOID.has(tag) && !m[3]) stack.push(el);
      continue;
    }
    const e = src.indexOf('<', i + 1);
    const end = e < 0 ? src.length : e;
    const text = src.slice(i, end);
    if (text) { const node = new Text(decode(text)); node.parentNode = top(); top().childNodes.push(node); }
    i = end;
  }
  return body;
}
