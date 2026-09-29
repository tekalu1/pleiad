// サイトを配る形に組む。日本語（site/index.html）を根に、英語（locales/en.json から作る）を en/ に置く。
// 訳す要素は index.html に data-i18n="キー"（中身を置き換える）・data-i18n-attr="属性:キー;…"（属性を置き換える）で付ける。
// 中身は locales/en.json の値（HTML）。{claude} {openai} {antigravity} は各ロゴの <img> に展開する。
//
//     node site/tools/build-site.mjs [--out <出力先>]   # 既定は _site/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 公開先の URL（canonical・hreflang・og:url・og:image の元）。末尾は /
export const SITE_URL = "https://pleiad.dev/";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = {
  ja: { dir: "", locale: "ja_JP", ogImage: "assets/og.png" },
  en: { dir: "en/", locale: "en_US", ogImage: "assets/og-en.png" },
};
// 出力先へ写さないもの（生成の材料）
const SKIP = new Set(["tools", "locales", "README.md", "index.html", "wrangler.jsonc"]);
const LOGOS = {
  claude: '<img src="assets/claude.svg" alt="" width="16" height="16">',
  openai: '<img src="assets/openai.svg" alt="" width="16" height="16">',
  antigravity: '<img src="assets/antigravity.svg" alt="" width="16" height="16">',
};

const escText = (s) => s.replace(/&(?!#?\w+;)/g, "&amp;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// 開きタグ。属性の値の中の > は数えない
const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?)>/g;

/** name の閉じタグの直前の位置と、閉じタグの終わりを返す（同じ名前の入れ子を数える） */
function findClose(html, name, from) {
  const re = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (!depth) return { start: m.index, end: re.lastIndex };
  }
  throw new Error(`<${name}> の閉じタグが見つからない（${html.slice(from - 80, from)}）`);
}

function setAttr(attrs, name, value) {
  const re = new RegExp(`(\\s${name}=)"[^"]*"`);
  return re.test(attrs) ? attrs.replace(re, `$1"${escAttr(value)}"`) : `${attrs} ${name}="${escAttr(value)}"`;
}

/** data-i18n 系の属性を解いて、辞書があれば置き換える。dict が null なら（日本語）属性を外すだけ */
export function localize(html, dict) {
  let out = "";
  let pos = 0;
  OPEN_TAG.lastIndex = 0;
  for (let m; (m = OPEN_TAG.exec(html)); ) {
    let [tag, name, attrs = ""] = m;
    if (!/\sdata-i18n(-attr|-json)?=/.test(attrs)) continue;
    const key = attrs.match(/\sdata-i18n="([^"]+)"/)?.[1];
    const attrMap = attrs.match(/\sdata-i18n-attr="([^"]+)"/)?.[1];
    const json = attrs.match(/\sdata-i18n-json="([^"]+)"/)?.[1];
    attrs = attrs.replace(/\sdata-i18n(-attr|-json)?="[^"]*"/g, "");
    out += html.slice(pos, m.index);
    let content = null;
    if (dict) {
      if (attrMap) {
        for (const pair of attrMap.split(";")) {
          const [attr, k] = pair.split(":");
          if (dict[k] == null) throw new Error(`辞書に無いキー: ${k}`);
          attrs = setAttr(attrs, attr, dict[k]);
        }
      }
      if (key) {
        if (dict[key] == null) throw new Error(`辞書に無いキー: ${key}`);
        content = escText(dict[key].replace(/\{(\w+)\}/g, (all, n) => LOGOS[n] ?? all));
      }
      if (json) {
        if (dict[json] == null) throw new Error(`辞書に無いキー: ${json}`);
        // </script> を閉じさせない
        content = "\n" + JSON.stringify(dict[json], null, 2).replace(/</g, "\\u003c") + "\n";
      }
    }
    out += `<${name}${attrs}>`;
    pos = OPEN_TAG.lastIndex;
    if (content != null) {
      const close = findClose(html, name, pos);
      out += content;
      pos = close.start;
      OPEN_TAG.lastIndex = close.start;
    }
  }
  return out + html.slice(pos);
}

function headTags(lang) {
  const L = LANGS[lang];
  const other = lang === "ja" ? "en" : "ja";
  return [
    `<link rel="canonical" href="${SITE_URL}${L.dir}">`,
    `<link rel="alternate" hreflang="ja" href="${SITE_URL}">`,
    `<link rel="alternate" hreflang="en" href="${SITE_URL}${LANGS.en.dir}">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}">`,
    `<meta property="og:url" content="${SITE_URL}${L.dir}">`,
    `<meta property="og:locale" content="${L.locale}">`,
    `<meta property="og:locale:alternate" content="${LANGS[other].locale}">`,
    `<meta property="og:image" content="${SITE_URL}${L.ogImage}">`,
  ].join("\n");
}

// 言語の切り替え: 地球のアイコンと今の言語の名前。開くと各言語をその言語の名前で並べる
function langSwitch(lang) {
  const ja = lang === "ja";
  const item = (code, href, name) =>
    `<a href="${href}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ""}>${name}</a>`;
  return [
    '<details class="lang">',
    `  <summary class="lang-btn" aria-label="${ja ? "言語" : "Language"}"><svg aria-hidden="true"><use href="#i-globe"/></svg><span class="lang-cur">${ja ? "日本語" : "English"}</span><svg class="lang-chev" aria-hidden="true"><use href="#i-chev"/></svg></summary>`,
    '  <div class="lang-menu">',
    `    ${item("ja", ja ? "./" : "../", "日本語")}`,
    `    ${item("en", ja ? "en/" : "./", "English")}`,
    "  </div>",
    "</details>",
  ].join("\n");
}

export function renderPage(source, lang, dict) {
  let html = source.replace(/\r\n/g, "\n");
  html = html.replace("<!-- i18n:head -->", () => headTags(lang));
  html = html.replace("<!-- i18n:lang-switch -->", () => langSwitch(lang));
  // 言語を限った要素（日本語だけの書体の先読みなど）
  html = html.replace(/<link data-only="(\w+)"([^>]*)>\n?/g, (all, only, rest) => (only === lang ? `<link${rest}>\n` : ""));
  html = localize(html, lang === "ja" ? null : dict);
  html = html.replace(/<html lang="ja">/, `<html lang="${lang}">`);
  if (lang !== "ja") {
    // en/ から見た共有の資源
    html = html.replace(/\b(src|href)="(assets\/|styles\.css|main\.js|hero\.js|branch\.js)/g, '$1="../$2');
  }
  return html;
}

function copyShared(out) {
  for (const name of fs.readdirSync(SITE)) {
    if (SKIP.has(name)) continue;
    fs.cpSync(path.join(SITE, name), path.join(out, name), { recursive: true });
  }
}

export function build(out) {
  const source = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(SITE, "locales", "en.json"), "utf8"));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "en"), { recursive: true });
  copyShared(out);
  fs.writeFileSync(path.join(out, "index.html"), renderPage(source, "ja", null));
  fs.writeFileSync(path.join(out, "en", "index.html"), renderPage(source, "en", en));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(SITE, "..", "_site"));
  build(out);
  console.log(`built ${out} (ja: /, en: /en/)`);
}
