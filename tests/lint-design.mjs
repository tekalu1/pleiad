#!/usr/bin/env node
/* ==================== CSS デザイン lint ====================
   「薄い背景色 + 同系の濃い文字色」の札を機械的に落とす。依存なし・Node 20+。
   規則の一覧と閾値の理由は docs/design-system.md §5。

     node tests/lint-design.mjs <file...> [--strict] [--json] [--selftest]

   .css と .html（<style> ブロックと style 属性）を受け取る。トークンの定義は渡された全ファイルから
   集めるので、tokens.css を一緒に渡さないと var(--ink) が unknown-token になる。
   これは意図した動作。「解決できない色は判定できない」を黙って見逃さないため。

   npm test からは tests/unit/design-lint.mjs が lint() と selftest() を直接呼ぶ。 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/* -------------------- しきい値。ここを動かすと判定が変わるので理由を残す -------------------- */
/* 面の彩度。旧 style.css の札の面は C≈0.026–0.029、新デザインの面は C≈0.005–0.014。
   0.015 がこの二つを分ける谷。ここより上の面は「色が付いている」と見なす。 */
const SURFACE_CHROMA = 0.015;
/* 文字の彩度。旧 style.css の札の文字は C≈0.10–0.15。無彩色の文字を巻き込まないよう高めに取る。 */
const TEXT_CHROMA = 0.06;
/* 面と文字の色相差。45°より近ければ「同系色」。補色（180°）や青地に赤文字は対象外。 */
const HUE_NEAR = 45;
/* OKLCH の色相が意味を持たなくなる彩度と、色として数えなくなる不透明度。 */
const HUE_UNDEFINED_CHROMA = 0.004;
const ALPHA_MIN = 0.05;

/* -------------------- 色の族。族の名前が用途を縛る（tokens.css のヘッダと同じ約束） -------------------- */
const FAM = {
  surface: n => n.startsWith('--surface-'),
  fill:    n => n.startsWith('--fill-'),
  ink:     n => n === '--ink' || n.startsWith('--ink-'),
  line:    n => n === '--line' || n.startsWith('--line-'),
  onfill:  n => n === '--on-fill',
  shadow:  n => n === '--shadow',
};
/* プロパティごとに許す族。ここに無い族のトークンを色のプロパティに書いたら落とす。 */
const ALLOW = {
  background: ['surface', 'fill'],
  color:      ['ink', 'onfill'],
  border:     ['line', 'surface', 'shadow', 'fill'],   /* 主要ボタンの枠だけ fill を許す */
  svg:        ['line', 'ink', 'fill', 'surface'],
  decoration: ['line', 'ink'],                          /* リンクの下線 */
};
/* 片側だけの線。border-left のような単独指定と、inset の影で片側に置いた線。意味を持たせても
   持たせなくても使わない（選択・待ち・失敗は面の階調・記号・文字で表す）。
   border-top-left-radius のような角丸は線ではないので除く。 */
const ONE_SIDED = /^border-(top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block)(-(width|style|color))?$/;
/* 枠線そのもの（--strict: border-use）。区切りは余白・面の階調・配置で作るのが原則。
   どうしても要る箇所は、その宣言と同じ行に `allow-border:` と理由をコメントで書く。
   outline はフォーカスの輪なので枠線に数えない。 */
const BORDER_PROP = /^border(-(width|style|color|top|right|bottom|left|inline|block)(-\w+)*)?$/;
const ALLOW_BORDER_MARK = /allow-border\s*:/;
/* トークンを定義してよいスコープ（--strict）。ここ以外に色リテラルを置くとテーマが片肺になる。 */
const THEME_SCOPES = [':root', ':root:not([data-theme="light"])', ':root[data-theme="dark"]'];

/* 色を運ぶプロパティ。ここに載っていないプロパティのリテラルは見ない。 */
const COLOR_PROP_SET = new Set(['color', 'box-shadow', 'text-shadow', 'fill', 'stroke',
  'caret-color', 'accent-color', 'scrollbar-color', 'filter']);
const COLOR_PROP_PREFIX = ['background', 'border', 'outline', 'text-decoration', 'column-rule'];
const isColorProp = p => COLOR_PROP_SET.has(p) || COLOR_PROP_PREFIX.some(x => p === x || p.startsWith(x + '-'));

/* 色ではないキーワード。リテラル判定から除く。 */
const EXEMPT_WORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none', 'revert', 'revert-layer']);

/* CSS 名前付き色 148 個。値まで持つのは、名前付き色が実際に使われたとき OKLCH を出すため。 */
const NAMED = Object.fromEntries(('aliceblue f0f8ff,antiquewhite faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,'
+ 'bisque ffe4c4,black 000000,blanchedalmond ffebcd,blue 0000ff,blueviolet 8a2be2,brown a52a2a,burlywood deb887,cadetblue 5f9ea0,'
+ 'chartreuse 7fff00,chocolate d2691e,coral ff7f50,cornflowerblue 6495ed,cornsilk fff8dc,crimson dc143c,cyan 00ffff,darkblue 00008b,'
+ 'darkcyan 008b8b,darkgoldenrod b8860b,darkgray a9a9a9,darkgreen 006400,darkgrey a9a9a9,darkkhaki bdb76b,darkmagenta 8b008b,'
+ 'darkolivegreen 556b2f,darkorange ff8c00,darkorchid 9932cc,darkred 8b0000,darksalmon e9967a,darkseagreen 8fbc8f,darkslateblue 483d8b,'
+ 'darkslategray 2f4f4f,darkslategrey 2f4f4f,darkturquoise 00ced1,darkviolet 9400d3,deeppink ff1493,deepskyblue 00bfff,dimgray 696969,'
+ 'dimgrey 696969,dodgerblue 1e90ff,firebrick b22222,floralwhite fffaf0,forestgreen 228b22,fuchsia ff00ff,gainsboro dcdcdc,'
+ 'ghostwhite f8f8ff,gold ffd700,goldenrod daa520,gray 808080,green 008000,greenyellow adff2f,grey 808080,honeydew f0fff0,hotpink ff69b4,'
+ 'indianred cd5c5c,indigo 4b0082,ivory fffff0,khaki f0e68c,lavender e6e6fa,lavenderblush fff0f5,lawngreen 7cfc00,lemonchiffon fffacd,'
+ 'lightblue add8e6,lightcoral f08080,lightcyan e0ffff,lightgoldenrodyellow fafad2,lightgray d3d3d3,lightgreen 90ee90,lightgrey d3d3d3,'
+ 'lightpink ffb6c1,lightsalmon ffa07a,lightseagreen 20b2aa,lightskyblue 87cefa,lightslategray 778899,lightslategrey 778899,'
+ 'lightsteelblue b0c4de,lightyellow ffffe0,lime 00ff00,limegreen 32cd32,linen faf0e6,magenta ff00ff,maroon 800000,'
+ 'mediumaquamarine 66cdaa,mediumblue 0000cd,mediumorchid ba55d3,mediumpurple 9370db,mediumseagreen 3cb371,mediumslateblue 7b68ee,'
+ 'mediumspringgreen 00fa9a,mediumturquoise 48d1cc,mediumvioletred c71585,midnightblue 191970,mintcream f5fffa,mistyrose ffe4e1,'
+ 'moccasin ffe4b5,navajowhite ffdead,navy 000080,oldlace fdf5e6,olive 808000,olivedrab 6b8e23,orange ffa500,orangered ff4500,'
+ 'orchid da70d6,palegoldenrod eee8aa,palegreen 98fb98,paleturquoise afeeee,palevioletred db7093,papayawhip ffefd5,peachpuff ffdab9,'
+ 'peru cd853f,pink ffc0cb,plum dda0dd,powderblue b0e0e6,purple 800080,rebeccapurple 663399,red ff0000,rosybrown bc8f8f,royalblue 4169e1,'
+ 'saddlebrown 8b4513,salmon fa8072,sandybrown f4a460,seagreen 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,skyblue 87ceeb,'
+ 'slateblue 6a5acd,slategray 708090,slategrey 708090,snow fffafa,springgreen 00ff7f,steelblue 4682b4,tan d2b48c,teal 008080,'
+ 'thistle d8bfd8,tomato ff6347,turquoise 40e0d0,violet ee82ee,wheat f5deb3,white ffffff,whitesmoke f5f5f5,yellow ffff00,'
+ 'yellowgreen 9acd32').split(',').map(s => { const [n, h] = s.trim().split(' '); return [n, h]; }));

/* ==================== 色の計算 ==================== */
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = c => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/* Björn Ottosson の sRGB→OKLab。M1 → 立方根 → M2。 */
function oklch(col) {
  const R = toLin(col.r), G = toLin(col.g), B = toLin(col.b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(a, b);
  /* 彩度が無いとき色相は数字としては出るが意味が無い。null にして比較から外す。 */
  const H = C < HUE_UNDEFINED_CHROMA ? null : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { L, C, H, a: col.a };
}
/* 色相の円周距離。0–180。 */
const hueDist = (h1, h2) => { const d = Math.abs(h1 - h2) % 360; return d > 180 ? 360 - d : d; };
/* 「色が付いている」か。透けているものは地の色に負けるので数えない。 */
const chromatic = (c, th) => c.a >= ALPHA_MIN && c.C >= th;

const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')
  + (c.a < 1 ? ' α' + c.a.toFixed(2).replace(/^0/, '') : '');
const fL = x => x.toFixed(2).replace(/^0/, '');
const fC = x => x.toFixed(3).replace(/^0/, '');

/* 括弧の深さを見ながら割る。mode='ws' は空白で、mode='comma' はカンマで。
   gradient や rgb() の中身を巻き込まないために深さを数える。 */
function splitTop(v, mode = 'ws') {
  const out = []; let d = 0, buf = '', q = null;
  for (const ch of v) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === '(') d++; if (ch === ')') d--;
    if (d === 0 && (mode === 'ws' ? /\s/.test(ch) : ch === ',')) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
const inner = s => s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
const fnArgs = s => splitTop(inner(s), 'comma');
/* rgb()/hsl() はカンマ記法とスペース記法（+ `/ alpha`）の両方があるので、区切りを均してから割る。 */
const numArgs = s => inner(s).replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
const num = (s, base = 1) => s.trim().endsWith('%') ? parseFloat(s) / 100 * base : parseFloat(s);

function parseColor(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'currentcolor') return null;           /* 何色かは呼び出し側で決まる。判定しない */
  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    const x = (i, n) => parseInt(n === 1 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    if (h.length === 3 || h.length === 4)
      return { r: x(0, 1), g: x(1, 1), b: x(2, 1), a: h.length === 4 ? x(3, 1) / 255 : 1 };
    if (h.length === 6 || h.length === 8)
      return { r: x(0), g: x(1), b: x(2), a: h.length === 8 ? x(3) / 255 : 1 };
    return null;
  }
  if (NAMED[s]) return parseColor('#' + NAMED[s]);
  const fn = s.match(/^([a-z-]+)\s*\(/); if (!fn) return null;
  const name = fn[1];
  if (name === 'rgb' || name === 'rgba') {
    const p = numArgs(s);
    if (p.length < 3) return null;
    return { r: num(p[0], 255), g: num(p[1], 255), b: num(p[2], 255), a: p[3] === undefined ? 1 : num(p[3]) };
  }
  if (name === 'hsl' || name === 'hsla') {
    const p = numArgs(s);
    if (p.length < 3) return null;
    const h = ((parseFloat(p[0]) % 360) + 360) % 360, sa = num(p[1]), l = num(p[2]);
    const f = n => { const k = (n + h / 30) % 12, A = sa * Math.min(l, 1 - l); return 255 * (l - A * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
    return { r: f(0), g: f(8), b: f(4), a: p[3] === undefined ? 1 : num(p[3]) };
  }
  if (name === 'color-mix') {
    /* 近似。どの色空間指定でも線形 sRGB で混ぜる。transparent は「不透明度だけの相手」として
       扱い、混色後も相手の色相・彩度を保つ（CSS の premultiplied な挙動に合わせる）。 */
    const p = fnArgs(s); if (p.length < 3) return null;
    const one = t => { const m = t.match(/^(.*?)\s*(\d*\.?\d+)%$/); return m ? { c: parseColor(m[1]), w: parseFloat(m[2]) / 100 } : { c: parseColor(t), w: null }; };
    const A = one(p[1]), B = one(p[2]);
    if (!A.c || !B.c) return null;
    let wa = A.w, wb = B.w;
    if (wa == null && wb == null) { wa = wb = 0.5; } else if (wa == null) { wa = 1 - wb; } else if (wb == null) { wb = 1 - wa; }
    const t = wa + wb || 1; wa /= t; wb /= t;
    const mix = (x, y) => toSrgb(toLin(x) * wa + toLin(y) * wb);
    const a = A.c.a * wa + B.c.a * wb;
    if (A.c.a === 0) return { r: B.c.r, g: B.c.g, b: B.c.b, a };
    if (B.c.a === 0) return { r: A.c.r, g: A.c.g, b: A.c.b, a };
    return { r: mix(A.c.r, B.c.r), g: mix(A.c.g, B.c.g), b: mix(A.c.b, B.c.b), a };
  }
  return null;   /* oklch()/lab() などは解決しない。リテラル規則 A では検出されるので取りこぼさない */
}

/* ==================== CSS の切り出し ==================== */
/* コメントは中身だけ消し、改行は残す。行番号がずれると指摘の意味が無くなる。 */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2), stop = e < 0 ? src.length : e + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop;
    } else { out += src[i++]; }
  }
  return out;
}
/* html は <style> の中身と style="…" 属性だけ残して他を空白で潰す。行番号が html のそれと一致する。
   style 属性は同じ位置に [style]{…} の規則として置く（直書きの色も見えるように。幅が同じなので行はずれない）。 */
function htmlToCss(text) {
  const mask = text.replace(/[^\n]/g, ' ').split('');
  const put = (at, s) => { for (let i = 0; i < s.length; i++) mask[at + i] = s[i]; };
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) put(m.index + m[0].indexOf('>') + 1, m[1]);
  for (const m of text.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) put(m.index, `[style]{${m[1]}}`.padEnd(m[0].length).slice(0, m[0].length));
  return mask.join('');
}

const GROUP_AT = new Set(['media', 'supports', 'container', 'layer', 'scope', 'keyframes', '-webkit-keyframes', 'document']);

/* 中括弧を数えながら規則を集める。@media{...{...}} の入れ子と @keyframes の段を区別する。 */
function parseCss(src, file) {
  const rules = [], stack = [];
  let buf = '', line = 1, bufLine = 1, depth = 0, quote = null;
  const flushDecl = () => {
    const t = buf.trim(); buf = '';
    const top = stack[stack.length - 1];
    if (!t || !top || top.group) return;
    const i = t.indexOf(':'); if (i < 0) return;
    top.decls.push({ prop: t.slice(0, i).trim(), value: t.slice(i + 1).trim(), line: bufLine });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { line++; buf += ch; continue; }
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '{' || ch === '}' || ch === ';')) {
      if (ch === ';') { flushDecl(); continue; }
      if (ch === '{') {
        const prelude = buf.trim(); const at = prelude.startsWith('@') ? prelude.slice(1).split(/[\s({]/)[0].toLowerCase() : null;
        const parent = stack[stack.length - 1];
        stack.push({
          prelude, at, group: !!(at && GROUP_AT.has(at)), decls: [], line: bufLine,
          step: !!(parent && parent.at && parent.at.includes('keyframes')),
        });
        buf = ''; continue;
      }
      flushDecl();
      const blk = stack.pop();
      if (blk && !blk.group) rules.push({ ...blk, file, selector: blk.prelude, theme: themeOf(stack, blk.prelude) });
      continue;
    }
    if (!buf.trim() && /\S/.test(ch)) bufLine = line;
    buf += ch;
  }
  return rules;
}
/* テーマの判定。:root:not([data-theme="light"]) は「light」を含むが、これはダーク側の記述なので
   [data-theme="dark"] と prefers-color-scheme:dark だけを見る。 */
function themeOf(stack, selector) {
  if (stack.some(s => s.group && /prefers-color-scheme\s*:\s*dark/.test(s.prelude))) return 'dark';
  if (/\[data-theme\s*=\s*["']?dark["']?\]/.test(selector)) return 'dark';
  return 'light';
}

/* ==================== トークン表と解決 ==================== */
function collectTokens(rules) {
  const map = new Map();
  for (const r of rules) for (const d of r.decls) {
    if (!d.prop.startsWith('--')) continue;
    if (!map.has(d.prop)) map.set(d.prop, { light: [], dark: [] });
    map.get(d.prop)[r.theme].push({ ...d, file: r.file, selector: r.selector });
  }
  return map;
}
/* ライトは素の :root の最初の定義、ダークは上書きの最後。片方しか無ければもう片方で代用する。 */
function pickDef(defs, theme) {
  if (!defs) return null;
  if (theme === 'dark') return defs.dark[defs.dark.length - 1] || defs.light[0] || null;
  return defs.light[0] || defs.dark[defs.dark.length - 1] || null;
}
/* var() を再帰展開。fallback 対応。循環したらそこで打ち切る（無限ループで落とさない）。 */
function expand(value, theme, tokens, seen = new Set(), miss = null) {
  let out = '', i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let d = 0, j = at + 3, end = -1;
    for (; j < value.length; j++) { if (value[j] === '(') d++; else if (value[j] === ')') { d--; if (!d) { end = j; break; } } }
    if (end < 0) { out += value.slice(at); break; }
    const args = value.slice(at + 4, end);
    const comma = splitIndex(args);
    const name = (comma < 0 ? args : args.slice(0, comma)).trim();
    const fb = comma < 0 ? null : args.slice(comma + 1).trim();
    const def = pickDef(tokens.get(name), theme);
    if (seen.has(name)) out += '';                                   /* 循環。空にして止める */
    else if (def) out += expand(def.value, theme, tokens, new Set([...seen, name]), miss);
    else if (fb !== null) out += expand(fb, theme, tokens, seen, miss);
    else { if (miss) miss.add(name); out += ''; }
    i = end + 1;
  }
  return out;
}
const splitIndex = s => { let d = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') d--; else if (s[i] === ',' && !d) return i; } return -1; };
const varNames = v => [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]);
const resolveColor = (value, theme, tokens) => {
  const v = expand(value, theme, tokens);
  for (const part of splitTop(v)) { const c = parseColor(part); if (c) return c; }
  return null;
};

/* ==================== 規則 ==================== */
export function lint(files, opts) {
  const rules = files.flatMap(f => parseCss(stripComments(f.name.endsWith('.html') ? htmlToCss(f.text) : f.text), f.name));
  const tokens = collectTokens(rules);
  /* コメントは剥がしてから解析するので、allow-border の印だけ先に行番号で控えておく */
  const allowLines = new Map(files.map(f => [f.name, new Set(f.text.split('\n').map((l, i) => ALLOW_BORDER_MARK.test(l) ? i + 1 : 0).filter(Boolean))]));
  const V = [];
  const add = (file, line, rule, message) => V.push({ file, line, rule, message });

  /* --- A: color-literal / token-outside-root --- */
  for (const r of rules) for (const d of r.decls) {
    const isToken = d.prop.startsWith('--');
    if (isToken) {
      if (!opts.strict) continue;
      /* トークンはリテラルの出所なのでリテラル自体は許す。ただしテーマのスコープ外に置かれると
         もう片方のテーマで上書きされず片肺になる。--strict でだけ落とす。 */
      const sel = r.selector.replace(/\s+/g, '');
      if (!THEME_SCOPES.includes(sel) && findLiterals(d.value).length)
        add(r.file, d.line, 'token-outside-root', `${d.prop} の色リテラルが ${r.selector} にある：テーマのスコープ（:root など）で定義すること`);
      continue;
    }
    if (!isColorProp(d.prop)) continue;
    const lits = findLiterals(d.value);
    if (lits.length) add(r.file, d.line, 'color-literal', `${d.prop} に色リテラル ${lits.join(' / ')}：トークン（var(--…)）を使うこと`);
  }

  /* --- F: one-sided-line（常に） / border-use（--strict） --- */
  for (const r of rules) for (const d of r.decls) {
    if (d.prop.startsWith('--')) continue;
    if (ONE_SIDED.test(d.prop) && !invisibleLine(d.value))
      add(r.file, d.line, 'one-sided-line', `${d.prop}: ${d.value.slice(0, 40)}：片側だけの線は使わない。面の階調・記号・文字・位置で表す`);
    if (d.prop === 'box-shadow') { const s = insetLine(d.value); if (s) add(r.file, d.line, 'one-sided-line', `box-shadow の ${s.slice(0, 40)}：inset の影で片側に線を置かない`); }
    if (opts.strict && BORDER_PROP.test(d.prop) && !invisibleLine(d.value) && !(allowLines.get(r.file) || new Set()).has(d.line))
      add(r.file, d.line, 'border-use', `${d.prop}: ${d.value.slice(0, 40)}：枠線は使わない。区切りは余白・面の階調・配置で。要るなら同じ行に /* allow-border: 理由 */`);
  }

  /* --- B: same-hue-pair（面と文字が同系色） --- */
  for (const r of rules) {
    if (r.step) continue;                       /* @keyframes の段は面と文字の組にならない */
    const bgD = last(r.decls, d => d.prop === 'background' || d.prop === 'background-color');
    const fgD = last(r.decls, d => d.prop === 'color');
    if (!bgD || !fgD) continue;
    if (/gradient\(/.test(expand(bgD.value, 'light', tokens))) continue;
    const hits = [];
    for (const theme of ['light', 'dark']) {
      const bg = resolveColor(bgD.value, theme, tokens), fg = resolveColor(fgD.value, theme, tokens);
      if (!bg || !fg) continue;
      const B = oklch(bg), F = oklch(fg);
      if (!chromatic(B, SURFACE_CHROMA) || !chromatic(F, TEXT_CHROMA)) continue;
      if (B.H == null || F.H == null || hueDist(B.H, F.H) >= HUE_NEAR) continue;
      hits.push({ theme, B, F, bg, fg });
    }
    if (!hits.length) continue;
    const h = hits[0], tag = hits.length === 2 ? '' : h.theme === 'dark' ? '（ダークのみ）' : '（ライトのみ）';
    add(r.file, bgD.line, 'same-hue-pair',
      `background ${label(bgD.value)}→ ${hex(h.bg)} (L${fL(h.B.L)} C${fC(h.B.C)} H${Math.round(h.B.H)}) と `
      + `color ${label(fgD.value)}→ ${hex(h.fg)} (L${fL(h.F.L)} C${fC(h.F.C)} H${Math.round(h.F.H)})：同系色相の面と文字${tag}`);
  }

  /* --- B family: tinted-surface（--surface-* は無彩色でなければならない） --- */
  for (const [name, defs] of tokens) {
    if (!name.startsWith('--surface-')) continue;
    const bad = [];
    for (const theme of ['light', 'dark']) {
      const def = pickDef(defs, theme); if (!def) continue;
      const c = resolveColor(def.value, theme, tokens); if (!c || c.a < ALPHA_MIN) continue;
      const o = oklch(c);
      if (o.C >= SURFACE_CHROMA) bad.push({ theme, def, c, o });
    }
    if (!bad.length) continue;
    const b = bad[0];
    add(b.def.file, b.def.line, 'tinted-surface',
      `${name} → ${hex(b.c)} は C${fC(b.o.C)}（${bad.map(x => x.theme === 'dark' ? 'ダーク' : 'ライト').join('・')}）：`
      + `面は C<${SURFACE_CHROMA} の無彩色に留めること`);
  }

  /* --- C: paired-token（同じ語幹の面/文字ペア） --- */
  const BG_SUF = ['-bg', '-background', '-surface', '-fill'];
  const FG_SUF = ['-fg', '-text', '-color', '-ink', '-line', '-border'];
  const seenStem = new Set();
  for (const [name, defs] of tokens) {
    const suf = BG_SUF.find(s => name.endsWith(s)); if (!suf) continue;
    const stem = name.slice(0, -suf.length); if (stem.length <= 2 || seenStem.has(stem)) continue;
    const partners = FG_SUF.map(s => stem + s).filter(n => tokens.has(n));
    /* 語幹そのものが有彩色なら、それが文字色として使われる想定のペア。--warn/--warn-line のように
       -bg が無い組は対象外（面が無いので「薄い面 + 濃い文字」にならない）。 */
    if (tokens.has(stem)) {
      const c = ['light', 'dark'].map(t => { const d = pickDef(tokens.get(stem), t); return d && resolveColor(d.value, t, tokens); })
        .filter(Boolean).map(oklch).find(o => chromatic(o, TEXT_CHROMA));
      if (c) partners.unshift(stem);
    }
    if (!partners.length) continue;
    seenStem.add(stem);
    const def = pickDef(defs, 'light') || pickDef(defs, 'dark');
    add(def.file, def.line, 'paired-token',
      `${name} と ${partners.join(' / ')}：同じ語幹の面/文字ペアは「薄い面 + 同系の濃い文字」の札を作る`);
  }

  /* --- D: family / fill-without-on-fill（--strict のときだけ） --- */
  /* --- E: unknown-token（常に） --- */
  for (const r of rules) {
    let usesFill = false, hasOnFill = false;
    for (const d of r.decls) {
      const names = varNames(d.value);
      if (!names.length) continue;
      const colorProp = isColorProp(d.prop);
      for (const n of names) {
        if (!tokens.has(n)) {
          if (colorProp || d.prop.startsWith('--'))
            add(r.file, d.line, 'unknown-token', `var(${n}) がどのファイルにも定義されていない：tokens.css を渡し忘れたか綴り違い`);
          continue;
        }
        if (!opts.strict || !colorProp) continue;
        /* 色以外のトークン（--sp-1 や --hair など）は box-shadow の長さとして正当。
           色に解決できるものだけを族の検査にかける。 */
        const def = pickDef(tokens.get(n), 'light'); if (!def) continue;
        if (!resolveColor(def.value, 'light', tokens) && !resolveColor(def.value, 'dark', tokens)) continue;
        const group = famGroup(d.prop); if (!group) continue;
        const fam = Object.keys(FAM).find(k => FAM[k](n));
        if (group === 'background' && FAM.line(n) && /gradient\(/.test(d.value)) continue;  /* 線から作る階調は許す */
        // This 7px pseudo-element is a graph node, not a UI surface.
        if (group === 'background' && n === '--line-blue' && r.selector === '.thread.branched .mw.node:not(.card) .mw-gutter::before') continue;
        if (!fam || !ALLOW[group].includes(fam))
          add(r.file, d.line, 'family', `${d.prop} に var(${n})：${group} が使えるのは ${ALLOW[group].map(x => '--' + x + '-*').join(' / ')} だけ`);
        if (group === 'background' && FAM.fill(n)) usesFill = true;
      }
      if (d.prop === 'color' && names.includes('--on-fill')) hasOnFill = true;
    }
    /* :hover などの状態違いは元の規則で文字色が決まっているので問わない。 */
    if (opts.strict && usesFill && !hasOnFill && !/[:.]?(hover|focus|active|disabled|focus-visible)/.test(r.selector))
      add(r.file, r.line, 'fill-without-on-fill', `${r.selector}：background に --fill-* を使うなら color:var(--on-fill) も同じ規則に書くこと`);
  }

  const order = new Map(files.map((f, i) => [f.name, i]));
  V.sort((a, b) => (order.get(a.file) - order.get(b.file)) || a.line - b.line || a.rule.localeCompare(b.rule));
  return V;
}
const last = (arr, f) => { let r = null; for (const x of arr) if (f(x)) r = x; return r; };
const label = v => { const n = varNames(v); return n.length ? n[0] + ' ' : ''; };
function famGroup(p) {
  if (p === 'background' || p.startsWith('background')) return 'background';
  if (p === 'color') return 'color';
  if (p.startsWith('border') || p.startsWith('outline') || p === 'box-shadow') return 'border';
  if (p === 'fill' || p === 'stroke') return 'svg';
  if (p.startsWith('text-decoration')) return 'decoration';
  return null;
}
/* 線として見えない値（0 / none / transparent だけ）は枠線に数えない。 */
const invisibleLine = v => /^(0|none|0px|transparent|initial|inherit|unset)$/.test(v.trim()) || /^0(px)?\s+(solid|dashed|dotted)/.test(v.trim())
  || (/\btransparent\b/.test(v) && !/var\(|#|rgb|hsl/.test(v));   /* 1px solid transparent は場所取りで、線ではない */
/* inset の影で片側に線を置いたもの: inset x 0 0 color / inset 0 y 0 color の形（ぼかし 0、片方の offset だけ非 0）。 */
function insetLine(v) {
  for (const part of splitTop(v, 'comma')) {
    const t = part.trim(); if (!/\binset\b/.test(t)) continue;
    const nums = t.replace(/\binset\b/, '').match(/-?\d*\.?\d+(px)?/g) || [];
    if (nums.length < 2) continue;
    const [x, y, blur = '0'] = nums.map(parseFloat);
    if (blur === 0 && ((x !== 0) !== (y !== 0))) return t;
  }
  return null;
}
/* 値の中の色リテラルを拾う。url() と var() の中身は落とす（url は色ではなく、var の中は
   トークン側の責任）。名前付き色は単語境界で見る（predicate の red を拾わないため）。 */
function findLiterals(value) {
  let v = value.replace(/url\((?:[^()]|\([^()]*\))*\)/gi, ' ');
  let prev; do { prev = v; v = v.replace(/var\((?:[^()]|\([^()]*\))*\)/gi, ' '); } while (v !== prev);
  const out = [];
  for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push(m[0]);
  for (const m of v.matchAll(/\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\s*\(/gi)) out.push(m[1].toLowerCase() + '()');
  for (const m of v.toLowerCase().matchAll(/[a-z][a-z-]*/g))
    if (NAMED[m[0]] && !EXEMPT_WORDS.has(m[0])) out.push(m[0]);
  return [...new Set(out)];
}

/* ==================== 出力 ==================== */
export function report(V, files, opts) {
  if (opts.json) { console.log(JSON.stringify(V, null, 2)); return V.length ? 1 : 0; }
  for (const v of V) console.log(`${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
  const counts = files.map(f => [f.name, V.filter(v => v.file === f.name).length]).filter(x => x[1]);
  console.log(`${V.length} 件の違反 (${counts.map(([n, c]) => `${n}: ${c}`).join(', ') || 'なし'})`);
  return V.length ? 1 : 0;
}

/* ==================== 自己診断 ==================== */
export function selftest(log = console.log) {
  const chip = ':root{--danger-bg:#fbe3da;--danger-fg:#9c3312}\n.chip{background:var(--danger-bg);color:var(--danger-fg)}';
  const cases = [
    ['薄赤の面 + 濃赤の文字は落ちる', [{ name: 'a.css', text: chip }], {}, V => V.some(v => v.rule === 'same-hue-pair')],
    ['無彩色の面 + 青い文字は通る', [{ name: 'b.css', text: ':root{--surface-1:#f7f8fb;--ink-blue:#3a499e}\n.a{background:var(--surface-1);color:var(--ink-blue)}' }], { strict: true },
      V => !V.some(v => v.rule === 'same-hue-pair' || v.rule === 'family')],
    ['-bg/-fg の語幹ペアを検出', [{ name: 'a.css', text: chip }], {}, V => V.some(v => v.rule === 'paired-token' && /--danger-bg/.test(v.message))],
    ['会話軸の節だけ線色で塗れる（一般の面は拒否）', [{ name: 'node.css', text: ':root{--line-blue:#5665cd}\n.thread.branched .mw.node:not(.card) .mw-gutter::before{background:var(--line-blue)}\n.button{background:var(--line-blue)}' }], { strict: true },
      V => V.filter(v => v.rule === 'family').length === 1 && V.find(v => v.rule === 'family').line === 3],
    ['--fill-* の面に --on-fill が無い', [{ name: 'c.css', text: ':root{--fill-primary:#3a499e;--on-fill:#f4f5ff;--ink:#1c2247}\n.b{background:var(--fill-primary);color:var(--ink)}' }], { strict: true },
      V => V.some(v => v.rule === 'fill-without-on-fill')],
    ['color-mix が解決される', [{ name: 'd.css', text: ':root{--surface-x:color-mix(in srgb,#ff0000 30%,#ffffff)}' }], {},
      V => V.some(v => v.rule === 'tinted-surface' && /--surface-x/.test(v.message))],
    ['片側の線（border-left / inset 影）を検出、角丸は拾わない',
      [{ name: 'e.css', text: ':root{--line:#c9cee0}\n.a{border-left:2px solid var(--line);border-top-left-radius:8px}\n.b{box-shadow:inset 3px 0 0 var(--line)}\n.c{box-shadow:0 8px 24px var(--line)}' }], {},
      V => V.filter(v => v.rule === 'one-sided-line').length === 2],
    ['枠線は --strict で落ち、allow-border の行は通る',
      [{ name: 'f.css', text: ':root{--line:#c9cee0}\n.a{border:1px solid var(--line)}\n.b{border:1px solid var(--line)} /* allow-border: 提示 HTML が溶けないため */\n.c{border:0}' }], { strict: true },
      V => V.filter(v => v.rule === 'border-use').length === 1 && V.find(v => v.rule === 'border-use').line === 2],
    ['html の <style> と style 属性の直書きの色が、その行番号で落ちる',
      [{ name: 'g.html', text: '<html>\n<style>\n.a{color:#9c3312}\n</style>\n<div style="background:#fbe3da;width:10px">x</div>\n</html>' }], {},
      V => V.filter(v => v.rule === 'color-literal').map(v => v.line).join(',') === '3,5'],
  ];
  let ok = true;
  for (const [name, files, opt, check] of cases) {
    const V = lint(files, { strict: false, ...opt });
    const pass = check(V); ok = ok && pass;
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) V.forEach(v => log(`        ${v.rule}: ${v.message}`));
  }
  return ok ? 0 : 1;
}

/* ==================== CLI ==================== */
/* 無いファイルは例外にする（プロセスは落とさない。テストから呼ばれたとき runner ごと止めないため）。 */
export function readFiles(paths) {
  return paths.map(p => {
    if (!existsSync(p)) throw new Error(`ファイルが無い: ${p}`);
    return { name: p.replace(/\\/g, '/'), text: readFileSync(p, 'utf8') };
  });
}

/* import されたときは何もしない。直接実行されたときだけ引数を読む。 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const opts = { strict: argv.includes('--strict'), json: argv.includes('--json') };
  const paths = argv.filter(a => !a.startsWith('--'));
  if (argv.includes('--selftest')) process.exit(selftest());
  else if (!paths.length) {
    console.log(`使い方: node tests/lint-design.mjs <file...> [--strict] [--json] [--selftest]

  .css と .html（<style> ブロックと style 属性）を検査する。トークン定義は渡された全ファイルから集めるので、
  var(--…) を解決するには tokens.css も一緒に渡すこと。

    --strict    族の検査（family / fill-without-on-fill / token-outside-root / border-use）も行う
    --json      {file,line,rule,message} の配列で出す
    --selftest  内蔵のテストを走らせる

  規則: color-literal / same-hue-pair / tinted-surface / paired-token / one-sided-line / family
        fill-without-on-fill / token-outside-root / border-use / unknown-token`);
    process.exit(0);
  } else {
    let files;
    try { files = readFiles(paths); } catch (e) { console.error(e.message); process.exit(2); }
    process.exit(report(lint(files, opts), files, opts));
  }
}
