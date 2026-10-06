// 貼り付けの HTML（text/html）を、入力欄の形（web/md-doc.mjs: 見出し・箇条書き・番号・引用・コード・太字・斜体・インラインコード・リンク・
// 文中の添付の札）に直す（docs/adr/0141、docs/design-system.md「入力欄の編集欄」）。出どころでは分けない（どのページ・アプリの HTML も同じ規則）。
//
// - 構造（見出し・リスト・引用・コード・太字/斜体の要素・リンク・画像・表）が 1 つも無い HTML（色付きの span だけの VS Code・ターミナルなど）は null を返し、
//   呼び出し側が text/plain を使う。style だけの太字・斜体は、ほかに構造があるときだけ読む（コピー元のエディターの色分けを書式にしないため）。
// - 色・フォント・大きさ・下線・余白などの style は捨てる。非表示の要素・script・style・iframe・form の部品は読まない。
// - HTML は DOM に入れない。DOMParser は文書を作るだけでスクリプトも外の画像も読み込まない（呼び出し側は parse を差し替えられる）。
// - 戻り値: { lines: [{ md } | { image: { src, alt, kind: 'data' | 'https' } }] }。画像は文中にあっても独立した行にする（添付の札は独立した行の原子: ADR 0060）。
//   取りに行くのは呼び出し側（data: はその場で、https はホストが。ADR 0141）。取れないものは何も残さない。
export const PASTE_IMAGE_MAX = 20;       // 1 回の貼り付けで札にする画像の数。超えた分は何も残さない
export const SMALL_IMAGE_PX = 32;         // これ以下の指定の画像（絵文字・追跡ピクセル）は札にせず alt の字にする
const HTML_MAX = 24 * 1024 * 1024;        // これを超える HTML は読まない（text/plain を使う）

const SKIP = /^(?:SCRIPT|STYLE|TEMPLATE|HEAD|TITLE|META|LINK|NOSCRIPT|SVG|BUTTON|INPUT|SELECT|TEXTAREA|IFRAME|OBJECT|EMBED|CANVAS|AUDIO|VIDEO)$/;
const BLOCK = /^(?:ADDRESS|ARTICLE|ASIDE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|MAIN|NAV|SECTION|SUMMARY|CAPTION|CENTER)$/;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,/i;

/** 本物の DOMParser で body を得る（ブラウザー）。文書を作るだけで、スクリプトも外の画像も読み込まない */
export function parseHtml(html) { return new DOMParser().parseFromString(String(html), 'text/html').body; }

const collapse = (s) => s.replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f]+/g, ' ');
const escapeText = (s) => s.replace(/[\\`*[\]]/g, '\\$&').replace(/~~/g, '\\~\\~')
  .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'));
const escapeStart = (s) => s.replace(/^(#{1,6}|[-*+]|>)(?=[ \t])/, '\\$1').replace(/^(\d{1,9})([.)])(?=[ \t])/, '$1\\$2');
const encodeUrl = (u) => u.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const styleOf = (n, prop) => {
  const style = n.getAttribute?.('style');
  if (!style) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m ? m[1].trim().toLowerCase() : undefined;
};
const hidden = (n) => {
  const attr = n.getAttribute('hidden');
  return (attr !== null && attr !== undefined) || n.getAttribute('aria-hidden') === 'true' || styleOf(n, 'display') === 'none' || styleOf(n, 'visibility') === 'hidden';
};

/** 幅・高さの指定（属性・style）の小さい方が SMALL_IMAGE_PX 以下（em・rem は 2 以下）か */
function smallImage(n) {
  if (/(?:^|[\s_-])emoji(?:$|[\s_-])/i.test(n.getAttribute('class') ?? '') || n.getAttribute('data-stringify-emoji')) return true;
  const sizes = [];
  for (const raw of [n.getAttribute('width'), n.getAttribute('height'), styleOf(n, 'width'), styleOf(n, 'height')]) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(px|em|rem)?\s*$/i.exec(raw ?? '');
    if (m) sizes.push(/^r?em$/i.test(m[2] ?? '') ? Number(m[1]) * 16 : Number(m[1]));   // em は 16px 換算（2em = 32px）
  }
  return sizes.some((px) => px <= SMALL_IMAGE_PX);
}

const samePlace = (text, href) => {
  const host = (s) => { try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
  const t = text.trim();
  if (!/^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(t)) return true;   // 字が URL に見えなければ、行き先と比べない
  const a = host(t), b = host(href);
  return !a || !b || a === b;
};

/** 1 行ぶんのインラインの並び（{ t, b, i, s, c, a }）を Markdown の字にする */
function serialize(runs) {
  // 隣り合う空白は 1 つに。同じ書式の隣は 1 つにまとめる（太字の要素が続いても ** が割れない）
  const merged = [];
  let spaced = true;
  for (const r of runs) {
    let t = r.c ? r.t : collapse(r.t);
    if (!r.c && spaced) t = t.replace(/^ /, '');
    if (!t) continue;
    spaced = !r.c && t.endsWith(' ');
    const last = merged.at(-1);
    if (last && last.b === r.b && last.i === r.i && last.s === r.s && last.c === r.c && last.a === r.a) last.t += t;
    else merged.push({ ...r, t });
  }
  const wrap = (s, d) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s); return m[2] ? `${m[1]}${d}${m[2]}${d}${m[3]}` : s; };
  const code = (s) => {
    if (!s.trim()) return s;
    const used = new Set([...s.matchAll(/`+/g)].map((m) => m[0].length));
    let n = 1;
    while (used.has(n)) n++;
    const tick = '`'.repeat(n), pad = /^`|`$/.test(s) ? ' ' : '';
    return `${tick}${pad}${s}${pad}${tick}`;
  };
  // 外側から リンク → 太字 → 斜体 → 取り消し線 → コード。同じ値が続く範囲ごとに包む
  const levels = ['a', 'b', 'i', 's', 'c'];
  const emit = (rs, level) => {
    if (level === levels.length) return rs.map((r) => escapeText(r.t)).join('');
    const key = levels[level];
    let out = '';
    for (let k = 0; k < rs.length;) {
      let e = k;
      while (e < rs.length && rs[e][key] === rs[k][key]) e++;
      const group = rs.slice(k, e), value = group[0][key];
      if (key === 'c') out += value ? code(group.map((r) => r.t).join('')) : emit(group, level + 1);
      else {
        const inner = emit(group, level + 1);
        if (!value) out += inner;
        else if (key === 'a') {
          if (!inner.trim()) out += inner;
          else {
            const text = group.map((r) => r.t).join('');
            out += `[${inner}](${encodeUrl(value)})${samePlace(text, value) ? '' : ` (${encodeUrl(value)})`}`;
          }
        } else out += wrap(inner, key === 'b' ? '**' : key === 'i' ? '*' : '~~');
      }
      k = e;
    }
    return out;
  };
  return escapeStart(emit(merged, 0).trim());
}

/**
 * @param {string} html text/html の中身
 * @param {object} [o]
 * @param {(html: string) => object} [o.parse] HTML → body（既定は DOMParser。テストで差し替える）
 * @param {number} [o.maxImages] 札にする画像の上限
 * @returns {{ lines: Array<{ md: string } | { image: { src: string, alt: string, kind: 'data' | 'https' } }> } | null}
 */
export function htmlToRich(html, { parse = parseHtml, maxImages = PASTE_IMAGE_MAX } = {}) {
  const source = String(html ?? '');
  if (!source.trim() || source.length > HTML_MAX) return null;
  let body;
  try { body = parse(source); } catch { return null; }
  if (!body) return null;
  let structure = false, images = 0;

  /** 子のノードの並びを、行の並び（{ md, raw?, list? } | { image }）にする。li・引用・セルの中身も同じ道具で作る */
  function blocks(children, ctx) {
    const out = [];
    let cur = [];
    let lastWasPara = false;

    const lineItems = () => {
      const groups = [];
      let g = [];
      for (const r of cur) {
        if (r.br) { groups.push(g); g = []; }
        else if (r.image) { groups.push(g, r); g = []; }
        else g.push(r);
      }
      groups.push(g);
      cur = [];
      const res = [];
      for (const x of groups) {
        if (!Array.isArray(x)) { while (res.at(-1)?.md === '') res.pop(); res.push({ image: x.image }); continue; }
        const md = serialize(x);
        if (md === '' && (!res.length || res.at(-1).md === '' || res.at(-1).image)) continue;   // 先頭・続く空行・画像の隣の空行は落とす（<br> が 2 つ続いた所は 1 行残る）
        res.push({ md });
      }
      while (res.at(-1)?.md === '') res.pop();
      return res;
    };
    const emit = (items, para = false) => {
      if (!items.length) return;
      if (para && lastWasPara && out.length && out.at(-1).md && items[0].md !== undefined) out.push({ md: '' });   // <p> と <p> の間は空行
      out.push(...items);
      lastWasPara = para;
    };
    const flush = (para = false) => { emit(lineItems(), para); };

    const run = (text, ctx2) => {
      if (!text) return;
      if (text.trim() && (ctx2.rb || ctx2.ri || ctx2.rs || ctx2.a)) structure = true;
      cur.push({ t: text, b: !!ctx2.b, i: !!ctx2.i, s: !!ctx2.s, c: false, a: ctx2.a });
    };

    function visit(n, ctx2) {
      if (n.nodeType === 3) { run(ctx2.pre ? n.nodeValue : collapse(n.nodeValue), ctx2); return; }
      if (n.nodeType !== 1 || SKIP.test(n.tagName) || hidden(n)) return;
      const tag = n.tagName;
      if (tag === 'BR') { cur.push({ br: true }); return; }
      if (tag === 'IMG') { image(n, ctx2); return; }
      if (/^H[1-6]$/.test(tag)) {
        flush();
        const { text, found } = inlineOf(n, ctx2);
        emit([...(text ? [{ md: `${'#'.repeat(Number(tag[1]))} ${text}` }] : []), ...found]);
        if (text) structure = true;
        return;
      }
      if (tag === 'UL' || tag === 'OL') { flush(); emit(list(n, ctx2)); return; }
      if (tag === 'LI') {   // リストの外に切り出された li
        flush();
        const li = item(n, '- ', ctx2);
        if (li.some((x) => x.md)) structure = true;
        emit(li);
        return;
      }
      if (tag === 'BLOCKQUOTE') {
        flush();
        const sub = blocks(n.childNodes, ctx2).map((x) => (x.md === undefined || x.raw ? x : { md: x.md ? `> ${x.md}` : '>' }));
        if (sub.some((x) => x.md)) structure = true;
        emit(sub);
        return;
      }
      if (tag === 'PRE') { flush(); emit(fence(n)); return; }
      if (tag === 'TABLE') { flush(); emit(table(n, ctx2)); return; }
      if (tag === 'HR') { flush(); return; }
      if (tag === 'P') {
        flush();
        for (const c of n.childNodes) visit(c, ctx2);
        flush(true);
        return;
      }
      if (BLOCK.test(tag) || /^(?:TR|TD|TH|THEAD|TBODY|TFOOT|DL)$/.test(tag)) {
        flush();
        for (const c of n.childNodes) visit(c, ctx2);
        flush();
        return;
      }
      // インラインの要素: 書式を引き継いで子へ（中にブロックがあれば、そこで行が切れる）
      const next = { ...ctx2 };
      const weight = styleOf(n, 'font-weight'), fontStyle = styleOf(n, 'font-style'), deco = `${styleOf(n, 'text-decoration') ?? ''} ${styleOf(n, 'text-decoration-line') ?? ''}`;
      if (tag === 'STRONG' || tag === 'B') { if (!/^(?:normal|[1-5]00)$/.test(weight ?? '')) { next.b = true; next.rb = true; } }
      else if (/^(?:bold|bolder|[6-9]00)$/.test(weight ?? '')) next.b = true;
      if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'DFN') { if (fontStyle !== 'normal') { next.i = true; next.ri = true; } }
      else if (fontStyle === 'italic' || fontStyle === 'oblique') next.i = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') { next.s = true; next.rs = true; }
      else if (/line-through/.test(deco)) next.s = true;
      if (tag === 'A') {
        const href = (n.getAttribute('href') ?? '').trim();
        if (/^(?:https?:|mailto:)/i.test(href)) next.a = href;
      }
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') {
        const text = collapse(rawText(n, true));
        if (text.trim()) { structure = true; cur.push({ t: text, b: !!next.b, i: !!next.i, s: !!next.s, c: true, a: next.a }); }
        return;
      }
      for (const c of n.childNodes) visit(c, next);
    }

    function image(n, ctx2) {
      const alt = (n.getAttribute('alt') ?? '').trim().replace(/\s+/g, ' ');
      const altRun = () => { if (alt) cur.push({ t: alt, b: !!ctx2.b, i: !!ctx2.i, s: !!ctx2.s, c: false, a: ctx2.a }); };
      const src = (n.getAttribute('src') ?? '').trim();
      if (ctx2.noImages || smallImage(n)) { altRun(); return; }
      const kind = DATA_IMAGE.test(src) ? 'data' : /^https:\/\//i.test(src) ? 'https' : null;
      if (!kind) { altRun(); return; }   // http・相対・blob・svg などは取りに行かない
      if (images >= maxImages) return;   // 超えた分は何も残さない
      images++;
      structure = true;
      cur.push({ image: { src, alt, kind } });
    }

    /** 見出し・セルの中身: インラインだけを 1 行にする。中の画像は行の後ろへ */
    function inlineOf(n, ctx2) {
      const sub = blocks(n.childNodes, ctx2);
      return { text: sub.filter((x) => x.md !== undefined && !x.raw).map((x) => x.md).filter(Boolean).join(' ').trim(), found: sub.filter((x) => x.image) };
    }

    function list(n, ctx2) {
      const ordered = n.tagName === 'OL';
      let num = parseInt(n.getAttribute('start') ?? '1', 10);
      if (!Number.isFinite(num)) num = 1;
      const res = [];
      for (const c of n.childNodes) {
        if (c.nodeType !== 1 || SKIP.test(c.tagName) || hidden(c)) continue;
        if (c.tagName === 'LI') res.push(...item(c, ordered ? `${num++}. ` : '- ', ctx2));
        else res.push(...blocks([c], ctx2).map((x) => (x.md ? { ...x, md: `  ${x.md}` } : x)));   // li の外に置かれた入れ子のリスト
      }
      if (res.some((x) => x.md)) structure = true;
      return res;
    }

    function item(li, marker, ctx2) {
      let placed = false;
      return blocks(li.childNodes, ctx2).map((x) => {
        if (x.md === undefined || x.raw) return x;
        if (!x.md) return x;
        if (!placed && !x.list) { placed = true; return { md: marker + x.md, list: true }; }
        return { md: `  ${x.md}`, list: true };
      });
    }

    function fence(n) {
      const code = [...n.childNodes].find((c) => c.nodeType === 1 && c.tagName === 'CODE');
      const text = rawText(n, false).replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
      if (!text.trim()) return [];
      const lang = (/(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(`${code?.getAttribute('class') ?? ''} ${n.getAttribute('class') ?? ''}`) ?? [])[1] ?? '';
      const tick = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      structure = true;
      return [{ md: tick + lang, raw: true }, ...text.split('\n').map((md) => ({ md, raw: true })), { md: tick, raw: true }];
    }

    function table(n, ctx2) {
      const rows = [];
      const walkRows = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType !== 1 || SKIP.test(c.tagName) || hidden(c)) continue;
          if (c.tagName === 'TR') {
            const cells = [...c.childNodes].filter((x) => x.nodeType === 1 && /^T[DH]$/.test(x.tagName) && !hidden(x))
              .map((x) => inlineOf(x, { ...ctx2, noImages: true }).text.replace(/\|/g, '\\|'));
            if (cells.length) rows.push(cells);
          } else if (/^(?:THEAD|TBODY|TFOOT)$/.test(c.tagName)) walkRows(c);
        }
      };
      walkRows(n);
      if (!rows.length) return [];
      structure = true;
      const cols = rows[0].length;
      const line = (cells) => ({ md: `| ${cells.join(' | ')} |` });
      // 1 行目を見出しの行にする（区切りの行を足すと、送ったあとの描画が表にする。入力欄は平文の行のまま持つ）
      return [line(rows[0]), { md: `| ${Array.from({ length: cols }, () => '---').join(' | ')} |` }, ...rows.slice(1).map(line)];
    }

    for (const c of children) visit(c, ctx);
    flush();
    return out;
  }

  /** <pre>・<code> の字（<br> は改行。非表示・script は読まない） */
  function rawText(n, oneLine) {
    let s = '';
    const walk = (x) => {
      if (x.nodeType === 3) { s += x.nodeValue; return; }
      if (x.nodeType !== 1 || SKIP.test(x.tagName) || hidden(x)) return;
      if (x.tagName === 'BR') { s += oneLine ? ' ' : '\n'; return; }
      for (const c of x.childNodes) walk(c);
    };
    walk(n);
    return s;
  }

  const items = blocks(body.childNodes, {});
  const lines = [];
  for (const it of items) {
    if (it.image) { lines.push({ image: it.image }); continue; }
    if (it.md === '' && !it.raw && (!lines.length || lines.at(-1).md === '' || lines.at(-1).image)) continue;   // 先頭・続く空行・画像の隣の空行は落とす
    lines.push({ md: it.md });
  }
  while (lines.length && lines.at(-1).md === '') lines.pop();
  if (!structure || !lines.length) return null;
  return { lines };
}

/** クリップボードから構造のある HTML を読む。無ければ null（text/plain を使う） */
export function richFromClipboard(dt, opts) {
  const html = dt?.getData?.('text/html');
  return html ? htmlToRich(html, opts) : null;
}
