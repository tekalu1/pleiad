// 指示の量の面の「気になる所」（ADR 0056「② 気になる所を知らせる」、docs/context-runtime.md「気になる所」）。
// 毎ターン最初に読み込む指示ファイルから、次の 2 つだけを見つける。どちらも文の意味は読まない（言語に依存しない構造だけ）。
//   - 重複: 違うファイルに、ほぼ同じ段落（Markdown のブロック）があるもの。記号と空白をならした文字の n-gram の Jaccard 係数で比べる
//   - 無いパス: この場所と親フォルダーの指示の中の、バッククォートで囲んだ相対パスで、Git のルートから見て存在しないもの
// 右パネルを開いたときに計算する。保存しない。ファイルは書き換えない
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathKey } from './context-settings.mjs';
import { MAX_FILE, MAX_TOTAL, MAX_ENTRIES } from './context-scan.mjs';

/** 比べるブロックの最短（ならした後の文字数）。見出しや短い箇条（「npm test を実行する」など）は偶然そろうので比べない */
export const DUPLICATE_MIN_CHARS = 40;
/** 近さを測る文字の n-gram の長さ。日本語は 1 文字が 1 語に近く、英語は単語をまたぐので、どちらでも効く長さにする */
export const DUPLICATE_GRAM = 5;
/**
 * これ以上なら重複とみなす Jaccard 係数。架空の文で測った値（tests/unit/context-findings.mjs）: 語を少し変えた写しは 0.7〜0.9、
 * 写しに 2 文を書き足したものは 0.55、同じ話題の別の段落・書き出しだけ同じ段落は 0.2 未満。書き足した写しまで入れ、別の段落との間を空ける
 */
export const DUPLICATE_THRESHOLD = 0.5;
/** 出す件数の上限（種類ごと）。超えた分は数だけ返す */
export const MAX_FINDINGS = 20;
/** 比べるブロックの上限と、存在を確かめるパスの上限（パネルを開くたびに走るので重くしない） */
const MAX_BLOCKS = 5000, MAX_PATH_CHECKS = 500;
/** 引用として返す字数の上限 */
const MAX_QUOTE = 600;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const TABLE = /^\s*\|/;
const IMPORT = /^\s*@(?:"[^"]+"|\S+)\s*$/;

/**
 * Markdown をブロック（段落・箇条の 1 項目・見出し・表の 1 行）に分ける。先頭の frontmatter とコードブロックは除く。
 * 戻り: [{ text, line }]。text は行頭の空白と箇条の印を落として 1 行につないだもの、line は始まりの行（1 から）
 */
export function markdownBlocks(content) {
  const lines = String(content ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocks = [];
  let current = null, fence = null, i = 0;
  const close = () => { if (current) { const text = current.parts.join(' ').trim(); if (text) blocks.push({ text, line: current.line }); } current = null; };
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, n) => n > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) { if (line.trim().startsWith(fence)) fence = null; continue; }
    const f = FENCE.exec(line);
    if (f) { close(); fence = f[1]; continue; }
    if (!line.trim() || IMPORT.test(line)) { close(); continue; }
    if (HEADING.test(line) || TABLE.test(line)) { close(); blocks.push({ text: line.trim(), line: i + 1 }); continue; }
    const item = ITEM.exec(line);
    if (item) { close(); current = { line: i + 1, parts: [line.slice(item[0].length).trim()] }; continue; }
    if (!current) current = { line: i + 1, parts: [] };
    current.parts.push(line.trim());
  }
  close();
  return blocks;
}

/** 文字と数字だけを残して小文字にしたもの（NFKC で全角・半角をそろえる）と、その 1 文字ごとの元の位置 */
export function normalized(text) {
  let norm = '';
  const at = [];
  let i = 0;
  for (const ch of String(text)) {
    for (const c of ch.normalize('NFKC').toLowerCase()) {
      if (/[\p{L}\p{N}]/u.test(c)) { norm += c; at.push(i); }
    }
    i += ch.length;
  }
  return { norm, at };
}

function gramsOf(norm, n = DUPLICATE_GRAM) {
  const set = new Set();
  const chars = [...norm];
  for (let i = 0; i + n <= chars.length; i++) set.add(chars.slice(i, i + n).join(''));
  return set;
}

/** 2 つの文の近さ（ならした文字の n-gram の Jaccard 係数。0〜1） */
export function similarity(a, b) {
  const x = gramsOf(normalized(a).norm), y = gramsOf(normalized(b).norm);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / (x.size + y.size - common);
}

/**
 * 文を「共通の部分」と「そうでない部分」に切る（画面が共通の部分を太字にする）。
 * shared は相手と共通の n-gram。共通の n-gram に覆われた文字と、その間の記号・空白を共通とする
 */
function segments(text, shared) {
  const { norm, at } = normalized(text);
  const chars = [...norm];
  const marked = new Array(chars.length).fill(false);
  for (let i = 0; i + DUPLICATE_GRAM <= chars.length; i++) {
    if (shared.has(chars.slice(i, i + DUPLICATE_GRAM).join(''))) for (let k = i; k < i + DUPLICATE_GRAM; k++) marked[k] = true;
  }
  const flag = new Array(text.length).fill(false);
  for (let j = 0; j < chars.length; j++) {
    if (!marked[j]) continue;
    // 元の 1 文字（サロゲートペアは 2 単位）を覆う。次の共通の文字までの記号・空白も共通に含める
    const end = j + 1 < chars.length && marked[j + 1] ? at[j + 1] : at[j] + (text.codePointAt(at[j]) > 0xffff ? 2 : 1);
    for (let p = at[j]; p < end; p++) flag[p] = true;
  }
  const out = [];
  for (let p = 0; p < text.length; p++) {
    const last = out.at(-1);
    if (last && last.common === flag[p]) last.text += text[p];
    else out.push({ text: text[p], common: flag[p] });
  }
  return out;
}

const quote = text => (text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text);

/**
 * 違うファイルどうしで、ほぼ同じブロックを探す。
 * files: [{ path, scope, root?, content }]（同じ実体のファイルは呼ぶ側で 1 つにしておく）
 * 戻り: { items: [{ score, sides: [{ path, scope, root, line, segments }, …] }], more }（近い順。more は上限を超えて出さなかった件数）
 */
export function findDuplicates(files) {
  const blocks = [];
  files.forEach((file, f) => {
    for (const b of markdownBlocks(file.content)) {
      if (blocks.length >= MAX_BLOCKS) return;
      const { norm } = normalized(b.text);
      if ([...norm].length < DUPLICATE_MIN_CHARS) continue;
      blocks.push({ ...b, file: f, grams: gramsOf(norm) });
    }
  });
  // 共通の n-gram の数を、n-gram ごとの索引で数える（違うファイルのブロックだけ）
  const index = new Map(), pairs = [];
  blocks.forEach((b, i) => {
    const counts = new Map();
    for (const g of b.grams) {
      const list = index.get(g);
      if (list) for (const j of list) if (blocks[j].file !== b.file) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    for (const [j, common] of counts) {
      const score = common / (b.grams.size + blocks[j].grams.size - common);
      if (score >= DUPLICATE_THRESHOLD) pairs.push({ a: j, b: i, score });
    }
    for (const g of b.grams) { const list = index.get(g); if (list) list.push(i); else index.set(g, [i]); }
  });
  pairs.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  const side = (b, other) => {
    const file = files[b.file];
    const shared = new Set([...b.grams].filter(g => other.grams.has(g)));
    return { path: file.path, scope: file.scope ?? null, root: file.root ?? null, line: b.line, segments: segments(quote(b.text), shared) };
  };
  const items = pairs.slice(0, MAX_FINDINGS).map(p => ({ score: Math.round(p.score * 100) / 100, sides: [side(blocks[p.a], blocks[p.b]), side(blocks[p.b], blocks[p.a])] }));
  return { items, more: Math.max(0, pairs.length - MAX_FINDINGS) };
}

/**
 * バッククォートの中身が、存在を確かめる相対パスか。確かめるなら行番号（:12）を落としたパス、確かめないなら null。
 * 確かめない: URL・絶対パス・~・glob（* ?）・置き換え用の書き方（<…> {…} $VAR %VAR%）・空白を含むもの・/ を含まないもの・
 * 拡張子で終わらずディレクトリの形（末尾の /）でもないもの（ブランチ名 feat/x なども含まれるため）・ドメインで始まるもの
 */
export function pathCandidate(raw) {
  let s = String(raw ?? '').trim();
  if (!s || /\s/.test(s) || !s.includes('/')) return null;
  s = s.replace(/:\d+(?::\d+)?$/, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;          // URL・ドライブ（C:/…）・npm:… など
  if (/^[/\\~-]/.test(s) || s.startsWith('//')) return null;  // 絶対パス・ホーム・フラグ
  if (/[*?<>{}[\]$%|"'`@=,;()\\]/.test(s) || s.includes('...')) return null;
  const dirShape = s.endsWith('/');
  const name = s.replace(/\/+$/, '').split('/').pop();
  if (!dirShape && !/\.[a-z0-9]*[a-z][a-z0-9]*$/i.test(name)) return null;
  const first = s.split('/')[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(first) && !first.startsWith('.')) return null; // example.com/…
  if (first === '' || s.split('/').some(part => part === '' && !dirShape)) return null;
  return s;
}

/** 指示の中のバッククォートで囲んだ相対パス（コードブロックの中は見ない）。戻り: [{ target, line }] */
export function pathMentions(content) {
  const lines = String(content ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    if (fence) { if (line.trim().startsWith(fence)) fence = null; return; }
    const f = FENCE.exec(line);
    if (f) { fence = f[1]; return; }
    for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
      const target = pathCandidate(m[2]);
      if (target) out.push({ target, line: i + 1 });
    }
  });
  return out;
}

/** 作業場所の Git のルート（無ければ null）。探索（core/context-scan.mjs）と同じく .git のある最初の祖先 */
export async function gitRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    try { await fs.stat(path.join(dir, '.git')); return dir; } catch {}
    if (path.dirname(dir) === dir) return null;
  }
}

const exists = p => fs.stat(p).then(() => true, () => false);

/**
 * この場所と親フォルダーの指示の中の、もう無いパス。Git のルート（無ければその指示ファイルのあるフォルダー）から見て、
 * 無ければ指示ファイルのあるフォルダーからも見て、どちらにも無いもの。ユーザーの指示・足した場所の指示は調べない（どのリポジトリを指すか決まらない）。
 * 戻り: { items: [{ path, scope, line, target, from }], more }。from は見た起点（repo: Git のルート / folder: 指示ファイルのあるフォルダー）
 */
export async function findMissingPaths(files, { root = null } = {}) {
  const items = [];
  let checks = 0, more = 0;
  const checked = new Map();
  for (const file of files) {
    if (file.scope === 'user' || file.root) continue;
    const seen = new Set();
    for (const { target, line } of pathMentions(file.content)) {
      if (seen.has(target)) continue;
      seen.add(target);
      const bases = [...new Set([root ?? path.dirname(file.path), path.dirname(file.path)])];
      const key = `${bases.join('\0')}\0${target}`;
      if (!checked.has(key)) {
        if (checks >= MAX_PATH_CHECKS) break;
        checks++;
        let found = false;
        for (const base of bases) if (await exists(path.resolve(base, target))) { found = true; break; }
        checked.set(key, found);
      }
      if (checked.get(key)) continue;
      if (items.length >= MAX_FINDINGS) { more++; continue; }
      items.push({ path: file.path, scope: file.scope ?? null, line, target, from: root ? 'repo' : 'folder' });
    }
  }
  return { items, more };
}

/**
 * 指示ファイルの行（{ path, realPath?, scope, root?, content? }）から気になる所を探す。content が無い行は読む（探索と同じ上限）。
 * 同じ実体のファイルは 1 つにまとめる（作業場所が home だと、同じファイルがユーザーと作業場所の両方で見つかる）
 */
export async function contextFindings(rows, { cwd } = {}) {
  const files = [], seen = new Set();
  let bytes = 0;
  for (const row of rows.slice(0, MAX_ENTRIES)) {
    if (!row?.path) continue;
    let content = typeof row.content === 'string' ? row.content : null;
    let real = row.realPath ?? null;
    if (content === null) {
      try {
        const stat = await fs.stat(row.path);
        if (!stat.isFile() || stat.size > MAX_FILE || bytes + stat.size > MAX_TOTAL) continue;
        content = await fs.readFile(row.path, 'utf8');
        real = await fs.realpath(row.path);
      } catch { continue; }
    }
    bytes += Buffer.byteLength(content);
    const key = pathKey(real ?? row.path);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ path: row.path, scope: row.scope ?? null, root: row.root ?? null, content });
  }
  const root = cwd ? await gitRoot(cwd) : null;
  const duplicates = findDuplicates(files);
  const missing = await findMissingPaths(files, { root });
  return { duplicates: duplicates.items, missing: missing.items, more: { duplicates: duplicates.more, missing: missing.more } };
}
