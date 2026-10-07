// 入力欄の `!`（シェルの行）を保持役（core/holder/）の子として走らせる包み（無停止の更新 段階 3。docs/zero-downtime-update/plan.md「段階 3」の `!` の行）。
// サーバーの core/shell-held.mjs が保持役に起こさせる。シェルは core/host-shell.mjs の runHostShell でこのプロセスの子として走らせ（今の流れと同じシェル・引数・
// 上限の時間・出力の上限・木ごとの停止）、stdout と stderr を 1 行 1 JSON の記録にして出す。保持役の記録は行ごとで stderr を持たないので、両方をここで行にする。
//   サーバー -> stdin   { t: 'run', command, cwd, timeoutMs }（最初の 1 行）・{ t: 'stop' }（止める）
//   stdout -> 記録     { t: 'o', x }（stdout のかたまり）・{ t: 'e', x }（stderr のかたまり）・{ t: 'done', exitCode, signal, durationMs, timedOut, stopped, truncated, startError? }（最後に 1 回）
// 上限の時間はこのプロセスが数える（サーバーが入れ替わっても続く）。シェルの標準入力は今の流れと同じく渡さない（閉じる）。
// サーバーが居ない間も保持役が stdout を読むので、出力は止まらない。
import { runHostShell } from './host-shell.mjs';

const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const ac = new AbortController();
let started = false;
let buffer = '';

function onLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.t === 'stop') { ac.abort(); return; }
  if (message?.t !== 'run' || started) return;
  started = true;
  const { command, cwd, timeoutMs } = message;
  runHostShell({
    command: String(command ?? ''), cwd: cwd || undefined, timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 10 * 60 * 1000, signal: ac.signal,
    onOutput: (stream, text) => write({ t: stream === 'stderr' ? 'e' : 'o', x: text }),
  }).then(({ stdout: _o, stderr: _e, ...result }) => {
    // 出力は o・e で流し終えている。最後の行を書き切ってから終わる（stdin は保持役が開けたままなので、自分で終わる）
    process.stdout.write(`${JSON.stringify({ t: 'done', ...result })}\n`, () => process.exit(0));
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) onLine(line);
  }
});
// 走らせる前に stdin が閉じた（起こした親が始めの行を書かずに居なくなった）なら、何もせず終わる
process.stdin.on('end', () => { if (!started) process.exit(0); });
process.stdin.on('error', () => {});
