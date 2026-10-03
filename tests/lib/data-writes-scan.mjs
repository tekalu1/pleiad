// core/ の中で、ファイルを丸ごと書く・置き換える呼び出しを数える（tests/unit/data-writes.mjs が許可リストと突き合わせる）。
// 数えるのは writeAtomic / jsonFile / writeFile / writeFileSync / appendFile(Sync) / renameSync / fs.rename。
// コメントと文字列の中は数えない（手書きの走査。正規表現リテラルは考えない）
import fs from 'node:fs';
import path from 'node:path';

export const WRITE_CALL = /(?<![\w$.])(?:writeAtomic|jsonFile)\s*\(|\.(?:writeFile|writeFileSync|appendFile|appendFileSync|renameSync)\s*\(|(?<![\w$.])(?:writeFileSync|appendFileSync|renameSync)\s*\(|\b(?:fs|io|fsp|fsSync)\.rename\s*\(/g;

/** コメントと文字列・テンプレートリテラルの中身を空白にする（長さと改行は保つ） */
export function stripCode(source) {
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
        if (source[i] === '\\') { out += ' '; i++; }
        if (c !== '`' && source[i] === '\n') break;
        out += blank(source[i]); i++;
      }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

export function listFiles(dir, accept = name => name.endsWith('.mjs')) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

/** { 'core/store.mjs': 件数, … }（1 件以上のファイルだけ） */
export function scanWrites(root) {
  const found = {};
  for (const file of listFiles(path.join(root, 'core'))) {
    const code = stripCode(fs.readFileSync(file, 'utf8'));
    const count = [...code.matchAll(WRITE_CALL)].length;
    if (count) found[path.relative(root, file).split(path.sep).join('/')] = count;
  }
  return found;
}
