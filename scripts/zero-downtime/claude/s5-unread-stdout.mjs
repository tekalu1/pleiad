// 項目 5: CLI の stdout が誰にも読まれないあいだ、CLI は止まらないか（パイプの詰まり）。
// CLI を素の stdio で起動し、stdout を pause したまま、大きい応答を返す control_request を大量に送り、
// さらに「ファイルを作る」ツールを使う user メッセージを送る。読まないまま N 秒のうちにファイルができるか（= CLI のループが動いているか）、
// 読み始めたら全部の応答と result が戻るかを見る。
// 使い方: node s5-unread-stdout.mjs [flood=400] [holdMs=20000]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudePath, sleep } from './common.mjs';

const kv = Object.fromEntries(process.argv.slice(2).map(s => s.split('=')));
const flood = Number(kv.flood ?? 400);
const holdMs = Number(kv.holdMs ?? 20_000);
const pause = kv.pause !== '0';   // pause=0 は対照（読み続ける）
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zdu-s5-'));
const mark = path.join(cwd, 'STALL_MARK.txt');
const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--tools', 'Bash', '--dangerously-skip-permissions', '--system-prompt', 'Follow the instruction literally. Be terse.'];
const child = spawn(claudePath(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
child.stderr.on('data', () => {});
child.on('exit', (c, s) => log('CLI exit', c, s));
let buf = '', bytes = 0, responses = 0, gotResult = false, sizes = new Map();
const onData = d => {
  bytes += d.length; buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.type === 'control_response') { responses++; sizes.set(m.response?.request_id, line.length); }
      if (m.type === 'result') { gotResult = true; log('result', String(m.result).slice(0, 60)); }
    } catch { /* ignore */ }
  }
};
child.stdout.on('data', onData);
const send = o => child.stdin.write(JSON.stringify(o) + '\n');
send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
await sleep(2500);
log('initialized; responses', responses, 'size of init response', [...sizes.values()][0]);

if (pause) { child.stdout.pause(); child.stdout.removeListener('data', onData); }
const before = bytes;
log(`stdout ${pause ? 'paused' : 'still read (control)'}. sending ${flood} initialize requests + a tool-using user message`);
for (let k = 0; k < flood; k++) send({ type: 'control_request', request_id: `flood-${k}`, request: { subtype: 'initialize' } });
send({ type: 'user', message: { role: 'user', content: `Use the Bash tool to run exactly: echo done > "${mark.replace(/\\/g, '/')}" . Then reply DONE.` }, parent_tool_use_id: null });
let created = null;
for (let waited = 0; waited < holdMs; waited += 250) {
  await sleep(250);
  if (!pause && created) break;
  if (!created && fs.existsSync(mark)) { created = Date.now() - t0; log('marker file created while stdout is unread'); }
}
log('hold over. marker created?', created !== null, 'bytes read during hold:', bytes - before);
if (pause) { child.stdout.on('data', onData); child.stdout.resume(); }
for (let w = 0; w < 40 && !gotResult; w++) await sleep(500);
await sleep(1500);
log('after resuming read: control_responses', responses, '(expected', flood + 1, ') result seen', gotResult, 'bytes', bytes);
const lines = { responseBytesPer: Math.round([...sizes.values()].reduce((a, b) => a + b, 0) / Math.max(1, sizes.size)) };
log('avg response bytes', lines.responseBytesPer, 'total flood bytes ~', lines.responseBytesPer * flood);
child.stdin.end();
await sleep(3000);
if (child.exitCode === null) child.kill();
process.exit(0);
