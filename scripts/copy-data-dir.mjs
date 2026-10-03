// 実データ（データ置き場）の写しを作る。測る・画面を見るために、実データを汚さず・本物の接続を追い出さずに立てるための道具。
//
//   node scripts/copy-data-dir.mjs <写し先> [--source <元>] [--keep-tasks] [--light]
//
// 元は既定で AGENT_HOST_DATA、無ければ ~/.agent-host。**元は読むだけ**（DB は読み取り専用の接続で VACUUM INTO する。
// 動いているサーバーの DB のファイルをそのままコピーしない。WAL に未反映の分が -wal にあり、途中の写しは壊れる）。
//   写さないもの: remote/（同じホストの鍵で中継へつなぎ、本物のホストの接続を追い出す）・*-secrets.json・*.lock・pleiad.lock*（データ置き場のロック）・control.json（接続情報）
//   --keep-tasks  写しの agent_tasks（委譲のタスク）を残す。既定は空にする（委譲の続きを走らせない）。
//                 委譲のタスクが載る送信量（running など）を測るときだけ使う
//   --light       conversations/（会話の本文）・handoff-*.json・uploads/・presents/ などの大きなものを写さない（移行や 1 回の更新の時間を測るだけなら要らない）
// 写しには会話の中身が入る。測り終えたら消すこと。写し先は temporary/ の下に置く（コミットしない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dst = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--source');
if (!dst) { console.error('usage: node scripts/copy-data-dir.mjs <destination> [--source <dir>] [--keep-tasks] [--light]'); process.exit(2); }
const src = path.resolve(option('--source') ?? process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'));
const out = path.resolve(dst);
if (out === src || out.startsWith(src + path.sep) || src.startsWith(out + path.sep)) throw new Error('destination must be a separate directory (not inside or around the source)');
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`destination is not empty: ${out}`);
fs.mkdirSync(out, { recursive: true });

const SKIP_DIRS = new Set(['remote']);
const LIGHT_SKIP_DIRS = new Set(['conversations', 'uploads', 'presents', 'visualization-snapshots', 'context-snapshots', 'agent-browser', 'claude-login-tmp', 'mcp-locks', 'computer-use', 'antigravity', 'claude-usage', 'run', 'hooks-runtime']);
const skipFile = name => /-secrets\.json$/.test(name) || /\.lock$/.test(name) || /^pleiad\.lock/.test(name) || name === 'control.json' || /^pleiad\.db(-wal|-shm)?$/.test(name)
  || (flag('--light') && name.startsWith('handoff-')) || (!flag('--keep-tasks') && name === 'agent-tasks.json');
let files = 0, bytes = 0;
function copyDir(from, to, top) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (top && (SKIP_DIRS.has(entry.name) || (flag('--light') && LIGHT_SKIP_DIRS.has(entry.name)))) continue;
      copyDir(source, target, false);
    } else if (entry.isFile() && !skipFile(entry.name)) {
      fs.copyFileSync(source, target);
      files++; bytes += fs.statSync(target).size;
    }
  }
}
copyDir(src, out, true);

// DB は読み取り専用の接続で VACUUM INTO する（node:sqlite の警告は、この 1 回の読み込みの間だけ捨てる）
const dbFile = path.join(src, 'pleiad.db');
if (fs.existsSync(dbFile)) {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) { return /SQLite/i.test(String(warning?.message ?? warning)) ? undefined : original.call(this, warning, ...rest); };
  let sqlite;
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = original; }
  const reader = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    reader.exec(`VACUUM INTO '${path.join(out, 'pleiad.db').replaceAll("'", "''")}'`);
  } finally { reader.close(); }
  if (!flag('--keep-tasks')) {
    const copy = new sqlite.DatabaseSync(path.join(out, 'pleiad.db'));
    try { copy.exec('DELETE FROM agent_tasks'); } finally { copy.close(); }
  }
  bytes += fs.statSync(path.join(out, 'pleiad.db')).size; files++;
}
console.log(JSON.stringify({ source: src, destination: out, files, bytes, keepTasks: flag('--keep-tasks'), light: flag('--light') }));
