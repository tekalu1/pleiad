// 項目 3: agy の stdio の相手が数秒いなくなる／入れ替わるとき。LLM を 3 回呼ぶ（安いモデル。短い応答）。
//   (a) 走っているターンの最中に、相手がいなくなる + stdout を誰も読まない 4 秒間 → 続くか・詰まらないか
//   (b) 新しい相手が付け直し、(a) の続き（result）を受け取れるか
//   (c) 新しい相手が 1 行目を書いた直後に 2 行目を書く（ターンの最中の 2 行目）→ 直列に回るか
//   (d) 何も書かない 6 秒（stdin を開けたまま）で落ちないか
import { HolderSim } from './holder-sim.mjs';
import { log, sleep } from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const h = new HolderSim('agy', ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', '--model', model], { cwd: work });
const user = (c) => JSON.stringify({ event: 'user', message: { content: c } }) + '\n';
const desc = (m) => m.event === 'step_update' ? `${m.step_update.step_type}/${m.step_update.state}` : m.event === 'result' ? `result ${m.result.status} len=${(m.result.response ?? '').length} resp=${JSON.stringify(m.result.response).slice(0, 40)} conv=${m.result.conversation_id?.slice(0, 8)}` : m.event;
class Client {
  constructor(name, from = 0) { this.name = name; this.events = []; h.attach((line, seq) => { let m; try { m = JSON.parse(line); } catch { return; } this.events.push({ seq, at: Date.now(), m }); this.last = seq; }, from); }
  results() { return this.events.filter((e) => e.m.event === 'result'); }
  async waitResults(n, ms) { const end = Date.now() + ms; while (Date.now() < end && this.results().length < n) await sleep(100); return this.results().length >= n; }
}
let conv = null;
try {
  const A = new Client('A');
  h.write(user('Write the integers from 1 to 120, one per line, each followed by a single English adjective. Output only the list.'));
  const t0 = Date.now();
  while (!A.events.some((e) => e.m.event === 'init') && Date.now() - t0 < 30000) await sleep(50);
  conv = A.events.find((e) => e.m.event === 'init')?.m.conversation_id ?? null;
  log('(a) A saw init after', Date.now() - t0, 'ms; conversation', conv);
  await sleep(300);
  const ack = A.last; h.detach();
  h.child.stdout.pause(); log('(a) A detached at seq', ack, '; stdout NOT read for 4s (paused)');
  await sleep(4000);
  h.child.stdout.resume(); log('(a) stdout reading resumed; holder log lines now', h.seq, '(result already in log:', h.log.some((e) => /"event":"result"/.test(e.line)), ')');
  await sleep(1500);
  const B = new Client('B', ack);
  log('(b) B attached from seq', ack, '; B replayed events:', B.events.map((e) => desc(e.m)).join(' | '));
  const got = await B.waitResults(1, 60000);
  const r1 = B.results()[0]?.m.result;
  const lines = (r1?.response ?? '').trim().split('\n').length;
  log('(b) B got result of the interrupted-attachment turn:', got, 'status', r1?.status, 'lines in response', lines, '(expect 120)', 'duration_s', r1?.duration_seconds);
  // (c) 2 行目をターンの最中に
  const n0 = B.events.length;
  h.write(user('Reply with exactly: two')); await sleep(150);
  h.write(user('Reply with exactly: three'));
  const got2 = await B.waitResults(3, 60000);
  const seqDesc = B.events.slice(n0).map((e) => desc(e.m));
  log('(c) both extra prompts answered:', got2, '\n     event order:', seqDesc.join(' | '));
  // (d) 何も書かない
  await sleep(6000);
  log('(d) alive after 6s with no writes (stdin open):', h.exit === null);
  const convs = new Set(B.events.map((e) => e.m.result?.conversation_id ?? e.m.step_update?.conversation_id).filter(Boolean));
  log('conversation ids seen after the swap:', [...convs].map((c) => c.slice(0, 8)).join(','), '(one conversation for all turns)');
} finally {
  log('CONVERSATION_ID(for cleanup):', conv);
  try { h.child.stdin.end(); } catch {}
  await Promise.race([h.exited, sleep(15000)]);
  if (h.exit === null) h.kill();
  await sleep(500); fs.rmSync(work, { recursive: true, force: true });
  log('stderr:', h.err.slice(0, 300));
}
