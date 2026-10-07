// 無停止の更新 段階 3（agy）の最初の実測: 本物の agy を本物の保持役（core/holder/）の子に載せ、サーバー（親）が入れ替わっても続くかを測る。
// stage0-codex-agy §3 は保持役の身代わり（holder-sim）だったので、ここは本物の保持役・本物のクライアントで、agy 1.3.0 を使う。
//   (a) 親 A が spawn → 印（turn）→ 1 行目を書く。ツールを呼ぶターンの途中で A が detach して切れる
//   (b) 親 B が付け直す（attach）。印から ack までの再生と、続きの出力で result まで届くか（init・conversation_id・ツールの行・本文）
//   (c) B が同じプロセスに 2 ターン目を書く（印を打ち直す）。記録の捨てられ方（first の進み）と、同じ会話 id のままか
//   (d) 保持役に載った子を B が木ごと止めて、agy と中継の孫が残らないか
// LLM は gemini-3.8-flash-low で 2 ターン（短い応答・シェルは echo 1 回）。agy の会話は ~/.gemini/antigravity-cli に残る（終わりに会話 id を出す）。
// 置き場は worktree の temporary/zdu-agy-held/（データ置き場・実行場所・作業場所）。保持役は終わりに shutdown する。
//
//   node scripts/zero-downtime/agy/held-swap.mjs [--model <id>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureHolder, connectHolder } from '../../../core/holder/client.mjs';
import { holderSource, ADOPT_TURN_MARK } from '../../../core/adopt.mjs';
import { cliCommand } from '../../../core/cli-installation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'gemini-3.8-flash-low';
const scratch = path.join(repo, 'temporary', 'zdu-agy-held');
await fs.rm(scratch, { recursive: true, force: true });
const dataDir = path.join(scratch, 'data'), root = path.join(scratch, 'runtime'), work = path.join(scratch, 'work');
await Promise.all([dataDir, root, work].map(dir => fs.mkdir(dir, { recursive: true })));
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(50); } };
const user = text => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const desc = m => !m ? '?' : m.event === 'step_update' ? `${m.step_update.step_type}/${m.step_update.state}${m.step_update.tool_name ? `(${m.step_update.tool_name})` : ''}` : m.event === 'result' ? `result ${m.result.status} resp=${JSON.stringify((m.result.response ?? '').slice(0, 30))}` : m.event;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const imageNames = () => { try { return execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).split('\n').map(l => /^"([^"]+)","(\d+)"/.exec(l)).filter(Boolean).map(m => [m[1], Number(m[2])]); } catch { return []; } };

const [command, ...baseArgs] = cliCommand('antigravity') ?? ['agy'];
const args = [...baseArgs, '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', '--model', model, '--dangerously-skip-permissions', '--add-dir', work];
const id = 'agy-held-probe';
const out = { ok: false };
let holderPid = null, clientA = null, clientB = null, conv = null;
try {
  const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
  holderPid = found.pid;
  clientA = found.client;
  log('holder', holderPid, 'agy', command, `model=${model}`);

  // (a) 親 A
  const sourceA = holderSource(clientA, { id, acked: 0, seq: 0, marks: { [ADOPT_TURN_MARK]: 1 } }, { spawned: true });
  clientA.spawn({ id, command, args, cwd: work, env: { ...process.env }, policy: 'none' });
  clientA.mark(id, ADOPT_TURN_MARK);
  sourceA.write(user('Run the shell command `echo zdu-agy-held` with your shell tool, then reply with exactly one word: finished'));
  const seenA = [];
  const readA = (async () => { for await (const item of sourceA.attach(1)) { if (item.exit) break; seenA.push(item); const m = parse(item.line); conv ??= m?.conversation_id ?? m?.step_update?.conversation_id ?? m?.result?.conversation_id ?? null; } })();
  await until(() => seenA.some(i => parse(i.line)?.event === 'init'), 60_000, 'init');
  log('A: init at seq', seenA.find(i => parse(i.line)?.event === 'init').seq, 'conversation', conv);
  // ターンの途中（ツールの行が出るまで。出なければ本文の途中）で手を離す
  await until(() => seenA.some(i => parse(i.line)?.step_update?.step_type === 'tool') || seenA.some(i => parse(i.line)?.event === 'result'), 60_000, 'tool step');
  const ackSeq = seenA.at(-1).seq;
  sourceA.ack(ackSeq);
  await sleep(100);
  clientA.label(id, { probe: true });
  await clientA.detach(id);
  sourceA.stop();
  await readA;
  log('A: detached after', seenA.length, 'lines; events:', seenA.map(i => desc(parse(i.line))).join(' | '));
  const resultBeforeDetach = seenA.some(i => parse(i.line)?.event === 'result');
  clientA.close(); clientA = null;
  await sleep(2500);   // 親が居ない間（切り替えの間に当たる数秒）にも子は進む

  // (b) 親 B
  clientB = await connectHolder({ dataDir, root });
  const child = clientB.welcome.children.find(c => c.id === id);
  log('B: welcome child', JSON.stringify({ alive: child?.alive, seq: child?.seq, first: child?.first, acked: child?.acked, marks: child?.marks, label: child?.label }));
  const sourceB = holderSource(clientB, child, { redelivered: true });
  const mark = child.marks[ADOPT_TURN_MARK];
  const replayed = [];
  for (const [seq, line] of await sourceB.replay(mark, child.acked)) replayed.push({ seq, m: parse(line) });
  log('B: replayed', replayed.length, 'lines (mark', mark, '..', child.acked, '):', replayed.map(r => desc(r.m)).join(' | '));
  const live = [];
  let result1 = null;
  const readB = (async () => { for await (const item of sourceB.attach(child.acked + 1)) { if (item.exit) { live.push({ exit: item.exit }); break; } const m = parse(item.line); live.push({ seq: item.seq, m }); sourceB.ack(item.seq); if (m?.event === 'result' && !result1) { result1 = m.result; break; } } })();
  await until(() => result1, 90_000, 'result of turn 1');
  log('B: continued', live.length, 'lines; events:', live.map(l => l.exit ? 'exit' : desc(l.m)).join(' | '));
  log('B: turn 1 result', result1.status, JSON.stringify(result1.response), 'conversation', result1.conversation_id?.slice(0, 8), 'same as init:', result1.conversation_id === conv);
  const allEvents = [...seenA.map(i => parse(i.line)), ...replayed.map(r => r.m), ...live.map(l => l.m)];
  const tools = allEvents.filter(m => m?.step_update?.step_type === 'tool' && /DONE/i.test(m.step_update.state));
  log('turn 1 tool results seen (A + replay + live, may overlap):', tools.length, JSON.stringify(tools.at(-1)?.step_update?.tool_info?.output ?? null)?.slice(0, 80));

  // (c) 同じプロセスに 2 ターン目（印を打ち直す）
  sourceB.stop(); await sleep(50);
  const sourceB2 = holderSource(clientB, { id, acked: result1 ? live.at(-1).seq : child.acked, seq: live.at(-1).seq, marks: {} }, { spawned: true });
  clientB.mark(id, ADOPT_TURN_MARK);
  sourceB2.write(user('Reply with exactly one word: second'));
  let result2 = null;
  const live2 = [];
  const read2 = (async () => { for await (const item of sourceB2.attach(live.at(-1).seq + 1)) { if (item.exit) break; const m = parse(item.line); live2.push(m); sourceB2.ack(item.seq); if (m?.event === 'result') { result2 = m.result; break; } } })();
  await until(() => result2, 90_000, 'result of turn 2');
  log('B: turn 2 result', result2.status, JSON.stringify(result2.response), 'same conversation:', result2.conversation_id === conv, 'init again:', live2.some(m => m?.event === 'init'));
  await sleep(200);
  const probe = await connectHolder({ dataDir, root }).catch(() => null);
  log('holder child after 2 turns (probe connection takes the parent slot)', JSON.stringify(probe?.welcome.children.find(c => c.id === id) && (({ alive, seq, first, acked, marks }) => ({ alive, seq, first, acked, marks }))(probe.welcome.children.find(c => c.id === id))));
  clientB = probe ?? clientB;

  // (d) 木ごと止める
  const childPid = clientB.welcome.children.find(c => c.id === id)?.pid;
  const agyBefore = imageNames().filter(([n]) => /^agy/i.test(n)).map(([, pid]) => pid);
  const sourceK = holderSource(clientB, clientB.welcome.children.find(c => c.id === id));
  void (async () => { try { for await (const item of sourceK.attach(clientB.welcome.children.find(c => c.id === id).acked + 1)) if (item.exit) break; } catch { /* 親が切れた */ } })();
  await sleep(300);
  clientB.kill(id, { tree: true });
  await sleep(2500);
  log('(d) child pid', childPid, 'agy processes before', agyBefore.join(','), '; alive after kill(tree):', childPid ? alive(childPid) : 'n/a', '; agy processes now', imageNames().filter(([n]) => /^agy/i.test(n)).map(([, pid]) => pid).join(','));
  out.ok = result1.status === 'SUCCESS' && result2.status === 'SUCCESS' && result1.conversation_id === conv && result2.conversation_id === conv;
  out.resultBeforeDetach = resultBeforeDetach;
} catch (error) {
  log('FAILED:', error?.stack ?? error);
} finally {
  log('CONVERSATION_ID(for cleanup):', conv);
  try { clientB?.shutdown(); clientA?.shutdown(); } catch { /* 下で pid を確かめる */ }
  await sleep(1500);
  if (holderPid) log('holder alive after shutdown:', alive(holderPid));
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
