// 項目 3 の土台: agy を保持役の身代わりで起動し、1 ターンのイベントの形と時間を見る。
// 実際の LLM を呼ぶ（既定の安いモデル 1 回）。会話は ~/.gemini/antigravity-cli に作られるので、conversation_id を最後に表示する。
import { HolderSim } from './holder-sim.mjs';
import { log, sleep } from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const h = new HolderSim('agy', ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', '--model', model], { cwd: work });
const events = [];
h.sink = (line, seq) => { let m; try { m = JSON.parse(line); } catch { log('non-json', line.slice(0, 120)); return; } events.push(m); log(`#${seq}`, m.event, m.event === 'step_update' ? `${m.step_update.step_type}/${m.step_update.state}` : m.event === 'result' ? `${m.result.status} resp=${JSON.stringify(m.result.response).slice(0, 60)}` : JSON.stringify(m.init ?? {}).slice(0, 120)); };
log('spawned pid', h.child.pid);
await sleep(3000);
log('after 3s idle: events so far =', events.length, 'alive =', h.exit === null);
h.write(JSON.stringify({ event: 'user', message: { content: process.argv[2] ?? 'Reply with exactly: ok' } }) + '\n');
const t = Date.now();
while (!events.some((e) => e.event === 'result') && Date.now() - t < 90000) await sleep(200);
const cid = events.find((e) => e.conversation_id)?.conversation_id ?? events.find((e) => e.result)?.result.conversation_id;
log('conversation_id =', cid, 'stderr:', h.err.slice(0, 300));
h.write(''); h.child.stdin.end(); await Promise.race([h.exited, sleep(15000)]);
log('exit', JSON.stringify(h.exit));
if (h.exit === null) h.kill();
fs.rmSync(work, { recursive: true, force: true });
