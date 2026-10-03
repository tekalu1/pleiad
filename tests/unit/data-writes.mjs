// 再発防止（ADR 0106）: core/・desktop/・bin/ がファイルを書く・置き換える箇所は、許可リスト（tests/data-writes-allowlist.mjs）に
// 上限と理由を書いたものだけ。リストに無い書き込みを足すと落ちる。件数・会話の長さで増える記録は DB の行にする。
// 走査（tests/lib/data-writes-scan.mjs）は fs の書き込みの API を、別名・名前付きの読み込み・FileHandle・ストリーム・
// コピー・リネームまで広く拾う。
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { scanWrites, countWrites, SCANNED_DIRS } from '../lib/data-writes-scan.mjs';
import { DATA_WRITES, DB_ONLY } from '../data-writes-allowlist.mjs';

export const name = 'data-writes';
export const title = '再発防止: データ置き場への丸ごと書きは許可リスト（上限と理由）に載ったものだけ（core・desktop・bin。別名・FileHandle・ストリーム・コピーも拾う）';

export default async function (t) {
  // ---- 走査の自己検査: 数えるもの
  const counted = [
    ['別名の名前付き読み込み', "import { writeFile as wf } from 'node:fs/promises'; await wf(a, b);", 1],
    ['import * as と fs.promises', "import * as fsx from 'fs'; fsx.renameSync(a,b); fsx.promises.copyFile(a,b);", 2],
    ['require の分割代入（promises: 別名）', "const { promises: fsp2 } = require('node:fs'); await fsp2.rename(a, b); await fsp2.cp(a,b);", 2],
    ['createWriteStream・appendFile', "const fs = require('fs'); fs.createWriteStream(p); fs.appendFile(p, d, cb);", 2],
    ['FileHandle の write・writeFile', "import fs from 'node:fs/promises'; const h = await fs.open(p, 'w'); await h.write(buf); await h.writeFile(x); await h.close();", 2],
    ['require(...) のその場の呼び出し', "require('node:fs').writeFileSync(p, d);", 1],
    ['分割代入の別名', "const { writeFileSync: w } = require('fs'); w(p, d);", 1],
    ['truncate・writeSync・copyFileSync', "import fs from 'node:fs'; fs.truncateSync(p, 0); fs.writeSync(fd, buf); fs.copyFileSync(a, b);", 3],
    ['動的 import', "const x = (await import('node:fs/promises')); await x.writeFile(p,d);", 1],
    ['createRequire で得た fs', "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); const nfs = req('node:fs'); nfs.writeFileSync(a, b); nfs.renameSync(a, b);", 2],
    ['symlink・link・cpSync', "const fs = require('node:fs'); fs.symlinkSync(a, b); fs.linkSync(a, b); fs.cpSync(a, b);", 3],
    ['注入された fs 互換（io）', 'await io.writeFile(tmp, data); await io.rename(tmp, file);', 2],
    ['プロジェクトの部品', 'await writeAtomic(file, text); const prefs = jsonFile(PREFS);', 2],
  ];
  for (const [label, source, want] of counted) t.ok(`走査: 数える — ${label}`, countWrites(source) === want, `${countWrites(source)} / ${want}`);
  // ---- 数えないもの
  const uncounted = [
    ['コメントと文字列の中', "// fs.writeFile(a)\nconst s = 'fs.writeFile(c)'; /* writeAtomic(x) */ const u = `writeAtomic(d)`;"],
    ['書き込みでない同名のメソッド', 'proc.stdin.write(x); res.write(y); socket.write(z); stream.write(1); plyMcp.rename(a, b); manager.cp(1); ws.link(2); store.rename(a, b);'],
    ['関数の定義そのもの', 'function writeFile(data) {} export async function writeAtomic(file, data) {}'],
    ['同じ名前の自前の関数', 'const rename = from => from; rename(a);'],
  ];
  for (const [label, source] of uncounted) t.ok(`走査: 数えない — ${label}`, countWrites(source) === 0, String(countWrites(source)));

  // ---- 本番: core/・desktop/・bin/ の書き込みが全部、許可リストにある
  const found = scanWrites(ROOT);
  const listed = new Map(DATA_WRITES.map(entry => [entry.file, entry]));
  t.ok('許可リストに同じファイルが 2 回出ない', listed.size === DATA_WRITES.length);
  const unlisted = Object.keys(found).filter(file => !listed.has(file));
  t.ok(`${SCANNED_DIRS.join('・')} の書き込み箇所はすべて許可リストにある（無ければ、DB の行にするか、上限と理由を書いて足す。AGENTS.md）`, unlisted.length === 0, unlisted.map(file => `${file}（${found[file]} 箇所）`).join(' / '));
  const changed = Object.keys(found).filter(file => listed.has(file) && listed.get(file).sites !== found[file]);
  t.ok('許可リストの箇所数と一致する（書き込みを足した・減らした場合は、リストの targets と sites を見直す）', changed.length === 0,
    changed.map(file => `${file}: リスト ${listed.get(file).sites} / 実際 ${found[file]}`).join(' / '));
  const stale = DATA_WRITES.filter(entry => !(entry.file in found)).map(entry => entry.file);
  t.ok('許可リストに、もう書き込みの無いファイルが残っていない', stale.length === 0, stale.join(' / '));

  // ---- 許可リストの中身
  const lines = DATA_WRITES.flatMap(entry => entry.targets.map(target => ({ entry, target })));
  const incomplete = lines.filter(({ target }) => !target.name?.trim() || !target.limit?.trim() || !target.reason?.trim());
  t.ok('どの書き先にも、名前・上限・理由が書いてある', incomplete.length === 0, incomplete.map(({ entry }) => entry.file).join(' / '));
  const noTargets = DATA_WRITES.filter(entry => !entry.targets?.length || !Number.isInteger(entry.sites) || entry.sites < 1);
  t.ok('どのファイルにも書き先が 1 つ以上ある', noTargets.length === 0, noTargets.map(entry => entry.file).join(' / '));
  const named = lines.filter(({ target }) => DB_ONLY.some(file => target.name.split(/[・\s]/).includes(file)));
  t.ok('DB の行にした記録（sessions.json・agent-tasks.json・usage.json・conversations.json）を丸ごと書く許可は無い', named.length === 0, named.map(({ target }) => target.name).join(' / '));
  const unbounded = lines.filter(({ target }) => target.unbounded);
  t.ok('上限の無い書き先は既知の例外として印が付き、理由がある', unbounded.every(({ target }) => target.reason.length >= 8));
  // 既知の例外の数。増やさない（減らすときは、行へ移したときに数字を下げる）
  const KNOWN_UNBOUNDED = 9;
  t.ok(`上限の無い既知の例外は ${KNOWN_UNBOUNDED} 件を超えない（増やさず、DB の行へ移して減らす）`, unbounded.length <= KNOWN_UNBOUNDED, `${unbounded.length} 件: ${unbounded.map(({ target }) => target.name).join(' / ')}`);
  t.ok('許可リストのパスは走査の対象（core・desktop・bin）の下', DATA_WRITES.every(entry => SCANNED_DIRS.some(dir => entry.file.startsWith(`${dir}/`)) && /\.(?:mjs|cjs|js)$/.test(path.posix.basename(entry.file))));
}
