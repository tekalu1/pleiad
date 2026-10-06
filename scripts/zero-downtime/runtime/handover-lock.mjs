// データ置き場のロック（core/data-lock.mjs）を、旧プロセスが放してから新プロセスが取れるまでの時間を測る。
//   node scripts/zero-downtime/runtime/handover-lock.mjs [--reps 20]
// 持ち主（holder）と待ち手（contender）は別プロセス。待ち手は取れるまで（DataLockedError の間）隙間なく試し続ける。
// 3 つの放し方: (1) 持ち主が release() を呼ぶ（プロセスは残る） (2) 持ち主が process.exit(0)（'exit' で閉じる） (3) 持ち主を強制終了（OS が外す）
// 使うのは空の一時ディレクトリ（pleiad.lock.db は DB 本体とは別の小さなファイルなので、置き場の大きさに依らない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const lockModule = pathToFileURL(path.join(root, 'core', 'data-lock.mjs')).href;
const mode = process.argv[2];
// プロセスをまたいで比べる時計。Date.now() は Windows で粗いことがあるので、timeOrigin + now() を使う（ミリ秒、小数あり）
const now = () => performance.timeOrigin + performance.now();

if (mode === '--holder') {
  const { acquireDataLock } = await import(lockModule);
  const release = acquireDataLock(process.argv[3]);
  console.log('LOCKED');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    const cmd = d.trim();
    if (cmd === 'release') { release(); console.log(`RELEASED ${now()}`); }
    if (cmd === 'exit') process.exit(0);
  });
} else if (mode === '--contender') {
  const { acquireDataLock } = await import(lockModule);
  console.log('READY');
  const dir = process.argv[3];
  process.stdin.once('data', () => {
    let tries = 0;
    for (;;) {
      tries++;
      try { acquireDataLock(dir); console.log(`ACQUIRED ${now()} ${tries}`); break; } catch (e) { if (e.code !== 'DATA_LOCKED') { console.log('ERROR ' + e.message); break; } }
    }
    setTimeout(() => process.exit(0), 50);
  });
} else {
  const reps = Number(process.argv[process.argv.indexOf('--reps') + 1]) || 20;
  const round = x => Math.round(x * 10) / 10;
  const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const waitLine = (child, re) => new Promise(resolve => { let buf = ''; const f = d => { buf += d; const m = buf.match(re); if (m) { child.stdout.off('data', f); resolve(m); } }; child.stdout.on('data', f); });
  const results = {};
  for (const how of ['release', 'exit', 'kill']) {
    const deltas = [], sinceCall = [], tries = [];
    for (let i = 0; i < reps; i++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-lock-'));
      const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), '--holder', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
      holder.stdout.setEncoding('utf8');
      await waitLine(holder, /LOCKED/);
      const contender = spawn(process.execPath, [fileURLToPath(import.meta.url), '--contender', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
      contender.stdout.setEncoding('utf8');
      await waitLine(contender, /READY/);
      const acquired = waitLine(contender, /ACQUIRED ([\d.]+) (\d+)/);
      contender.stdin.write('go\n');
      await new Promise(r => setTimeout(r, 100 + Math.random() * 40));   // 待ち手が試し始めてから放す（位相をばらす）
      const callAt = now();
      let releasedAt;
      if (how === 'release') { const released = waitLine(holder, /RELEASED ([\d.]+)/); holder.stdin.write('release\n'); releasedAt = Number((await released)[1]); }
      else if (how === 'exit') { holder.stdin.write('exit\n'); }
      else holder.kill();
      const m = await acquired;
      const acquiredAt = Number(m[1]);
      deltas.push(acquiredAt - (releasedAt ?? callAt));
      sinceCall.push(acquiredAt - callAt);
      tries.push(Number(m[2]));
      holder.kill(); contender.kill();
      await new Promise(r => setTimeout(r, 30));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    results[how] = { reps, 'acquiredAfterReleaseLoggedMs(median/max)': [round(median(deltas)), round(Math.max(...deltas))], 'acquiredAfterCallMs(median/max)': [round(median(sinceCall)), round(Math.max(...sinceCall))], triesMedian: median(tries) };
  }
  console.log(JSON.stringify(results, null, 2));
}
