import { withoutVisualizeReferences } from './visualize-reference.mjs';
import { fileReference } from './file-reference.mjs';
import { visualizationFrame, downloadVisualization } from './visualize-frame.mjs';
// md 描画と present カードの描画。外部ライブラリを足さない方針なので自前で持つ（設計メモ §11）。
//
// 大前提: 入力（モデル出力・ユーザー入力・読み込んだファイル）は一切信用しない。
// テキストは必ず esc() を通してから組み立てる。生の入力が HTML として通る経路を作らない。
// 「エスケープしてから正規表現で置換する」方式は取らない（実体参照が壊れる／取りこぼす）。
// 構造をパースし、葉のテキストを出力する瞬間にだけエスケープする。
import { el } from "./dom.mjs";
import { fmt } from "./i18n.mjs";
import { copyIcon, downloadIcon, sidePanelIcon } from './icons.mjs';
import { copyText } from './code-copy.mjs';

// ---------------------------------------------------------------- エスケープ

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** テキストノード・属性値の共通エスケープ。& を最初に潰すので実体参照の二重解釈は起きない */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
/** 段落中の改行は <br> にする（チャットの見た目に合わせる） */
const text = (s) => esc(s).replace(/\n/g, "<br>");

/** Local files are served by the authenticated host, never by file://. */
function localFileUrl(raw) {
  if (!/^[a-z]:[\\/]/i.test(raw) && !/^\/(?!\/|local-file(?:\?|$))/.test(raw)) return null;
  return `/local-file?path=${encodeURIComponent(raw.replace(/:\d+(?::\d+)?$/, ""))}`;
}

/**
 * リンク先を検査する。http(s) と相対のみ許可し、それ以外のスキームは null を返す。
 * javascript: / data: / vbscript: はもちろん、未知のスキームも全部落とす。
 * 制御文字・空白を抜いてから判定するのは "java\tscript:" のような細工を弾くため。
 */
function safeUrl(u) {
  const raw = String(u ?? "").trim();
  if (!raw) return null;
  if (/^file:/i.test(raw)) { const ref = fileReference(raw); return ref ? localFileUrl(ref.path) : null; }
  const local = localFileUrl(raw);
  if (local) return local;
  const ref = fileReference(raw);
  if (ref?.line) return safeUrl(ref.path);
  const bare = raw.replace(/[\u0000-\u0020\u007f\u00a0\u2028\u2029]/g, "");
  if (/^https?:\/\//i.test(bare)) return raw;
  // スキームらしきものが付いていて http(s) でなければ拒否
  if (/^[a-z][a-z0-9+.\-]*:/i.test(bare)) return null;
  // ここまで来たら相対パス・#anchor・?query・//host。いずれもページのスキームを継ぐ
  return raw;
}

/**
 * <img> に出してよい URL か。外向きの通信を勝手に起こさないよう data:image と相対だけ通す。
 * md 中の画像はこれで判定する（モデルが書いた URL で勝手に外部へ取りに行かせない）。
 */
function safeImg(u) {
  const raw = String(u ?? "").trim();
  const local = localFileUrl(raw);
  if (local) return local;
  if (/^[\\/]{2}|\\|[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(raw.replace(/[\u0000-\u0020]/g, ""))) return null;
  return raw || null;
}

/**
 * present の画像用。safeImg に加えて、同一オリジンの http(s) を許す。
 * core が token 付き HTTP で配信する経路（設計メモ §7）を塞がないため。外部ホストは通さない。
 */
function presentImg(u) {
  const ok = safeImg(u);
  if (ok !== null) return ok;
  const raw = String(u ?? "").trim();
  try {
    if (typeof location !== "undefined" && /^https?:$/.test(new URL(raw).protocol) &&
        new URL(raw).origin === location.origin) return raw;
  } catch { /* URL として壊れているものは通さない */ }
  return null;
}

// ---------------------------------------------------------- シンタックスハイライト
//
// js / ts / json / bash / md 程度の軽量な自前トークナイザ。外部ライブラリは使わない。
// 完全な字句解析は狙わない（正規表現リテラルなどは諦める）。読みやすさが上がれば十分。

const KW_JS =
  "const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|export|from|as|" +
  "async|await|try|catch|finally|throw|typeof|instanceof|delete|void|yield|switch|case|break|continue|" +
  "default|do|this|super|static|get|set|interface|type|enum|implements|declare|namespace|readonly|" +
  "public|private|protected|abstract|satisfies|keyof|infer";

const KW_SH =
  "if|then|elif|else|fi|for|while|until|do|done|case|esac|function|in|return|local|export|" +
  "source|set|unset|echo|cd|exit|trap|shift|read";

const GRAMMARS = {
  js:
    "(?<cm>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" +
    "|(?<str>\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)" +
    "|(?<lit>\\b(?:true|false|null|undefined|NaN|Infinity)\\b)" +
    "|(?<kw>\\b(?:" + KW_JS + ")\\b)" +
    "|(?<num>\\b\\d[\\w.]*\\b)" +
    "|(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())",
  json:
    "(?<key>\"(?:\\\\.|[^\"\\\\])*\")(?=\\s*:)" +
    "|(?<str>\"(?:\\\\.|[^\"\\\\])*\")" +
    "|(?<lit>\\b(?:true|false|null)\\b)" +
    "|(?<num>-?\\b\\d[\\d.eE+\\-]*)",
  bash:
    "(?<cm>(?:^|(?<=\\s))#[^\\n]*)" +
    "|(?<str>\"(?:\\\\.|[^\"\\\\])*\"|'[^']*')" +
    "|(?<var>\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*|\\$[@*#?$!0-9])" +
    "|(?<kw>\\b(?:" + KW_SH + ")\\b)" +
    "|(?<opt>(?<=^|\\s)--?[A-Za-z][\\w\\-]*)",
  md:
    "(?<cm>^[ ]{0,3}#{1,6}[^\\n]*)" +
    "|(?<str>```[^\\n]*|`[^`\\n]+`)" +
    "|(?<kw>^[ \\t]*(?:[-*+]|\\d{1,9}[.)])[ \\t])" +
    "|(?<lit>\\*\\*[^*\\n]+\\*\\*)" +
    "|(?<var>!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\))" +
    "|(?<opt>^[ ]{0,3}>[^\\n]*)",
};

const LANG_ALIAS = {
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
  ts: "js", typescript: "js", tsx: "js",
  json: "json", jsonc: "json",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash", shellsession: "bash",
  md: "md", markdown: "md",
};

/** 拡張子 → 言語ラベル（present の text/file 表示で使う） */
export function langFromPath(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p ?? ""));
  return m ? m[1].toLowerCase() : "";
}

/** コード本文を「エスケープ済み HTML 文字列」にする。ハイライトできない言語はエスケープのみ */
function highlight(code, lang) {
  const key = LANG_ALIAS[String(lang ?? "").toLowerCase()];
  const src = GRAMMARS[key];
  // 巨大なコードで正規表現に時間を使わない。素のエスケープに落とす
  if (!src || code.length > 20000) return esc(code);
  const re = new RegExp(src, "gm");
  const out = [];
  let last = 0, m;
  while ((m = re.exec(code))) {
    if (m[0] === "") { re.lastIndex++; continue; } // 空マッチで止まらない保険
    out.push(esc(code.slice(last, m.index)));
    const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    out.push(`<span class="tok-${kind}">${esc(m[0])}</span>`);
    last = re.lastIndex;
  }
  out.push(esc(code.slice(last)));
  return out.join("");
}

/**
 * コードブロックの共通ガワ。横スクロールは .code-block の内側（pre）に閉じ込める。
 * 本文を横に伸ばさないための min-width:0 は style.css 側で当てている。
 * 返すのはエスケープ済みの HTML 文字列。markdown を通さずコードだけ出したい所（設定ファイルの全文）も使う。
 */
export function codeBlock(code, lang) {
  const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : "";
  return `<div class="code-block"><div class="code-actions">${label}<button type="button" class="btn code-copy" aria-label="コードをコピー" title="コードをコピー">${copyIcon}</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
}

// ------------------------------------------------------------------ インライン

// 一度の走査で全部拾う。名前付きグループで分岐する。
// 強調の本文に上限を付けているのは、閉じ記号の無い長文でバックトラックが暴れないようにするため。
const INLINE_SRC =
  "\\\\(?<bs>[\\\\`*_{}\\[\\]()#+\\-.!|>~])" +
  "|(?<ticks>`+)(?<code>[\\s\\S]*?)\\k<ticks>(?!`)" +
  "|(?<img>!)?\\[(?<label>(?:\\\\.|[^\\]\\\\\\n]){0,500})\\]" +
  "\\((?:<(?<angleHref>[^<>\\n]{1,2000})>|(?<href>(?:\\\\.|[^()\\s\\\\]){0,2000}))(?:\\s+\"(?<title>[^\"\\n]{0,200})\")?\\)" +
  "|<(?<auto>https?:\\/\\/[^\\s<>\"]{1,2000})>" +
  "|(?<st>\\*\\*|__)(?<stb>[\\s\\S]{1,1000}?)\\k<st>" +
  "|(?<em>[*_])(?<emb>[^\\s*_][\\s\\S]{0,1000}?)\\k<em>" +
  "|~~(?<del>[\\s\\S]{1,1000}?)~~";

/** インライン記法を HTML にする。src は生のまま渡すこと（ここでエスケープする） */
function inline(src, depth = 0) {
  const s = String(src ?? "");
  if (depth > 4) return text(s); // 病的なネストで止まる
  const re = new RegExp(INLINE_SRC, "g"); // 再帰するので毎回作る（lastIndex の共有を避ける）
  const out = [];
  let last = 0, m;
  while ((m = re.exec(s))) {
    const g = m.groups;
    out.push(text(s.slice(last, m.index)));
    let handled = true;

    if (g.bs !== undefined) {
      out.push(esc(g.bs)); // \* などのエスケープ。記号そのものを出す
    } else if (g.code !== undefined) {
      // 前後に空白が1つずつ付いていたら剥がす（CommonMark 準拠）
      const c = /^ .* $/s.test(g.code) ? g.code.slice(1, -1) : g.code;
      out.push(`<code>${esc(c)}</code>`);
    } else if (g.label !== undefined) {
      out.push(link(g.img === "!", g.label, g.angleHref ?? g.href, g.title, depth));
    } else if (g.auto !== undefined) {
      out.push(link(false, g.auto, g.auto, undefined, depth));
    } else if (g.stb !== undefined) {
      if (wordInner(s, m.index, g.st)) handled = false;
      else out.push(`<strong>${inline(g.stb, depth + 1)}</strong>`);
    } else if (g.emb !== undefined) {
      if (wordInner(s, m.index, g.em)) handled = false;
      else out.push(`<em>${inline(g.emb, depth + 1)}</em>`);
    } else if (g.del !== undefined) {
      out.push(`<del>${inline(g.del, depth + 1)}</del>`);
    } else {
      handled = false;
    }

    if (handled) {
      last = re.lastIndex;
    } else {
      // 記法として扱わない。開始記号1文字だけ地の文として出し、続きから読み直す
      out.push(esc(s[m.index]));
      last = m.index + 1;
      re.lastIndex = last;
    }
  }
  out.push(text(s.slice(last)));
  return out.join("");
}

/** snake_case の途中の _ を強調にしないための判定 */
function wordInner(s, at, delim) {
  return delim[0] === "_" && at > 0 && /[\w\u3040-\u30ff\u4e00-\u9fff]/.test(s[at - 1]);
}

/** リンク／画像を組み立てる。安全でない URL はリンクにせず、文字として出す */
function link(isImg, label, href, title, depth) {
  const raw = String(href ?? "").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, "$1");
  const t = title ? ` title="${esc(title)}"` : "";
  if (isImg) {
    const u = safeImg(raw);
    // 外部 http(s) の画像は勝手に取りに行かない。リンクとして出す（設計メモ §7 の方針に揃える）
    if (u === null) return `<a class="md-link" href="${esc(safeUrl(raw) ?? "")}" target="_blank" rel="noopener noreferrer nofollow"${t}>${inline(label, depth + 1)}</a>`;
    return `<img class="md-img" src="${esc(u)}" alt="${esc(label)}"${t} loading="lazy" referrerpolicy="no-referrer">`;
  }
  const u = safeUrl(raw);
  const inner = inline(label, depth + 1);
  if (u === null) return `<span class="md-link-blocked" title="安全でないリンクのため無効化">${inner}</span>`;
  const file = fileReference(raw);
  if (file) return `<a class="md-link file-link" href="${esc(u)}" data-file-path="${esc(file.path)}"${file.line ? ` data-file-line="${file.line}"` : ''}${t}>${inner}</a>`;
  return `<a class="md-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow"${t}>${inner}</a>`;
}

// -------------------------------------------------------------------- ブロック

const RE_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`]{0,30})/;
const RE_HEAD = /^[ ]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RE_HR = /^[ ]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^[ ]{0,3}>/;
const RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const RE_DELIM = /^[ ]{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isDelimRow = (l) => l !== undefined && l.includes("|") && l.includes("-") && RE_DELIM.test(l);
const isTableTop = (lines, i) => lines[i].includes("|") && isDelimRow(lines[i + 1]);

/** その行が段落を打ち切る種類のブロックを始めるか */
function startsBlock(lines, i) {
  const l = lines[i];
  return RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) ||
    RE_QUOTE.test(l) || RE_ITEM.test(l) || isTableTop(lines, i);
}

/** リストのネスト段数。契約どおり2段までに丸める */
const level = (indent) => Math.min(1, Math.floor(indent.replace(/\t/g, "    ").length / 2));

/** `|` 区切りのセル分割。\| はセル内の縦棒として扱う */
function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function parseBlocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // コードフェンス。閉じが無いまま終わっても pre は必ず閉じる
    const f = RE_FENCE.exec(line);
    if (f) {
      const [, indent, marker, lang] = f;
      const close = new RegExp(`^[ ]{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 閉じフェンスを捨てる
      out.push(codeBlock(body.join("\n"), lang));
      continue;
    }

    // 表（見出し行 + 区切り行）
    if (isTableTop(lines, i)) {
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : "");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(cells(lines[i])); i++; }
      const at = (n) => (align[n] ? ` style="text-align:${align[n]}"` : "");
      const th = head.map((c, n) => `<th${at(n)}>${inline(c)}</th>`).join("");
      const tb = rows.map((r) =>
        `<tr>${head.map((_, n) => `<td${at(n)}>${inline(r[n] ?? "")}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    // 見出し
    const h = RE_HEAD.exec(line);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }

    // 水平線
    if (RE_HR.test(line)) { out.push("<hr>"); i++; continue; }

    // 引用（中身は再帰。深すぎるところで打ち切る）
    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        body.push(lines[i].replace(/^[ ]{0,3}>[ ]?/, ""));
        i++;
      }
      out.push(`<blockquote>${depth < 5 ? parseBlocks(body, depth + 1) : text(body.join("\n"))}</blockquote>`);
      continue;
    }

    // リスト
    if (RE_ITEM.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (RE_ITEM.test(l)) { buf.push(l); i++; continue; }
        if (!l.trim()) {
          const nx = lines[i + 1];
          if (nx !== undefined && (RE_ITEM.test(nx) || /^[ \t]{2,}\S/.test(nx))) { buf.push(l); i++; continue; }
          break;
        }
        if (/^[ \t]+\S/.test(l)) { buf.push(l); i++; continue; } // インデントされた継続行
        break;
      }
      out.push(buildList(buf));
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join("\n").replace(/[ \t]+$/gm, ""))}</p>`);
  }
  return out.join("");
}

/** 収集済みのリスト行から <ul>/<ol> を組む。ネストは2段まで */
function buildList(buf) {
  const items = [];
  let cur = null, sub = null, ordered = null;
  for (const line of buf) {
    const m = RE_ITEM.exec(line);
    if (m) {
      const ord = /\d/.test(m[2]);
      if (level(m[1]) === 0) {
        if (ordered === null) ordered = ord;
        cur = { text: [m[3]], sub: [], ordered: null };
        items.push(cur);
        sub = null;
      } else {
        if (!cur) { cur = { text: [""], sub: [], ordered: null }; items.push(cur); if (ordered === null) ordered = ord; }
        if (cur.ordered === null) cur.ordered = ord;
        sub = { text: [m[3]] };
        cur.sub.push(sub);
      }
    } else if (line.trim()) {
      (sub ?? cur)?.text.push(line.trim());
    }
  }
  const li = (it) => {
    const inner = inline(it.text.join("\n"));
    if (!it.sub?.length) return `<li>${inner}</li>`;
    const t = it.ordered ? "ol" : "ul";
    return `<li>${inner}<${t}>${it.sub.map(li).join("")}</${t}></li>`;
  };
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map(li).join("")}</${tag}>`;
}

/**
 * markdown を HTML 文字列にする。
 * @param {string} src 生の markdown（信用しない）
 * @returns {string} エスケープ済みの安全な HTML 文字列
 */
export function renderAssistantMarkdown(src, savedReferences) { return renderMarkdown(withoutVisualizeReferences(src, savedReferences)); }

export function renderMarkdown(src) {
  const s = String(src ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  if (!s.trim()) return "";
  return parseBlocks(s.split("\n"));
}

// ------------------------------------------------------------------- present

// iframe の中身の高さは sandbox かつスクリプト無しでは測れない。
// 妥協案として固定高 + 縦スクロールにし、段階的に高さを選べるようにする。
const HEIGHTS = [["小", 240], ["中", 440], ["大", 760]];

const KIND_LABEL = { image: "画像", html: "HTML", text: "テキスト", file: "ファイル", visualization: "可視化" };

/** モデル生成 HTML に CSP を差し込む。head があればその直後、無ければ先頭に置く */
function withCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
  const s = String(html ?? "");
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return meta + s;
}

/**
 * present イベントをカード要素にする。
 * @param {{kind:"image"|"html"|"text"|"file", caption?:string, path?:string,
 *          content?:string, dataUri?:string, truncated?:boolean}} ev
 * @returns {HTMLElement}
 */
export function renderPresent(ev) {
  const e = ev ?? {};
  const kind = ["image", "html", "text", "file", "visualization"].includes(e.kind) ? e.kind : "text";
  const card = el("figure", `present present-${kind}`);

  const cap = el("figcaption", "present-cap");
  cap.append(el("span", "present-kind", KIND_LABEL[kind]));
  cap.append(el("span", "present-title", e.caption ?? ""));
  card.append(cap);

  const body = el("div", "present-body");
  card.append(body);

  if (kind === 'visualization' && !e.truncated) {
    if (e.error) body.append(el('div', 'present-note', e.error));
    else {
      const frame = visualizationFrame(e.content ?? '', e.caption);
      body.append(frame);
      const controls = el('span', 'present-tools');
      // 見出し行は狭いので、操作はアイコンにしてラベルは title / aria-label に持たせる。
      const tool = (icon, label, className = '') => {
        const b = el('button', `h-btn h-icon ${className}`.trim());
        b.type = 'button'; b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label);
        controls.append(b);
        return b;
      };
      if (e.path) tool(copyIcon, 'パスをコピー').onclick = ev => copyText(ev.currentTarget, e.path, 'パスをコピー');

      // 保存されるのは会話に残っている HTML。元のファイルは変わっていることがある。
      // 会話には可視化がいくつも並ぶので、URL は押したときだけ作ってすぐ捨てる
      tool(downloadIcon, 'HTML をダウンロード').onclick =
        () => downloadVisualization({ path: e.path, title: e.caption, content: e.content ?? '' });

      // 開くのは右のプレビューパネル。ここは会話に載る面だけを組み立て、
      // 開く側とは要求イベントで繋ぐ（ファイルリンクと同じ一枚の面に集める）。
      const expand = tool(sidePanelIcon, 'サイドパネルに表示', 'visualize-expand');
      expand.onclick = () => expand.dispatchEvent(new CustomEvent('ply-visualize-expand', {
        bubbles: true, detail: { content: e.content ?? '', title: e.caption ?? '', path: e.path ?? '' },
      }));
      cap.append(controls);
      if (e.mode === 'wide') card.classList.add('visualize-wide');
    }
  } else if (e.truncated) {
    body.append(el("div", "present-note", "大きすぎるため省略されました"));
  } else if (kind === "image") {
    const src = presentImg(e.dataUri ?? e.path);
    if (src === null) body.append(el("div", "present-note", "表示できない画像です"));
    else {
      const img = el("img");
      img.src = src;
      img.alt = e.caption ?? "";
      img.loading = "lazy";
      body.append(img);
    }
  } else if (kind === "html") {
    // sandbox は空属性。allow-scripts は絶対に付けない（設計メモ §7 の Bet）
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.loading = "lazy";
    frame.style.height = `${HEIGHTS[1][1]}px`;
    frame.srcdoc = withCsp(e.content ?? "");
    body.append(frame);

    // 高さを段階的に選ばせる。中身の高さは測れないので、これが現実的な落とし所
    const tools = el("span", "present-tools");
    for (const [label, px] of HEIGHTS) {
      const b = el("button", "h-btn", label);
      b.type = "button";
      if (px === HEIGHTS[1][1]) b.classList.add("on");
      b.onclick = () => {
        frame.style.height = `${px}px`;
        for (const o of tools.children) o.classList.toggle("on", o === b);
      };
      tools.append(b);
    }
    cap.append(tools);
  } else {
    body.innerHTML = codeBlock(String(e.content ?? ""), langFromPath(e.path));
  }

  // 所在の記録として元パスを小さく添える（見に行かせるためではない）
  if (e.path && kind !== "visualization") {
    const p = el("div", "present-path");
    p.append(el("code", null, String(e.path)));
    card.append(p);
  }
  return card;
}

// ------------------------------------------------------------- ツール呼び出し
//
// 平常時は動詞のラベルだけ。入力と出力は1つのトグル内、生成画像はその外に置く。
//
// ここも入力は一切信用しない。ツール名・input・結果はすべてモデル由来なので、
// DOM に入れるのは textContent か、esc() を通した文字列だけにする。
// 生の値を innerHTML に流す経路は作らない（codeBlock は中身をエスケープしてから返す）。

/** 長すぎる文字列を切る。切ったことが分かるように印を残す */
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** パスは末尾側が知りたい情報なので、先頭を省いて末尾 keep 段だけ見せる */
function shortPath(p, keep = 2) {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) return "";
  const parts = s.split("/").filter(Boolean);
  return parts.length <= keep ? s : "…/" + parts.slice(-keep).join("/");
}

const lineCount = (s) => (String(s ?? "") ? String(s).split("\n").length : 0);
const fmtN = (n) => fmt.number(n);
const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim()) ?? "";

/** JSON にして返す。循環などで壊れても表示は止めない */
function toJson(v) {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

// ------------------------------------------------------------------ 部品

/** 等幅の1行。長い中身はこの要素の中だけで横スクロールさせる（body に出さない） */
function codeSpan(s, cls) {
  const n = el("code", cls ? `tc-code ${cls}` : "tc-code");
  n.textContent = String(s ?? "");
  return n;
}

/** パス。見せるのは末尾寄り、全体は title に持たせる（属性値なので解釈されない） */
function pathSpan(p, keep = 2) {
  const full = String(p ?? "");
  const n = codeSpan(shortPath(full, keep) || "（パスなし）", "tc-main");
  if (full) n.title = full;
  return n;
}

/** 地の文の主役。等幅にしないもの（説明・クエリ・タイトルなど） */
function textMain(s, title) {
  const n = el("span", "tc-main tc-text", String(s ?? ""));
  if (title) n.title = String(title);
  return n;
}

/** 主役に添える補足。長くても1行に収める */
function noteSpan(s, title) {
  const n = el("span", "tc-note", String(s ?? ""));
  if (title) n.title = String(title);
  return n;
}

/** 折りたたみのガワ。中身は呼び出し側が入れる */
function fold(summary, open) {
  const d = document.createElement("details");
  d.className = "tc-fold";
  if (open) d.open = true;
  const s = document.createElement("summary");
  s.textContent = String(summary);
  const body = el("div", "tc-fold-body");
  d.append(s, body);
  return d;
}

/** 折りたたみ + コードブロック。codeBlock がエスケープするので innerHTML でよい */
function foldCode(summary, body, lang, open) {
  const d = fold(summary, open);
  d.lastChild.innerHTML = codeBlock(clip(body, 8000), lang ?? "");
  return d;
}

// ------------------------------------------------------------------ 簡易 diff

const DIFF_MAX = 30; // 片側あたりの表示行数。これを超えたら残数だけ出す

/** 行単位。前後の一致部分を落として、変わったところだけ残す */
function diffLines(oldS, newS) {
  const a = String(oldS ?? "").split("\n");
  const b = String(newS ?? "").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre &&
         a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  return { del: a.slice(pre, a.length - post), add: b.slice(pre, b.length - post) };
}

/** 記号の列（+ / −）と面の階調だけで見せる。色は付けない（docs/design-system.md §2.2） */
function diffFold(oldS, newS) {
  const { del, add } = diffLines(oldS, newS);
  const d = fold(`差分（−${fmtN(del.length)} / +${fmtN(add.length)}）`);
  const box = el("div", "tc-diff");
  const put = (arr, cls, mark) => {
    for (const line of arr.slice(0, DIFF_MAX)) {
      const row = el("div", cls);
      row.append(el("span", "g", mark), el("span", null, clip(line, 400)));
      box.append(row);
    }
    if (arr.length > DIFF_MAX) box.append(el("div", "tc-diff-more", `…あと ${fmtN(arr.length - DIFF_MAX)} 行`));
  };
  put(del, "tc-del", "−");
  put(add, "tc-add", "+");
  d.lastChild.append(box);
  return d;
}

// ------------------------------------------------------------ ツール別の描画
//
// どれも (card, head, input, name) を受け取り、head に1行分を積む。
// 追加の詳細（コマンド全体・差分・JSON）は card 側に折りたたんで足す。

/** 知らない形の input を「k=v」数個にまとめる */
function summarizeInput(inp) {
  const bits = [];
  const deep = []; // 中身が入れ子のもの。スカラーが足りないときだけ使う
  for (const [k, v] of Object.entries(inp)) {
    if (v == null) continue;
    if (Array.isArray(v)) deep.push(`${k}[${fmtN(v.length)}]`);
    else if (typeof v === "object") deep.push(`${k}{${clip(Object.keys(v).join(","), 30)}}`);
    else if (bits.length < 3) bits.push(`${k}=${clip(String(v), 40)}`);
  }
  // 入力が入れ子だけのツール（questions: [...] のような形）でも空行にしない
  return [...bits, ...deep].slice(0, 3).join(" · ");
}

function drawShell(card, head, inp, name) {
  const cmd = String(inp.command ?? "");
  const folded = cmd.includes("\n") || cmd.length > 160;
  head.append(codeSpan(folded ? clip(cmd.split("\n")[0], 160) : cmd, "tc-main"));

  const notes = [];
  if (name === "PowerShell") notes.push("PowerShell");
  if (inp.run_in_background) notes.push("背景で実行");
  if (inp.description) notes.push(String(inp.description));
  if (notes.length) head.append(noteSpan(notes.join(" · ")));

  if (folded) card.append(foldCode(`コマンド全体（${fmtN(lineCount(cmd))} 行）`, cmd, "bash"));
}

function drawRead(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const bits = [];
  if (inp.pages) bits.push(`p.${clip(inp.pages, 20)}`);
  const off = Number(inp.offset);
  const lim = Number(inp.limit);
  if (Number.isFinite(off) && Number.isFinite(lim)) bits.push(`${fmtN(off)}–${fmtN(off + lim)} 行`);
  else if (Number.isFinite(lim)) bits.push(`先頭 ${fmtN(lim)} 行`);
  else if (Number.isFinite(off)) bits.push(`${fmtN(off)} 行目から`);
  if (bits.length) head.append(noteSpan(bits.join(" · ")));
}

function drawWrite(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const body = String(inp.content ?? "");
  head.append(noteSpan(`${fmtN(lineCount(body))} 行`));
  if (body) card.append(foldCode("書き込む内容", body, langFromPath(inp.file_path)));
}

function drawEdit(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const a = String(inp.old_string ?? "");
  const b = String(inp.new_string ?? "");
  const bits = [`${fmtN(lineCount(a))} 行 → ${fmtN(lineCount(b))} 行`];
  if (inp.replace_all) bits.push("全置換");
  head.append(noteSpan(bits.join(" · ")));
  if (a || b) card.append(diffFold(a, b));
}

function drawMultiEdit(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const edits = Array.isArray(inp.edits) ? inp.edits : [];
  head.append(noteSpan(`${fmtN(edits.length)} 箇所`));
  for (const [i, e] of edits.slice(0, 10).entries()) {
    const d = diffFold(e?.old_string, e?.new_string);
    d.firstChild.textContent = `${i + 1}. ${d.firstChild.textContent}`;
    card.append(d);
  }
}

function drawGlob(card, head, inp) {
  head.append(codeSpan(clip(inp.pattern ?? "", 160), "tc-main"));
  if (inp.path) head.append(noteSpan(shortPath(inp.path, 3), inp.path));
}

const GREP_MODE = { content: "内容", files_with_matches: "ファイル名", count: "件数" };

function drawGrep(card, head, inp) {
  head.append(codeSpan(clip(inp.pattern ?? "", 160), "tc-main"));
  const bits = [];
  if (inp.path) bits.push(shortPath(inp.path, 2));
  if (inp.glob) bits.push(String(inp.glob));
  if (inp.type) bits.push(String(inp.type));
  if (GREP_MODE[inp.output_mode]) bits.push(GREP_MODE[inp.output_mode]);
  if (inp["-i"]) bits.push("大小無視");
  if (inp.multiline) bits.push("複数行");
  const ctx = inp["-C"] ?? inp.context ?? inp["-A"] ?? inp["-B"];
  if (ctx != null && Number.isFinite(Number(ctx))) bits.push(`前後 ${fmtN(ctx)} 行`);
  if (inp.head_limit) bits.push(`上位 ${fmtN(inp.head_limit)}`);
  if (bits.length) head.append(noteSpan(bits.join(" · "), inp.path ? String(inp.path) : null));
}

function drawTask(card, head, inp) {
  head.append(textMain(inp.description || "サブエージェント"));
  const bits = [];
  for (const k of ["subagent_type", "name", "model", "isolation"]) {
    if (inp[k]) bits.push(String(inp[k]));
  }
  if (bits.length) head.append(noteSpan(bits.join(" · ")));
  if (inp.prompt) card.append(foldCode("渡した指示", String(inp.prompt), "md"));
}

function drawWebFetch(card, head, inp) {
  const raw = String(inp.url ?? "");
  // safeUrl は相対パスも通すが、リンクにしてよいのは絶対 http(s) だけにする。
  // 壊れた URL を host 自身への相対リンクにしても意味が無く、押せることが誤解を生む
  const u = /^https?:\/\//i.test(raw.trim()) ? safeUrl(raw) : null;
  if (u === null) {
    head.append(codeSpan(clip(raw, 160), "tc-main"));
  } else {
    const a = el("a", "tc-main tc-link", clip(raw, 160));
    a.setAttribute("href", u); // 絶対 http(s) かつ safeUrl を通ったものだけ
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
    a.title = raw;
    head.append(a);
  }
  if (inp.prompt) head.append(noteSpan(clip(inp.prompt, 80), String(inp.prompt)));
}

function drawWebSearch(card, head, inp) {
  head.append(textMain(clip(inp.query ?? "", 200)));
  const dom = inp.allowed_domains ?? inp.blocked_domains;
  if (Array.isArray(dom) && dom.length) {
    head.append(noteSpan(`${inp.allowed_domains ? "限定" : "除外"}: ${clip(dom.join(", "), 60)}`));
  }
}

const TODO_MARK = { completed: "✓", in_progress: "▸", pending: "・" };

function drawTodo(card, head, inp) {
  const todos = Array.isArray(inp.todos) ? inp.todos : [];
  const cur = todos.find((t) => t?.status === "in_progress");
  const done = todos.filter((t) => t?.status === "completed").length;
  head.append(textMain(cur ? String(cur.activeForm || cur.content || "") : `${fmtN(todos.length)} 件`));
  head.append(noteSpan(`${fmtN(done)}/${fmtN(todos.length)} 完了`));

  if (!todos.length) return;
  const d = fold(`項目（${fmtN(todos.length)}）`);
  const list = el("div", "tc-todo");
  for (const t of todos.slice(0, 50)) {
    const status = String(t?.status ?? "");
    const row = el("div", `tc-todo-item tc-todo-${TODO_MARK[status] ? status : "other"}`);
    row.append(el("span", "tc-todo-mark", TODO_MARK[status] ?? "・"));
    row.append(el("span", null, String(t?.content ?? "")));
    list.append(row);
  }
  d.lastChild.append(list);
  card.append(d);
}

// このアプリ自身のツール。何をしたかを日本語でそのまま出す（設計メモ 2.2）
const PRESENT_KIND = { image: "画像", html: "HTML", text: "テキスト", file: "ファイル", visualization: "可視化" };

function drawPresent(card, head, inp) {
  const cap = String(inp.caption ?? "").trim();
  head.append(cap ? textMain(cap) : pathSpan(inp.path));
  const bits = [PRESENT_KIND[inp.kind] ?? String(inp.kind ?? "")];
  if (cap && inp.path) bits.push(shortPath(inp.path, 2));
  head.append(noteSpan(bits.filter(Boolean).join(" · "), inp.path ? String(inp.path) : null));
}

function drawStatus(card, head, inp) {
  head.append(textMain(`→ ${String(inp.status ?? "")}`));
  if (inp.reason) head.append(noteSpan(clip(inp.reason, 80), String(inp.reason)));
}

function drawTitle(card, head, inp) {
  head.append(textMain(`→ ${String(inp.title ?? "")}`));
  if (inp.reason) head.append(noteSpan(clip(inp.reason, 80), String(inp.reason)));
}

function drawFork(card, head, inp) {
  head.append(textMain(inp.title ? `→ ${String(inp.title)}` : "この会話をここまで引き継ぐ"));
  if (inp.reason) head.append(noteSpan(clip(inp.reason, 80), String(inp.reason)));
}

/** mcp__<server>__<tool>。サーバ名とツール名を分けて見せる */
function drawMcp(card, head, inp, name) {
  const parts = String(name).split("__");
  head.append(el("span", "tc-server", parts[1] ?? ""));
  head.append(textMain(parts.slice(2).join("__") || name));
  const s = summarizeInput(inp);
  if (s) head.append(noteSpan(s));
  if (Object.keys(inp).length) card.append(foldCode("入力", toJson(inp), "json"));
}

function drawUnknown(card, head, inp) {
  const s = summarizeInput(inp);
  if (s) head.append(textMain(s));
  if (Object.keys(inp).length) card.append(foldCode("入力", toJson(inp), "json"));
}

// 動詞で揃える。並んだときに「何をしたか」が縦に読める
const TOOL_LABEL = {
  Bash: "実行", PowerShell: "実行", Read: "読む", Write: "書く", Edit: "編集",
  MultiEdit: "編集", NotebookEdit: "編集", Glob: "探す", Grep: "検索",
  Task: "委譲", Agent: "委譲", WebFetch: "取得", WebSearch: "web検索", TodoWrite: "TODO",
  mcp__ply__present: "提示", mcp__host__present: "提示", mcp__host__set_status: "状態",
  mcp__host__set_title: "タイトル", mcp__host__fork: "分岐",
};

const TOOL_DRAW = {
  Bash: drawShell, PowerShell: drawShell,
  Read: drawRead, Write: drawWrite, Edit: drawEdit,
  MultiEdit: drawMultiEdit, NotebookEdit: drawEdit,
  Glob: drawGlob, Grep: drawGrep,
  Task: drawTask, Agent: drawTask,
  WebFetch: drawWebFetch, WebSearch: drawWebSearch, TodoWrite: drawTodo,
  mcp__ply__present: drawPresent, mcp__host__present: drawPresent, mcp__host__set_status: drawStatus,
  mcp__host__set_title: drawTitle, mcp__host__fork: drawFork,
};

// バックエンドが宣言する shape -> 描き方。名前が違っても「何をするツールか」は同じなので、
// Claude 用に書いた描画をそのまま使い回す（入力のキーが違えば summarizeInput へ落ちる）。
const SHAPE_DRAW = {
  shell: drawShell, read: drawRead, write: drawWrite, edit: drawEdit,
  search: drawGrep, delegate: drawTask, web: drawWebFetch, generic: drawUnknown,
};

/**
 * バックエンドから来たツール表示ヒントで TOOL_LABEL / TOOL_DRAW を**補う**。
 * 既に知っている名前は上書きしない（こちらの専用表示のほうが情報量が多い）。
 * @param {{[name:string]: {label?:string, shape?:string}}} hints
 */
export function applyToolHints(hints) {
  for (const [name, hint] of Object.entries(hints ?? {})) {
    if (!name || !hint || typeof hint !== "object") continue;
    if (hint.label && !(name in TOOL_LABEL)) TOOL_LABEL[name] = String(hint.label);
    const draw = SHAPE_DRAW[hint.shape];
    if (draw && !(name in TOOL_DRAW)) TOOL_DRAW[name] = draw;
  }
}

/**
 * ツール呼び出しを折りたたみ、開くと入力と出力を読めるようにする。
 * @param {string} name ツール名（モデル由来。信用しない）
 * @param {object} input ツール入力（同上）
 * @param {{id?:string, open?:boolean, compact?:boolean}} [opts]
 *        id: tool_use_id を data 属性に持たせる（後から結果を突き合わせるため）
 *        open: 折りたたみを開いた状態で作る / compact: 余白を詰める
 * @returns {HTMLElement}
 */
export function renderToolCall(name, input, opts) {
  const raw = String(name ?? "");
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const o = opts ?? {};

  const card = el("div", "tc");
  card.dataset.tool = raw; // dataset は属性値。中身は解釈されない
  if (o.id != null) card.dataset.id = String(o.id);
  if (o.compact) card.classList.add("tc-compact");

  const details = el("details", "tc-fold tc-details");
  details.open = Boolean(o.open);
  const head = el("summary", "tc-head");
  const body = el("div", "tc-details-body");
  details.append(head, body);
  card.append(details);
  head.append(el("span", "tc-label", TOOL_LABEL[raw] ?? (raw.startsWith("mcp__") ? "MCP" : clip(raw, 24))));

  body.append(el("div", "tc-section-label", "入力"));
  const inputBody = el("div", "tc-input");
  inputBody.innerHTML = codeBlock(JSON.stringify(inp, null, 2), "json");
  body.append(inputBody);
  return card;
}

// -------------------------------------------------------------- ツールの結果

/** 結果の形は SDK の生ブロックだったり history.mjs の {text} だったりする。文字列に均す */
function resultText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join("\n");
  if (typeof r === "object") {
    if (typeof r.text === "string") return r.text;
    if (r.content != null) return resultText(r.content);
  }
  return "";
}

/** 結果の要約。全文は出さない。行数・件数・成否だけ分かればよい */
function summarizeResult(tool, body, n) {
  const t = body.trim();
  if (!t) return "出力なし";
  if (/^No (matches|files) found/i.test(t)) return "0 件";
  const found = /^Found (\d+) /.exec(t);
  if (found) return `${fmtN(found[1])} 件`;

  switch (tool) {
    case "Glob": return `${fmtN(n)} 件`;
    case "Write": return "保存した";
    case "Edit": case "MultiEdit": case "NotebookEdit": return "編集した";
    case "TodoWrite": return "更新した";
    default:
      // このアプリのツールは「〜した」という短い返事を返すので、それをそのまま見せる
      if (String(tool ?? "").startsWith("mcp__")) return t.length <= 60 ? clip(firstLine(t), 60) : "実行した";
      return `${fmtN(n)} 行`;
  }
}

/**
 * renderToolCall が作った要素に結果を反映する。**全文は出さない。**
 * 長い出力は折りたたみに入れ、失敗は目立たせる。
 * @param {HTMLElement} node renderToolCall の戻り
 * @param {{text?:string, isError?:boolean, truncated?:boolean}|string|null} result
 * @returns {HTMLElement} node
 */
export function applyToolResult(node, result) {
  if (!node || typeof node.querySelector !== "function") return node;

  // 呼び直されても二重に付かないよう、前回の結果を落としてから積む
  for (const old of [...node.querySelectorAll(".tc-res, .tc-out, .tc-preview")]) old.remove();
  node.classList.remove("tc-error", "tc-done");
  if (result == null) return node;

  const head = node.querySelector(".tc-head") ?? node;
  const body = resultText(result);
  const isError = Boolean(result?.isError ?? result?.is_error);
  const cut = Boolean(result?.truncated);

  node.classList.add(isError ? "tc-error" : "tc-done");
  const badge = el("span", isError ? "tc-res tc-res-err" : "tc-res");
  // 失敗は記号と太字で。色は付けない（差し色は「あなたを待っている」だけ）
  badge.textContent = isError
    ? "✕ 失敗"
    : "";
  if (isError) head.append(badge);

  // 短い出力も詳細内に残す。画像だけは折りたたみの外に置く。
  const output = el("div", "tc-out");
  output.append(el("div", "tc-section-label", `出力${cut ? "（途中まで）" : ""}`));
  const code = el("div", "tc-output");
  code.innerHTML = codeBlock(body || "出力なし", "");
  output.append(code);
  (node.querySelector(".tc-details-body") ?? node).append(output);
  for (const img of result?.images ?? []) {
    const src = presentImg(img.url ?? img.dataUri ?? "");
    if (!src) continue;
    const preview = el("div", "tc-preview");
    const picture = document.createElement("img");
    picture.setAttribute("src", src);
    picture.setAttribute("alt", img.caption || "生成画像");
    picture.setAttribute("loading", "lazy");
    preview.append(picture);
    node.append(preview);
  }
  return node;
}
