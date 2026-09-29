import { withoutVisualizeReferences } from './visualize-reference.mjs';
import { fileReference, looksLikePath, findWindowsPaths, baseName, dirName, WINDOWS_PATH_SOURCE } from './file-reference.mjs';
import { visualizationFrame, downloadVisualization } from './visualize-frame.mjs';
// md 描画と present カードの描画。外部ライブラリを足さない方針なので自前で持つ（設計メモ §11）。
//
// 大前提: 入力（モデル出力・ユーザー入力・読み込んだファイル）は一切信用しない。
// テキストは必ず esc() を通してから組み立てる。生の入力が HTML として通る経路を作らない。
// 「エスケープしてから正規表現で置換する」方式は取らない（実体参照が壊れる／取りこぼす）。
// 構造をパースし、葉のテキストを出力する瞬間にだけエスケープする。
import { el, chevron } from "./dom.mjs";
import { fmt, t } from "./i18n.mjs";
import { copyIcon, downloadIcon, sidePanelIcon, moreIcon } from './icons.mjs';
import { copyPathText } from './file-actions.mjs';

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
  return `<div class="code-block"><div class="code-actions">${label}<button type="button" class="btn code-copy" aria-label="${esc(t("timeline.code.copy"))}" title="${esc(t("timeline.code.copy"))}">${copyIcon}</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
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
  `|(?<win>${WINDOWS_PATH_SOURCE})` +
  "|(?<st>\\*\\*|__)(?<stb>[\\s\\S]{1,1000}?)\\k<st>" +
  "|(?<em>[*_])(?<emb>[^\\s*_][\\s\\S]{0,1000}?)\\k<em>" +
  "|~~(?<del>[\\s\\S]{1,1000}?)~~";

/**
 * ファイルリンク。Markdown のリンク・自動リンク・所在の一行が同じ形を出す（押すと右パネル、右クリックで操作）。
 * inner はエスケープ済みの HTML
 */
function fileAnchor(ref, inner, extra = "") {
  const href = safeUrl(ref.path) ?? "";
  return `<a class="md-link file-link${extra}" href="${esc(href)}" data-file-path="${esc(ref.path)}"${ref.line ? ` data-file-line="${ref.line}"` : ""}>${inner}</a>`;
}

/** 画像の下に添える所在の一行: ファイル名（右パネルで開く）・フォルダー（全体は title）・⋯（操作） */
export function whereHtml(path) {
  const name = baseName(path), dir = dirName(path).replace(/[\\/]+$/, ""), label = esc(t("files.actionsFor", { name }));
  return `<span class="file-where">${fileAnchor({ path, line: null }, esc(name))}` +
    (dir ? `<span class="file-where-dir" title="${esc(dir)}">${esc(dir)}</span>` : "") +
    `<button type="button" class="btn btn-icon file-more" data-file-menu="${esc(path)}" aria-haspopup="menu" aria-label="${label}" title="${label}">${moreIcon}</button></span>`;
}

/**
 * インライン記法を HTML にする。src は生のまま渡すこと（ここでエスケープする）。
 * noLink はリンクの中身を描くとき。パスを自動でリンクにしない（<a> の入れ子を作らない）
 */
function inline(src, depth = 0, noLink = false) {
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
      // 中身全体が 1 つのパスならファイルリンク（`web/render.mjs`・`D:\a b\c.md:42`）
      const ref = noLink ? null : looksLikePath(c);
      out.push(ref ? fileAnchor(ref, `<code>${esc(c)}</code>`, " code-link") : `<code>${esc(c)}</code>`);
    } else if (g.label !== undefined) {
      out.push(link(g.img === "!", g.label, g.angleHref ?? g.href, g.title, depth, noLink));
    } else if (g.auto !== undefined) {
      out.push(link(false, g.auto, g.auto, undefined, depth, noLink));
    } else if (g.win !== undefined) {
      // 地の文の Windows の絶対パス（docs/design-system.md「ファイルの操作」）。末尾の句読点は外して、続きから読み直す
      const found = noLink ? null : findWindowsPaths(g.win)[0];
      if (!found || found.start !== 0) handled = false;
      else {
        out.push(fileAnchor(found, esc(g.win.slice(0, found.end))));
        re.lastIndex = m.index + found.end;
      }
    } else if (g.stb !== undefined) {
      if (wordInner(s, m.index, g.st)) handled = false;
      else out.push(`<strong>${inline(g.stb, depth + 1, noLink)}</strong>`);
    } else if (g.emb !== undefined) {
      if (wordInner(s, m.index, g.em)) handled = false;
      else out.push(`<em>${inline(g.emb, depth + 1, noLink)}</em>`);
    } else if (g.del !== undefined) {
      out.push(`<del>${inline(g.del, depth + 1, noLink)}</del>`);
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

/**
 * 自分の発言の本文（平文）を HTML にする。Markdown としては解釈せず、字は書いたとおりに残す（改行は CSS の pre-wrap）。
 * パスだけは AI の本文と同じ厳しい判定でファイルリンクにする: 地の文の Windows の絶対パスと、` で囲んだ中身全体が 1 つのパス
 * （` は書いたまま残し、中身だけをリンクにする）。docs/design-system.md「ファイルの操作」。返すのはエスケープ済みの HTML
 */
export function plainTextHtml(src) {
  const s = String(src ?? "");
  if (s.length > 100_000) return esc(s);
  const re = new RegExp(`(?<ticks>\`+)(?<code>[^\\n]{1,1024}?)\\k<ticks>(?!\`)|(?<win>${WINDOWS_PATH_SOURCE})`, "g");
  const out = [];
  let last = 0, m;
  while ((m = re.exec(s))) {
    const g = m.groups;
    if (g.code !== undefined) {
      const c = /^ .* $/s.test(g.code) ? g.code.slice(1, -1) : g.code;
      const ref = looksLikePath(c);
      if (!ref) continue;   // パスでない ` はそのまま（続きから読む）
      out.push(esc(s.slice(last, m.index)), esc(g.ticks), fileAnchor(ref, esc(g.code)), esc(g.ticks));
      last = re.lastIndex;
      continue;
    }
    const found = findWindowsPaths(g.win)[0];
    if (!found || found.start !== 0) { re.lastIndex = m.index + 1; continue; }
    out.push(esc(s.slice(last, m.index)), fileAnchor(found, esc(g.win.slice(0, found.end))));
    last = re.lastIndex = m.index + found.end;
  }
  out.push(esc(s.slice(last)));
  return out.join("");
}

/** snake_case の途中の _ を強調にしないための判定 */
function wordInner(s, at, delim) {
  return delim[0] === "_" && at > 0 && /[\w\u3040-\u30ff\u4e00-\u9fff]/.test(s[at - 1]);
}

/** リンク／画像を組み立てる。安全でない URL はリンクにせず、文字として出す */
function link(isImg, label, href, title, depth, noLink = false) {
  const raw = String(href ?? "").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, "$1");
  const tt = title ? ` title="${esc(title)}"` : "";
  if (isImg) {
    const u = safeImg(raw);
    // 外部 http(s) の画像は勝手に取りに行かない。リンクとして出す（設計メモ §7 の方針に揃える）
    if (u === null) return `<a class="md-link" href="${esc(safeUrl(raw) ?? "")}" target="_blank" rel="noopener noreferrer nofollow"${tt}>${inline(label, depth + 1, true)}</a>`;
    // ホストのファイルならパスを持たせ、下に所在の一行を添える（リンクの中では添えない）
    const file = u.startsWith("/local-file?") ? fileReference(u) : null;
    const img = `<img class="md-img" src="${esc(u)}" alt="${esc(label)}"${tt}${file ? ` data-file-path="${esc(file.path)}"` : ""} loading="lazy" referrerpolicy="no-referrer">`;
    return file && !noLink ? `<span class="md-figure">${img}${whereHtml(file.path)}</span>` : img;
  }
  const u = safeUrl(raw);
  const inner = inline(label, depth + 1, true);
  if (u === null) return `<span class="md-link-blocked" title="${esc(t("timeline.link.blocked"))}">${inner}</span>`;
  const file = fileReference(raw);
  if (file) return `<a class="md-link file-link" href="${esc(u)}" data-file-path="${esc(file.path)}"${file.line ? ` data-file-line="${file.line}"` : ''}${tt}>${inner}</a>`;  return `<a class="md-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow"${tt}>${inner}</a>`;
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
const HEIGHTS = [["small", 240], ["medium", 440], ["large", 760]];

// i18n-dynamic: timeline.present.kind.
// i18n-dynamic: timeline.present.height.
const kindLabel = (kind) => (kind === "html" ? "HTML" : t(`timeline.present.kind.${kind}`));

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
  cap.append(el("span", "present-kind", kindLabel(kind)));
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
      // コピーと保存は右パネル（⋯・下の行）と同じ処理を呼ぶ。知らせの文言も同じ（web/file-actions.mjs・web/visualize-frame.mjs）
      if (e.path) tool(copyIcon, t('timeline.present.copyPath')).onclick = () => copyPathText(String(e.path));

      // 保存されるのは会話に残っている HTML。元のファイルは変わっていることがある。
      // 会話には可視化がいくつも並ぶので、URL は押したときだけ作ってすぐ捨てる
      tool(downloadIcon, t('timeline.present.download')).onclick =
        () => downloadVisualization({ path: e.path, title: e.caption, content: e.content ?? '' });

      // 開くのは右のプレビューパネル。ここは会話に載る面だけを組み立て、
      // 開く側とは要求イベントで繋ぐ（ファイルリンクと同じ一枚の面に集める）。
      // at・id は会話の記録の印。右パネルの「ブラウザーで開く」がサーバーから写しを引く（core/server.mjs /visualization-snapshot）
      const expand = tool(sidePanelIcon, t('timeline.present.sidePanel'), 'visualize-expand');
      expand.onclick = () => expand.dispatchEvent(new CustomEvent('ply-visualize-expand', {
        bubbles: true, detail: { content: e.content ?? '', title: e.caption ?? '', path: e.path ?? '', at: e.at ?? null, id: e.id ?? null },
      }));
      cap.append(controls);
      if (e.mode === 'wide') card.classList.add('visualize-wide');
    }
  } else if (e.truncated) {
    body.append(el("div", "present-note", t("timeline.present.truncated")));
  } else if (kind === "image") {
    const src = presentImg(e.dataUri ?? e.path);
    if (src === null) body.append(el("div", "present-note", t("timeline.present.badImage")));
    else {
      const img = el("img");
      img.src = src;
      img.alt = e.caption ?? "";
      img.loading = "lazy";
      // パスを持たせる（拡大表示の下端・右クリックのメニューが使う）
      if (e.path && fileReference(String(e.path))) img.dataset.filePath = String(e.path);
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
      const b = el("button", "h-btn", t(`timeline.present.height.${label}`));
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

  // 元パスを小さく添える。ファイルリンクなので押すと右パネルで開き、⋯・右クリックで操作が出る
  if (e.path && kind !== "visualization") {
    const p = el("div", "present-path");
    const full = String(e.path), ref = fileReference(full);
    if (ref) {
      p.innerHTML = fileAnchor({ path: full, line: null }, `<code>${esc(full)}</code>`, " code-link") +
        `<button type="button" class="btn btn-icon file-more" data-file-menu="${esc(full)}" aria-haspopup="menu" aria-label="${esc(t("files.actionsFor", { name: baseName(full) }))}" title="${esc(t("files.actionsFor", { name: baseName(full) }))}">${moreIcon}</button>`;
    } else p.append(el("code", null, full));
    card.append(p);
  }  return card;
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

/**
 * パス。見せるのは末尾寄り、全体は title に持たせる（属性値なので解釈されない）。
 * 読む・書く・編集の対象は必ずファイルなので、ファイルリンクにする（押すと右パネル、右クリックで操作）
 */
function pathSpan(p, keep = 2) {
  const full = String(p ?? "");
  // <>"|*? はパスに入らない（入っていれば入力が壊れている）。リンクにせず文字のまま
  const ref = full && !/[<>"|*?]/.test(full) ? fileReference(full) : null;
  if (!ref) {
    const n = codeSpan(shortPath(full, keep) || t("timeline.tool.noPath"), "tc-main");
    if (full) n.title = full;
    return n;
  }
  const a = el("a", "tc-main tc-code file-link tc-file", shortPath(full, keep));
  // 押すと右パネルが横取りする。href は認証付きの配信の形にしておく（相対パスでもページ相対の URL を作らない）
  a.setAttribute("href", `/local-file?path=${encodeURIComponent(ref.path)}`);
  a.dataset.filePath = ref.path;
  if (ref.line) a.dataset.fileLine = String(ref.line);
  a.title = full;
  return a;
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

/** 開いた中身の 1 節。見出しの字と、こちらで組み立てた（エスケープ済みの）html */
function section(label, htmlOrNode) {
  const box = el("div", "tc-sec");
  box.append(el("div", "tc-section-label", label));
  if (typeof htmlOrNode === "string") { const b = el("div", "tc-sec-body"); b.innerHTML = htmlOrNode; box.append(b); }
  else box.append(htmlOrNode);
  return box;
}

/** 入力を「キー 値」の格子で見せる。スカラーはそのまま、入れ子は 1 行の JSON に。空なら null */
function kvGrid(inp) {
  const entries = Object.entries(inp ?? {}).filter(([, v]) => v != null);
  if (!entries.length) return null;
  const grid = el("div", "tc-kv");
  for (const [k, v] of entries.slice(0, 20)) {
    grid.append(el("span", "k", clip(k, 40)), el("span", "v", clip(typeof v === "object" ? JSON.stringify(v) : String(v), 300)));
  }
  return grid;
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

/** 記号の列（+ / −）と面の階調だけで見せる差分の枠。色は付けない（docs/design-system.md §2.2） */
function diffBox(oldS, newS) {
  const { del, add } = diffLines(oldS, newS);
  const box = el("div", "tc-diff");
  const put = (arr, cls, mark) => {
    for (const line of arr.slice(0, DIFF_MAX)) {
      const row = el("div", cls);
      row.append(el("span", "g", mark), el("span", null, clip(line, 400)));
      box.append(row);
    }
    if (arr.length > DIFF_MAX) box.append(el("div", "tc-diff-more", t("timeline.tool.diffMore", { count: arr.length - DIFF_MAX, n: fmtN(arr.length - DIFF_MAX) })));
  };
  put(del, "tc-del", "−");
  put(add, "tc-add", "+");
  return { box, del: del.length, add: add.length };
}

/** 差分の折りたたみ（MultiEdit の 1 箇所ごと） */
function diffFold(oldS, newS) {
  const { box, del, add } = diffBox(oldS, newS);
  const d = fold(t("timeline.tool.diff", { del: fmtN(del), add: fmtN(add) }));
  d.lastChild.append(box);
  return d;
}

/** 編集・書き込みが変えた量。まとまりの見出しの「N ファイルを変更」と、行の右端の「−2 +3」に使う。変えないツールは null */
export function toolChange(name, input) {
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const path = FILE_KEYS.map((k) => inp[k]).find((v) => typeof v === "string" && v);
  if (!path) return null;
  switch (String(name ?? "")) {
    case "Write": {
      const n = lineCount(inp.content);
      return { path, del: 0, add: n };
    }
    case "Edit": case "NotebookEdit": {
      const { del, add } = diffLines(inp.old_string, inp.new_string);
      return { path, del: del.length, add: add.length };
    }
    case "MultiEdit": {
      let del = 0, add = 0;
      for (const e of Array.isArray(inp.edits) ? inp.edits : []) {
        const d = diffLines(e?.old_string, e?.new_string);
        del += d.del.length; add += d.add.length;
      }
      return { path, del, add };
    }
    default: return null;
  }
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
  if (inp.run_in_background) notes.push(t("timeline.tool.background"));
  if (inp.description) notes.push(String(inp.description));
  if (notes.length) head.append(noteSpan(notes.join(" · ")));

  if (folded) card.append(section(t("timeline.tool.fullCommand", { count: lineCount(cmd), n: fmtN(lineCount(cmd)) }), codeBlock(clip(cmd, 8000), "bash")));
}

function drawRead(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const bits = [];
  if (inp.pages) bits.push(`p.${clip(inp.pages, 20)}`);
  const off = Number(inp.offset);
  const lim = Number(inp.limit);
  if (Number.isFinite(off) && Number.isFinite(lim)) bits.push(t("timeline.tool.lineRange", { from: fmtN(off), to: fmtN(off + lim) }));
  else if (Number.isFinite(lim)) bits.push(t("timeline.tool.firstLines", { count: lim, n: fmtN(lim) }));
  else if (Number.isFinite(off)) bits.push(t("timeline.tool.fromLine", { n: fmtN(off) }));
  if (bits.length) head.append(noteSpan(bits.join(" · ")));
}

function drawWrite(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const body = String(inp.content ?? "");
  if (body) card.append(diffBox("", body).box);
}

function drawEdit(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const a = String(inp.old_string ?? "");
  const b = String(inp.new_string ?? "");
  if (inp.replace_all) head.append(noteSpan(t("timeline.tool.replaceAll")));
  if (a || b) card.append(diffBox(a, b).box);
}

function drawMultiEdit(card, head, inp) {
  head.append(pathSpan(inp.file_path));
  const edits = Array.isArray(inp.edits) ? inp.edits : [];
  head.append(noteSpan(t("timeline.tool.edits", { count: edits.length, n: fmtN(edits.length) })));
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

// i18n-dynamic: timeline.tool.grepMode.
const GREP_MODE = { content: "content", files_with_matches: "files", count: "count" };

function drawGrep(card, head, inp) {
  head.append(codeSpan(clip(inp.pattern ?? "", 160), "tc-main"));
  const bits = [];
  if (inp.path) bits.push(shortPath(inp.path, 2));
  if (inp.glob) bits.push(String(inp.glob));
  if (inp.type) bits.push(String(inp.type));
  if (GREP_MODE[inp.output_mode]) bits.push(t(`timeline.tool.grepMode.${GREP_MODE[inp.output_mode]}`));
  if (inp["-i"]) bits.push(t("timeline.tool.ignoreCase"));
  if (inp.multiline) bits.push(t("timeline.tool.multiline"));
  const ctx = inp["-C"] ?? inp.context ?? inp["-A"] ?? inp["-B"];
  if (ctx != null && Number.isFinite(Number(ctx))) bits.push(t("timeline.tool.context", { count: Number(ctx), n: fmtN(ctx) }));
  if (inp.head_limit) bits.push(t("timeline.tool.headLimit", { n: fmtN(inp.head_limit) }));
  if (bits.length) head.append(noteSpan(bits.join(" · "), inp.path ? String(inp.path) : null));
}

function drawTask(card, head, inp) {
  head.append(textMain(inp.description || t("timeline.tool.subagent")));
  const bits = [];
  for (const k of ["subagent_type", "name", "model", "isolation"]) {
    if (inp[k]) bits.push(String(inp[k]));
  }
  if (bits.length) head.append(noteSpan(bits.join(" · ")));
  if (inp.prompt) card.append(foldCode(t("timeline.tool.prompt"), String(inp.prompt), "md"));
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
    head.append(noteSpan((inp.allowed_domains ? t("timeline.tool.domainsAllowed", { domains: clip(dom.join(", "), 60) }) : t("timeline.tool.domainsBlocked", { domains: clip(dom.join(", "), 60) }))));
  }
}

const TODO_MARK = { completed: "✓", in_progress: "▸", pending: "・" };

function drawTodo(card, head, inp) {
  const todos = Array.isArray(inp.todos) ? inp.todos : [];
  const cur = todos.find((t) => t?.status === "in_progress");
  const done = todos.filter((t) => t?.status === "completed").length;
  head.append(textMain(cur ? String(cur.activeForm || cur.content || "") : t("timeline.tool.todoCount", { count: todos.length, n: fmtN(todos.length) })));
  head.append(noteSpan(t("timeline.tool.todoDone", { done: fmtN(done), total: fmtN(todos.length) })));

  if (!todos.length) return;
  const d = fold(t("timeline.tool.todoItems", { n: fmtN(todos.length) }));
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

function drawPresent(card, head, inp) {
  const cap = String(inp.caption ?? "").trim();
  head.append(cap ? textMain(cap) : pathSpan(inp.path));
  const bits = [["image", "html", "text", "file", "visualization"].includes(inp.kind) ? kindLabel(inp.kind) : String(inp.kind ?? "")];
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
  head.append(textMain(inp.title ? `→ ${String(inp.title)}` : t("timeline.tool.forkHere")));
  if (inp.reason) head.append(noteSpan(clip(inp.reason, 80), String(inp.reason)));
}

/** mcp__<server>__<tool>。サーバ名とツール名を分けて見せる */
function drawMcp(card, head, inp, name) {
  const parts = String(name).split("__");
  head.append(el("span", "tc-server", parts[1] ?? ""));
  head.append(textMain(parts.slice(2).join("__") || name));
  const s = summarizeInput(inp);
  if (s) head.append(noteSpan(s));
  // ply_delegate の中身は client.mjs が依頼と内訳で描く（キーと値の格子にしない）
  const grid = isDelegateToolName(name) ? null : kvGrid(inp);
  if (grid) card.append(grid);
}

function drawUnknown(card, head, inp) {
  const s = summarizeInput(inp);
  if (s) head.append(textMain(s));
  const grid = kvGrid(inp);
  if (grid) card.append(grid);
}

// 動詞で揃える。並んだときに「何をしたか」が縦に読める
const TOOL_LABEL = {
  Bash: t("timeline.tool.label.run"), PowerShell: t("timeline.tool.label.run"), Read: t("timeline.tool.label.read"),
  Write: t("timeline.tool.label.write"), Edit: t("timeline.tool.label.edit"),
  MultiEdit: t("timeline.tool.label.edit"), NotebookEdit: t("timeline.tool.label.edit"),
  Glob: t("timeline.tool.label.find"), Grep: t("timeline.tool.label.grep"),
  Task: t("timeline.tool.label.delegate"), Agent: t("timeline.tool.label.delegate"),
  WebFetch: t("timeline.tool.label.fetch"), WebSearch: t("timeline.tool.label.webSearch"), TodoWrite: "TODO",
  mcp__ply__present: t("timeline.tool.label.present"), mcp__host__present: t("timeline.tool.label.present"),
  mcp__host__set_status: t("timeline.tool.label.status"),
  mcp__host__set_title: t("timeline.tool.label.title"), mcp__host__fork: t("timeline.tool.label.fork"),
};

// 稼働表示の「実行中 · npm test」の動詞（活動の字。一覧の動詞 TOOL_LABEL とは別に「〜している」の形を持つ）
// i18n-dynamic: activity.doing.
const TOOL_DOING = {
  Bash: "run", PowerShell: "run", Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Glob: "find", Grep: "grep", WebFetch: "fetch", WebSearch: "webSearch",
};
/** ツール名 -> 「実行中」「読んでいる」など。知らないツールは null */
export const toolDoing = (name) => (TOOL_DOING[name] ? t(`activity.doing.${TOOL_DOING[name]}`) : null);

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

// 対象がファイルのツール（見出しにファイルリンクを添える）と、入力の中でパスを持つキー（エージェントごとに名前が違う）
const FILE_DRAWS = new Set([drawRead, drawWrite, drawEdit, drawMultiEdit]);
const FILE_KEYS = ["file_path", "notebook_path", "path", "AbsolutePath", "TargetFile"];

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

/** 委譲のツール（Task / Agent / ply_delegate）。右端の状態は client.mjs が子の状態で描くので、結果の要約は出さない */
export const isDelegateToolName = (name) => /^(Task|Agent)$/.test(String(name ?? "")) || /(^|[_./])ply_delegate$/.test(String(name ?? ""));

/**
 * ツール呼び出しを 1 行にし、開くとツールごとの中身（差分・出力の末尾・ファイル一覧・キーと値）を読めるようにする。
 * 1 行は「動詞・主役・補足・右端に結果・開閉の印」。生の入力・出力は奥の「入力・出力（JSON）」の折りたたみに残す。
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
  // 1 行目は tc-line に積む（失敗の要点・委譲の行き先は、その下の行として head に足す）
  const line = el("span", "tc-line");
  head.append(line);
  line.append(el("span", "tc-label", TOOL_LABEL[raw] ?? (raw.startsWith("mcp__") ? "MCP" : clip(raw, 24))));

  // 描き分け。対象がファイルのツールは、バックエンドごとに違うパスのキーを file_path に揃えて渡す
  // （押すと右パネル、右クリックで操作。docs/design-system.md「ファイルの操作」）
  const draw = TOOL_DRAW[raw] ?? (raw.startsWith("mcp__") ? drawMcp : drawUnknown);
  let drawInp = inp;
  if (FILE_DRAWS.has(draw) && !inp.file_path) {
    const target = FILE_KEYS.map((k) => inp[k]).find((v) => typeof v === "string" && v);
    if (target) drawInp = { ...inp, file_path: target };
  }
  draw(body, line, drawInp, raw);
  card.toolChange = toolChange(raw, drawInp);

  // 右端: 結果（走っている間は弧と経過秒。web/tool-bundle.mjs）。続けて開閉の印
  line.append(el("span", "tc-res"));
  line.append(chevron());

  const json = el("details", "tc-fold tc-json");
  json.append(el("summary", null, t("routing.detail.json")));
  const jsonBody = el("div", "tc-json-body");
  jsonBody.append(el("div", "tc-section-label", t("timeline.tool.input")));
  const inputBody = el("div", "tc-input");
  inputBody.innerHTML = codeBlock(JSON.stringify(inp, null, 2), "json");
  jsonBody.append(inputBody);
  json.append(jsonBody);
  body.append(json);
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

/** 結果の要約（右端）。全文は出さない。行数・件数・変えた量だけ分かればよい */
function summarizeResult(tool, body, n, change) {
  const out = body.trim();
  if (!out && !change) return t("timeline.result.empty");
  if (/^No (matches|files) found/i.test(out)) return t("timeline.result.count", { count: 0, n: fmtN(0) });
  const found = /^Found (\d+) /.exec(out);
  if (found) return t("timeline.result.count", { count: Number(found[1]), n: fmtN(found[1]) });

  switch (tool) {
    case "Glob": return t("timeline.result.count", { count: n, n: fmtN(n) });
    case "Write":
      return change ? t("timeline.result.lines", { count: change.add, n: fmtN(change.add) }) : t("timeline.result.saved");
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return change ? `${change.del ? `−${fmtN(change.del)} ` : ""}+${fmtN(change.add)}` : t("timeline.result.edited");
    case "TodoWrite": return t("timeline.result.updated");
    default:
      // このアプリのツールは「〜した」という短い返事を返すので、それをそのまま見せる
      if (String(tool ?? "").startsWith("mcp__")) return out.length <= 60 ? clip(firstLine(out), 60) : t("timeline.result.ran");
      return t("timeline.result.lines", { count: n, n: fmtN(n) });
  }
}

/** 終了コード。出力の中の「Exit code 1」「exit status 2」「exited with code 3」の最後のもの。分からなければ null */
export function exitCodeOf(body) {
  let code = null;
  for (const m of String(body ?? "").matchAll(/\bexit(?:ed)?(?: with)?(?: status| code)?[:\s]+(\d{1,3})\b/gi)) code = Number(m[1]);
  return code;
}

/** 失敗の要点の 1 行。出力の中の Error: などの行、無ければ最後の空でない行 */
export function failureLine(body) {
  const lines = String(body ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const hit = lines.find((l) => /^(?:[\w.]*Error\b|error\b|fatal\b|FAIL\b|Traceback|panic\b|npm ERR!)/.test(l));
  return clip(hit ?? lines.at(-1), 200);
}

const TAIL_LINES = 6;   // 実行の出力を開いたときに出す末尾の行数

/** 実行の出力: 末尾 N 行と「全 N 行を表示」 */
function outputTail(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const box = el("div", "tc-res-view tc-tail");
  const tail = lines.length > TAIL_LINES;
  const label = el("div", "tc-section-label", tail ? t("timeline.result.tail", { count: TAIL_LINES, n: fmtN(TAIL_LINES) }) : t("timeline.result.output"));
  const code = el("div", "tc-output");
  const shown = tail ? lines.slice(-TAIL_LINES) : lines;
  while (shown.length > 1 && !shown[0].trim()) shown.shift();   // 末尾で切った先頭が空行なら落とす
  code.innerHTML = codeBlock(shown.join("\n"), "");
  if (tail) {
    const more = el("button", "btn tc-more", t("timeline.result.showAll", { count: lines.length, n: fmtN(lines.length) }));
    more.type = "button";
    more.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      code.innerHTML = codeBlock(clip(lines.join("\n"), 20000), "");
      label.firstChild.textContent = t("timeline.result.output");
      more.remove();
    };
    label.append(more);
  }
  box.append(label, code);
  return box;
}

/** 検索・探すの結果: 全部がファイルのパスなら、ファイルリンクの一覧。そうでなければ null */
function fileList(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(Found \d+|No (matches|files) found|\(?[Tt]runcated)/.test(l));
  if (!lines.length || lines.some((l) => !looksLikePath(l))) return null;
  const list = el("ul", "tc-res-view tc-files");
  for (const l of lines.slice(0, 40)) {
    const li = el("li");
    li.append(pathSpan(l, 4));
    list.append(li);
  }
  if (lines.length > 40) list.append(el("li", "tc-diff-more", t("timeline.tool.diffMore", { count: lines.length - 40, n: fmtN(lines.length - 40) })));
  return list;
}

/**
 * renderToolCall が作った要素に結果を反映する。**全文は出さない。**
 * 右端に要約、失敗は太字の「✕ 失敗 · exit 1」と要点の 1 行。開いた中はツールごとの見せ方で、生の出力は「入力・出力（JSON）」の奥。
 * @param {HTMLElement} node renderToolCall の戻り
 * @param {{text?:string, isError?:boolean, truncated?:boolean}|string|null} result
 * @returns {HTMLElement} node
 */
export function applyToolResult(node, result) {
  if (!node || typeof node.querySelector !== "function") return node;

  // 呼び直されても二重に付かないよう、前回の結果を落としてから積む
  for (const old of [...node.querySelectorAll(".tc-out, .tc-preview, .tc-res-view, .tc-errline")]) old.remove();
  node.classList.remove("tc-error", "tc-done", "tc-running", "tc-waiting");
  const resEl = node.querySelector(".tc-res");
  if (resEl) { resEl.textContent = ""; resEl.className = "tc-res"; resEl.paint = null; delete resEl.dataset.sig; }
  if (result == null) return node;

  const head = node.querySelector(".tc-head") ?? node;
  const tool = node.dataset?.tool ?? "";
  const body = resultText(result);
  // 人が承認を拒否したツールは失敗ではない（✕ にせず、見出しの「✕ n」にも数えない。web/client.mjs の rowApprovalCard が印を付ける）
  const denied = node.dataset?.denied === "1";
  const isError = Boolean(result?.isError ?? result?.is_error) && !denied;
  const cut = Boolean(result?.truncated);
  const delegate = isDelegateToolName(tool);
  const draw = TOOL_DRAW[tool];

  node.classList.add(isError ? "tc-error" : "tc-done");
  if (resEl) {
    if (isError) {
      // 失敗は記号と太字で。色は付けない（差し色は「あなたを待っている」だけ）
      const code = exitCodeOf(body);
      resEl.className = "tc-res tc-res-err";
      resEl.textContent = code != null && code !== 0 ? t("timeline.result.failedExit", { code }) : t("timeline.result.failed");
      const why = failureLine(body);
      if (why && !delegate) { const line = el("span", "tc-errline", why); line.title = why; head.append(line); }
    } else if (denied) {
      resEl.textContent = t("chat.approval.denied");
    } else if (!delegate) {
      resEl.textContent = summarizeResult(tool, body, lineCount(body), node.toolChange);
    }
  }

  // 開いた中。出力の見せ方はツール別（実行 = 末尾、検索・探す = ファイル一覧）。生の出力は JSON の折りたたみへ
  const detailsBody = node.querySelector(".tc-details-body");
  const jsonFold = node.querySelector(".tc-json");
  const view = !body ? null : draw === drawShell ? outputTail(body) : (draw === drawGlob || draw === drawGrep) ? fileList(body) : null;
  if (view && detailsBody) { if (jsonFold) jsonFold.before(view); else detailsBody.append(view); }

  const output = el("div", "tc-out");
  output.append(el("div", "tc-section-label", (cut ? t("timeline.result.outputPartial") : t("timeline.result.output"))));
  const code = el("div", "tc-output");
  code.innerHTML = codeBlock(body || t("timeline.result.empty"), "");
  output.append(code);
  // 委譲・処理済みの見せ方があるツールは、生の出力を「入力・出力（JSON）」の折りたたみの奥へ。それ以外は開いた中にそのまま
  const raw = node.querySelector(".tc-json-body");
  if (raw && (delegate || view)) raw.append(output);
  else if (jsonFold) jsonFold.before(output);
  else (detailsBody ?? node).append(output);
  for (const img of result?.images ?? []) {
    const src = presentImg(img.url ?? img.dataUri ?? "");
    if (!src) continue;
    const preview = el("div", "tc-preview");
    const picture = document.createElement("img");
    picture.setAttribute("src", src);
    picture.setAttribute("alt", img.caption || t("timeline.result.generatedImage"));
    picture.setAttribute("loading", "lazy");
    preview.append(picture);
    // 保存先が分かる画像（Codex の savedPath、/local-file の URL）はパスを持たせ、所在の一行を添える
    const file = img.path ? fileReference(String(img.path)) : src.startsWith("/local-file?") ? fileReference(src) : null;
    if (file) {
      picture.dataset.filePath = file.path;
      const where = el("div");
      where.innerHTML = whereHtml(file.path);
      preview.append(where);
    }
    node.append(preview);
  }
  return node;
}
