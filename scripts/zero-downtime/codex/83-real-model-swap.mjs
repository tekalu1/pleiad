// 段階 3 の 3-0 d: 本物のモデルでの付け直し（短い依頼を 2 ターンだけ。LLM を呼ぶ）。
//   node 83-real-model-swap.mjs
// 利用者の CODEX_HOME（認証つき）の codex を、自分で app-server として立てる（利用者の Codex のプロセスには触れない）。
//   ターン 1: 数を 1 から 40 まで 1 行ずつ出させ、本文の流れの最中に A を外して B が付け直す（initialize も thread/resume も送らない）。差分が欠けも重なりもしないか
//   ターン 2: `node --version` をシェルで 1 回走らせる（approvalPolicy untrusted）。承認の依頼が来たら A を外して 10 秒待ち、B から答える
// 終わりに、自分が作ったスレッドを thread/delete で消し、rollout のファイルが残っていれば（パスは thread/start の応答の thread.path）それだけを消す。
import fs from 'node:fs';
import path from 'node:path';
import { Rpc, handshake, log, sleep } from './lib.mjs';
import { HolderSim } from './holder-sim.mjs';
import { codexExe } from './lib.mjs';

const work = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu/work-real');
fs.mkdirSync(work, { recursive: true });
const env = { ...process.env, RUST_LOG: 'warn' };
const holder = new HolderSim(codexExe(), ['app-server', '-c', 'notify=[]'], { env })   // 利用者の config の notify（ターンの終わりに外部のコマンドを起こす）は使わない;
const attachClient = (name, from = 0, idBase = 0) => {
  const rpc = new Rpc(name, (s) => holder.write(s));
  rpc.nextId = idBase;
  holder.attach((line) => rpc.feed(line + '\n'), from);
  return rpc;
};
const shorten = (o, n = 300) => JSON.stringify(o)?.slice(0, n);
const created = [];
let rolloutPath = null;
try {
  const A = attachClient('A');
  await handshake(A);
  const ts = await A.request('thread/start', { cwd: work, approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: false });
  const threadId = ts.result?.thread?.id;
  if (!threadId) throw new Error(`thread/start failed: ${shorten(ts)}`);
  created.push(threadId);
  rolloutPath = ts.result.thread.path ?? null;
  log('thread', threadId, 'model', ts.result.model, 'path', rolloutPath);

  // ---- ターン 1: 本文の流れの最中に入れ替える
  const t1 = await A.request('turn/start', { threadId, effort: 'low', approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text: 'Print the integers from 1 to 40, one per line. Output nothing else and do not use any tools.', text_elements: [] }] });
  await A.waitFor((n) => n.method === 'item/agentMessage/delta', 60000, 'first delta');
  await sleep(300);
  const aSeen = holder.seq;
  const aDeltas = A.notifications.filter((n) => n.method === 'item/agentMessage/delta').length;
  holder.detach();
  log(`turn 1: A detached at seq ${aSeen} (A saw ${aDeltas} deltas)`);
  await sleep(2000);
  const B = attachClient('B', aSeen, 1000);
  const done1 = await B.waitFor((n) => n.method === 'turn/completed' && n.params?.turn?.id === t1.result?.turn?.id, 90000, 'turn 1 completed');
  const text = (rpc) => rpc.notifications.filter((n) => n.method === 'item/agentMessage/delta').map((n) => n.params.delta).join('');
  const joined = text(A) + text(B);
  const finalMsg = [...B.notifications].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage')?.params?.item?.text ?? '';
  log('turn 1: B got turn/completed =', Boolean(done1), 'status =', done1?.params?.turn?.status, '| B deltas:', B.notifications.filter((n) => n.method === 'item/agentMessage/delta').length);
  log('turn 1: A+B deltas joined equals the final message:', joined === finalMsg, `(joined ${joined.length} chars, final ${finalMsg.length} chars)`);
  log('turn 1: B methods (head):', B.summary().slice(0, 300));

  // ---- ターン 2: 承認の最中に入れ替える
  const t2 = await B.request('turn/start', { threadId, effort: 'low', approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text: 'Run `node --version` once with the shell tool, then reply with the single word: done', text_elements: [] }] });
  const req = await B.waitFor((m) => m.id !== undefined && m.method, 90000, 'approval request');
  if (!req) throw new Error(`no approval request (turn: ${shorten(t2)})`);
  log('turn 2: B got the approval request:', req.id, req.method, shorten({ command: req.params?.command, reason: req.params?.reason }, 200));
  const bSeen = holder.seq;
  holder.detach();
  await sleep(10000);
  log('turn 2: lines buffered while nobody was attached:', holder.seq - bSeen);
  const C = attachClient('C', bSeen, 2000);
  C.dispatch(req);                                  // 保持役の控えの渡し直しの代わり
  C.respond(req.id, { decision: 'accept' });
  const done2 = await C.waitFor((n) => n.method === 'turn/completed' && n.params?.turn?.id === t2.result?.turn?.id, 90000, 'turn 2 completed');
  const item = [...C.notifications].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution')?.params?.item;
  log('turn 2: C got turn/completed =', Boolean(done2), 'status =', done2?.params?.turn?.status, '| command status =', item?.status, 'out =', JSON.stringify(String(item?.aggregatedOutput ?? '').slice(0, 30)));
  const usage = [...C.notifications].reverse().find((n) => n.method === 'thread/tokenUsage/updated');
  log('turn 2: token usage notification present:', Boolean(usage));
} finally {
  // 後始末: 自分が作ったスレッドだけ
  try {
    const D = attachClient('D', holder.seq, 3000);
    for (const id of created) {
      const r = await D.request('thread/delete', { threadId: id });
      log('thread/delete', id, '->', shorten(r));
    }
  } catch (e) { log('delete failed', e.message); }
  holder.kill(); await sleep(1000);
  if (rolloutPath && fs.existsSync(rolloutPath)) { fs.rmSync(rolloutPath, { force: true }); log('removed the rollout file left behind:', rolloutPath); }
  else log('rollout file is gone:', rolloutPath, '(exists:', rolloutPath ? fs.existsSync(rolloutPath) : null, ')');
  log('created thread ids:', created.join(','));
  fs.rmSync(work, { recursive: true, force: true });
}
