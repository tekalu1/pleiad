// 段階 3 の 3-0 b: 承認を数分待たせたときの付け直し。LLM は呼ばない（偽のモデル提供元。SHELL）。
//   node 81-approval-long-wait.mjs [待つ秒数 = 240]
// 承認の依頼（item/commandExecution/requestApproval）が A に届いた後、誰も答えないまま A を外し、B・C と 2 回入れ替えながら待つ（親が居ない間も保持役が出力を溜め続ける形）。
// app-server が承認を打ち切らないか（ターンが失敗・中断にならないか）、最後に付けたクライアントの答えで続くかを見る。保持役が控えた依頼は同じ id で渡し直す
import { makeEnv, Rpc, handshake, log, sleep } from './lib.mjs';
import { HolderSim } from './holder-sim.mjs';
import { codexExe } from './lib.mjs';

const total = Number(process.argv[2] ?? 240);
const E = await makeEnv({ extraConfig: 'approval_policy = "never"' });
const holder = new HolderSim(codexExe(), ['app-server'], { env: E.env });
const attachClient = (name, from = 0, idBase = 0) => {
  const rpc = new Rpc(name, (s) => holder.write(s));
  rpc.nextId = idBase;
  holder.attach((line) => rpc.feed(line + '\n'), from);
  return rpc;
};
const shorten = (o, n = 300) => JSON.stringify(o)?.slice(0, n);
try {
  const A = attachClient('A');
  await handshake(A);
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;
  const t1 = await A.request('turn/start', { threadId, input: [{ type: 'text', text: 'SHELL please', text_elements: [] }] });
  const turnId = t1.result.turn.id;
  const pending = await A.waitFor((m) => m.id !== undefined && m.method, 15000, 'approval request');
  const askedAt = Date.now();
  log('approval request pending: id', pending.id, pending.method);
  let seen = holder.seq;
  holder.detach();
  const wake = (sec) => sleep(Math.max(0, askedAt + sec * 1000 - Date.now()));
  // 1 回目の入れ替え: 10 秒後に B（依頼は渡し直さない。ack の位置から）
  await wake(10);
  const B = attachClient('B', seen, 1000);
  log('B attached at +10s; lines since ack:', holder.seq - seen, '(serverRequests redelivered by replay:', B.serverRequests.length, ')');
  const stateAt = async (rpc, label) => {
    const read = await rpc.request('thread/read', { threadId, includeTurns: true });
    const turn = (read.result?.thread?.turns ?? []).find((t) => t.id === turnId);
    const status = (await rpc.request('thread/loaded/list', {})).result;
    log(`${label}: turn status =`, turn?.status, '| thread status =', shorten(read.result?.thread?.status), '| loaded =', shorten(status?.data?.length));
  };
  await stateAt(B, 'B at +10s');
  // 2 回目: total / 2 秒後に C へ。B が受け取った通番まで
  seen = holder.seq;
  holder.detach();
  await wake(Math.floor(total / 2));
  const C = attachClient('C', seen, 2000);
  log(`C attached at +${Math.floor(total / 2)}s; lines since ack:`, holder.seq - seen);
  await stateAt(C, `C at +${Math.floor(total / 2)}s`);
  seen = holder.seq;
  // 最後: total 秒後に、控えた依頼の id で C から答える
  await wake(total);
  log(`answering from C at +${Math.round((Date.now() - askedAt) / 1000)}s with the original id`, pending.id);
  C.dispatch(pending);
  await stateAt(C, 'C just before answering');
  C.respond(pending.id, { decision: 'accept' });
  const done = await C.waitFor((n) => n.method === 'turn/completed', 30000, 'turn/completed');
  log('turn/completed =', Boolean(done), 'status =', done?.params?.turn?.status);
  const item = [...C.notifications].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution');
  log('commandExecution:', shorten(item?.params?.item && { status: item.params.item.status, out: String(item.params.item.aggregatedOutput ?? '').slice(0, 40) }));
  log('C methods since answer:', C.summary());
} finally {
  log('stderr tail:', holder.err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /ERROR|error|WARN/.test(l) && !/featured plugin|defaultPrompt/.test(l)).slice(-5).join(' | ').slice(0, 600));
  holder.kill(); await sleep(800); await E.close();
}
