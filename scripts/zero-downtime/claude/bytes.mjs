// run.mjs の記録フォルダーから、CLI が出した行数とバイト数、解析の結果を数える。使い方: node bytes.mjs <記録フォルダー>...
import fs from 'node:fs';
import path from 'node:path';

for (const dir of process.argv.slice(2)) {
  const bytes = new Map();   // seq → bytes（親ごとの重複を除く）
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.ev === 'push') bytes.set(e.seq, e.bytes);
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  console.log(path.basename(dir), 'killAfter', s.opt.killAfter, 'lines', bytes.size, 'bytes', total, 'missing', JSON.stringify(s.analysis?.missing), 'dup', JSON.stringify(s.analysis?.dup));
}
