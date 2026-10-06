// 英語の辞書と index.html の突き合わせ。生成前に流す。
//   ・index.html の data-i18n のキーがすべて locales/en.json にある
//   ・en.json に使われていないキーが無い
//   ・<script id="strings"> のキーが、日本語と英語で同じ
//   ・生成した英語のページにかな・漢字が残っていない（日本語への切り替えのリンクは除く）
//   ・JS の中に日本語の文言が残っていない（コメントは除く）
//
//     node site/tools/check-i18n.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./build-site.mjs";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(SITE, "index.html"), "utf8").replace(/\r\n/g, "\n");
const en = JSON.parse(fs.readFileSync(path.join(SITE, "locales", "en.json"), "utf8"));
const errors = [];
const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

// 使っているキー
const used = new Set();
const jsonBlocks = new Set();
for (const [, value] of source.matchAll(/\sdata-i18n="([^"]+)"/g)) used.add(value);
for (const [, value] of source.matchAll(/\sdata-i18n-attr="([^"]+)"/g)) {
  for (const pair of value.split(";")) used.add(pair.split(":")[1]);
}
for (const [, value] of source.matchAll(/\sdata-i18n-json="([^"]+)"/g)) { used.add(value); jsonBlocks.add(value); }

for (const key of used) {
  if (!(key in en)) errors.push(`index.html のキーが en.json に無い: ${key}`);
}
for (const key of Object.keys(en)) {
  if (!used.has(key)) errors.push(`en.json のキーが index.html で使われていない: ${key}`);
}

// JS が読む文言（<script id="strings">）
const ja = JSON.parse(source.match(/<script type="application\/json" id="strings"[^>]*>([\s\S]*?)<\/script>/)[1]);
const jaKeys = Object.keys(ja).sort().join(",");
const enKeys = Object.keys(en.strings ?? {}).sort().join(",");
if (jaKeys !== enKeys) errors.push(`strings のキーが日本語と英語で違う\n  ja: ${jaKeys}\n  en: ${enKeys}`);
for (const [key, value] of Object.entries(en.strings ?? {})) {
  if (CJK.test(value)) errors.push(`strings.${key} に日本語が残っている: ${value}`);
}

// 生成した英語のページ
for (const [key, value] of Object.entries(en)) {
  if (typeof value !== "string") continue;
  for (const [, token] of value.matchAll(/\{(\w+)\}/g)) {
    if (!["claude", "openai", "antigravity"].includes(token)) errors.push(`en.json の ${key} に知らない {${token}} がある`);
  }
}
const page = renderPage(source, "en", en);
const visible = page.replace(/<a [^>]*lang="ja"[^>]*>[^<]*<\/a>/g, "");
visible.split("\n").forEach((line, i) => {
  if (CJK.test(line)) errors.push(`英語のページに日本語が残っている（${i + 1} 行）: ${line.trim().slice(0, 100)}`);
});
if (/\{(claude|openai|antigravity)\}|data-i18n/.test(page)) errors.push("英語のページに展開されていない印が残っている");
if (!/<html lang="en">/.test(page)) errors.push('英語のページの <html lang="en"> が無い');

// 文章のページ（辞書を使わず、日本語と英語を別のファイルで持つ）: 対があり、英語の側に日本語が残っていない（日本語への切り替えのリンクは除く）
for (const rel of ["privacy/index.html"]) {
  const jaFile = path.join(SITE, rel);
  const enFile = path.join(SITE, "en", rel);
  if (!fs.existsSync(jaFile) || !fs.existsSync(enFile)) {
    errors.push(`文章のページの対が無い: ${rel} と en/${rel}`);
    continue;
  }
  if (!/<html lang="ja">/.test(fs.readFileSync(jaFile, "utf8"))) errors.push(`${rel} の <html lang="ja"> が無い`);
  const enPage = fs.readFileSync(enFile, "utf8");
  if (!/<html lang="en">/.test(enPage)) errors.push(`en/${rel} の <html lang="en"> が無い`);
  enPage.replace(/<a [^>]*lang="ja"[^>]*>[^<]*<\/a>/g, "").split(/\r?\n/).forEach((line, i) => {
    if (CJK.test(line)) errors.push(`en/${rel} に日本語が残っている（${i + 1} 行）: ${line.trim().slice(0, 100)}`);
  });
}

// JS の中の文言
for (const name of ["main.js", "hero.js", "branch.js"]) {
  const code = fs.readFileSync(path.join(SITE, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  code.split(/\r?\n/).forEach((line, i) => {
    if (CJK.test(line)) errors.push(`${name} に日本語の文言が残っている（${i + 1} 行）: ${line.trim().slice(0, 100)}`);
  });
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${used.size} keys, strings ${Object.keys(ja).length}`);
