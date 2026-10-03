// core/・desktop/・bin/ の中で、ファイルを書く・置き換える呼び出しを数える（tests/unit/data-writes.mjs が許可リストと突き合わせる）。
//
// 数えるもの（Node の fs の書き込みの API を広く）:
//   - fs / fs/promises / node:fs / node:fs/promises の名前空間（default・* as・require・動的 import・fs.promises・別名）から呼ぶ
//     writeFile・appendFile・createWriteStream・rename・copyFile・cp・truncate・write・writev・symlink・link（Sync を含む）
//   - 名前付きで読み込んだ関数（import { writeFile as wf } from 'node:fs/promises' → wf(...)）
//   - fs.open / fs.promises.open で得た FileHandle の write・writeFile・appendFile・truncate・writev
//   - 受け手を問わず、書き込みにしか使われない名前: writeFile・writeFileSync・appendFile・appendFileSync・createWriteStream・
//     copyFile・copyFileSync・cpSync・truncateSync・renameSync・writeAtomic・jsonFile（プロジェクトの書き込みの部品）
//   - 注入された fs 互換の引数（io・fsp・fsSync・fsPromises）も名前空間として扱う
// 数えないもの: コメント・文字列の中、関数の定義そのもの、書き込み以外の同名のメソッド（proc.stdin.write・res.write・
// plyMcp.rename など。fs の名前空間・FileHandle でない受け手の write・rename・cp・truncate・link）。
// 手書きの走査で、正規表現リテラルは考えない。
import fs from 'node:fs';
import path from 'node:path';

/** 名前空間か FileHandle から呼んだときに書き込みになる API */
const NAMESPACE_APIS = ['writeFile', 'appendFile', 'createWriteStream', 'rename', 'copyFile', 'cp', 'truncate', 'ftruncate', 'write', 'writev', 'symlink', 'link']
  .flatMap(name => [name, `${name}Sync`]);
/** 受け手を問わず数える名前 */
const ALWAYS = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'cpSync', 'truncateSync', 'renameSync', 'writeAtomic', 'jsonFile'];
const HANDLE_APIS = ['write', 'writeFile', 'appendFile', 'truncate', 'writev'];
const DEFAULT_NAMESPACES = ['fs', 'fsp', 'fsSync', 'fsPromises', 'io'];
const SPEC = String.raw`['"](?:node:)?fs(?:/promises)?['"]`;
const ID = String.raw`[\w$]+`;

/** コメントを空白にし、strings: false なら文字列・テンプレートリテラルの中身も空白にする（長さと改行は保つ） */
export function stripCode(source, { strings = false } = {}) {
  let out = '';
  let i = 0;
  const blank = ch => (ch === '\n' ? '\n' : ' ');
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { out += blank(source[i]); i++; }
      out += '  '; i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') { out += strings ? source[i] : ' '; i++; }
        if (c !== '`' && source[i] === '\n') break;
        out += strings ? source[i] : blank(source[i]); i++;
      }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** `{ a, b as c, promises: d }` の中身を [[元の名前, 別名]] にする */
const members = text => text.split(',').map(part => part.trim()).filter(Boolean).map(part => {
  const [name, alias] = part.split(/\s+as\s+|\s*:\s*/).map(piece => piece.trim());
  return [name, alias || name];
});

/** fs の名前空間の別名と、名前付きで読み込んだ書き込み関数の別名を、ソースから集める */
function bindings(text) {
  const namespaces = new Set(DEFAULT_NAMESPACES);
  const named = new Map();   // 別名 -> 元の名前
  const addNamed = list => { for (const [name, alias] of list) { if (name === 'promises') namespaces.add(alias); else if (NAMESPACE_APIS.includes(name)) named.set(alias, name); } };
  for (const m of text.matchAll(new RegExp(String.raw`import\s+(${ID})\s*(?:,\s*\{([^}]*)\})?\s*from\s*${SPEC}`, 'g'))) { namespaces.add(m[1]); if (m[2]) addNamed(members(m[2])); }
  for (const m of text.matchAll(new RegExp(String.raw`import\s*\*\s*as\s+(${ID})\s+from\s*${SPEC}`, 'g'))) namespaces.add(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${SPEC}`, 'g'))) addNamed(members(m[1]));
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${ID})\s*=\s*(?:await\s+)?[\w$.]*\(?\s*[\w$.]*\s*\(\s*${SPEC}\s*\)\s*\)?(\.promises)?`, 'g'))) namespaces.add(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?\(?\s*[\w$.]*\s*\(\s*${SPEC}\s*\)\s*\)?`, 'g'))) addNamed(members(m[1]));
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${ID})\s*=\s*(${ID})\.promises\b`, 'g'))) if (namespaces.has(m[2])) namespaces.add(m[1]);
  return { namespaces, named };
}

/** 書き込みの呼び出しの位置（API の名前の先頭の添字）の集合 */
export function writeSites(source) {
  const text = stripCode(source, { strings: true });
  const bare = stripCode(source);
  const { namespaces, named } = bindings(text);
  const sites = new Set();
  const collect = (regex, text = bare) => { for (const m of text.matchAll(regex)) sites.add(m.indices[1][0]); };
  const names = list => list.join('|');
  // 名前空間から: fs.writeFile( / fs.promises.rename(
  for (const alias of namespaces) collect(new RegExp(String.raw`(?<![\w$.])${alias.replace(/\$/g, '\\$')}\s*\.\s*(?:promises\s*\.\s*)?(${names(NAMESPACE_APIS)})\s*\(`, 'dg'));
  // 名前付きで読み込んだ関数: wf(...)
  for (const alias of named.keys()) collect(new RegExp(String.raw`(?<![\w$.])(${alias.replace(/\$/g, '\\$')})\s*\(`, 'dg'));
  // FileHandle: const h = await fs.open(...) → h.write(...)
  const handles = [];
  for (const alias of namespaces) {
    for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${ID})\s*=\s*(?:await\s+)?${alias.replace(/\$/g, '\\$')}\s*\.\s*(?:promises\s*\.\s*)?open\s*\(`, 'g'))) handles.push(m[1]);
  }
  for (const handle of new Set(handles)) collect(new RegExp(String.raw`(?<![\w$.])${handle.replace(/\$/g, '\\$')}\s*\.\s*(${names(HANDLE_APIS)})\s*\(`, 'dg'));
  // 受け手を問わない名前（関数の定義 function writeFile( は数えない）
  collect(new RegExp(String.raw`(?<!function\s+)(?<![\w$])(${names(ALWAYS)})\s*\(`, 'dg'));
  // その場の呼び出し: require('fs').writeFileSync( / (await import('node:fs/promises')).rename(
  collect(new RegExp(String.raw`(?:require|import)\s*\(\s*${SPEC}\s*\)\s*\)?\s*\.\s*(?:promises\s*\.\s*)?(${names(NAMESPACE_APIS)})\s*\(`, 'dg'), text);
  return sites;
}

export const countWrites = source => writeSites(source).size;

export function listFiles(dir, accept = name => /\.(?:mjs|cjs|js)$/.test(name)) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

export const SCANNED_DIRS = ['core', 'desktop', 'bin'];

/** { 'core/store.mjs': 件数, … }（1 件以上のファイルだけ） */
export function scanWrites(root, dirs = SCANNED_DIRS) {
  const found = {};
  for (const dir of dirs) {
    for (const file of listFiles(path.join(root, dir))) {
      const count = countWrites(fs.readFileSync(file, 'utf8'));
      if (count) found[path.relative(root, file).split(path.sep).join('/')] = count;
    }
  }
  return found;
}
