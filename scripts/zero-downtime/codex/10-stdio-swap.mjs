// 項目 1: 保持役が codex app-server の stdio を持ち、JSON-RPC の相手（クライアント）を入れ替える。
//   node 10-stdio-swap.mjs <scenario>
//   noreinit  : B は initialize を送らずに付け直す。走っているターンの続きが届くか
//   reinit    : B が initialize をもう一度送る。何が起きるか（その後の接続は無事か）
//   approval  : 承認の依頼の最中に入れ替える（A に届いた後 / 入れ替えの間に届いた場合）。B の答えが通るか
//   resume    : B が thread/resume を送る。走っているターンに何が起きるか
import { makeEnv, Rpc, handshake, log, sleep, INIT_PARAMS } from './lib.mjs';
import { HolderSim } from './holder-sim.mjs';
import { codexExe } from './lib.mjs';

const scenario = process.argv[2] ?? 'noreinit';
const E = await makeEnv();
const holder = new HolderSim(codexExe(), ['app-server'], { env: E.env });
const attachClient = (name, from = 0, idBase = 0) => {
  const rpc = new Rpc(name, (s) => holder.write(s));
  rpc.nextId = idBase;
  holder.attach((line) => rpc.feed(line + '\n'), from);
  return rpc;
};
const shorten = (o, n = 260) => JSON.stringify(o)?.slice(0, n);
try {
  const A = attachClient('A');
  await handshake(A);
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;
  log('thread', threadId);

  if (scenario === 'noreinit' || scenario === 'reinit' || scenario === 'resume') {
    await A.request('turn/start', { threadId, input: [{ type: 'text', text: 'SLOW:8', text_elements: [] }] });
    await A.waitFor((n) => n.method === 'item/agentMessage/delta', 10000, 'first delta');
    await sleep(1000);
    const aSeen = holder.seq;
    const aDeltas = A.notifications.filter((n) => n.method === 'item/agentMessage/delta').length;
    holder.detach();                              // A がいなくなる
    log('A detached at seq', aSeen, 'A saw deltas', aDeltas);
    await sleep(3000);                            // 入れ替えの間（3 秒）
    log('gap over; holder buffered lines during gap:', holder.seq - aSeen);
    const B = attachClient('B', aSeen, 1000);     // 新しい相手。A が受け取った通番の続きから
    if (scenario === 'reinit') {
      const r = await B.request('initialize', INIT_PARAMS);
      log('B second initialize ->', shorten(r));
      B.notify('initialized');
    }
    if (scenario === 'resume') {
      const r = await B.request('thread/resume', { threadId });
      log('B thread/resume ->', shorten(r, 500));
    }
    const l = await B.request('thread/loaded/list', {});
    log('B thread/loaded/list ->', shorten(l));
    const read = await B.request('thread/read', { threadId, includeTurns: true });
    log('B thread/read turn statuses ->', shorten((read.result?.thread?.turns ?? []).map((t) => t.status)), read.error ? shorten(read.error) : '');
    const done = await B.waitFor((n) => n.method === 'turn/completed', 20000, 'turn/completed');
    const bDeltas = B.notifications.filter((n) => n.method === 'item/agentMessage/delta').length;
    log('B got turn/completed:', !!done, 'B deltas:', bDeltas, 'A+B deltas (expect 16):', aDeltas + bDeltas, '(replay includes already-seen? from=ack so no dupes)');
    log('B notification methods:', B.summary());
    // 付け直した後に新しいターンを始められるか
    const t2 = await B.request('turn/start', { threadId, input: [{ type: 'text', text: 'hello again', text_elements: [] }] });
    const done2 = await B.waitFor((n) => n.method === 'turn/completed' && n.params?.turn?.id === t2.result?.turn?.id, 20000, 'turn2');
    log('B second turn completed:', !!done2);
  }

  if (scenario === 'approval') {
    // (a) 依頼が A に届いたあと、答えずに入れ替える
    await A.request('turn/start', { threadId, input: [{ type: 'text', text: 'SHELL please', text_elements: [] }] });
    const req = await A.waitFor((m) => m.id !== undefined && m.method, 15000, 'approval request');
    log('A got server request:', shorten(req, 500));
    const aSeen = holder.seq;
    holder.detach();
    await sleep(2500);
    const B = attachClient('B', aSeen, 1000);
    // 再送の規則: 答えていない依頼は、ack の位置にかかわらず控えとして渡し直す（ここでは A が見た依頼を B に渡す）
    const pendingReq = req;
    log('B (no replay of already-acked lines) serverRequests so far:', B.serverRequests.length, '-> re-deliver pending request manually');
    B.dispatch(pendingReq);
    // 承認の応答は、依頼の id のまま、別の接続（B）から送る
    B.respond(pendingReq.id, decisionFor(pendingReq));
    const done = await B.waitFor((n) => n.method === 'turn/completed', 20000, 'turn/completed');
    log('(a) after B answered: turn/completed =', !!done, 'status=', done?.params?.turn?.status);
    const item = [...B.notifications].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution');
    log('(a) commandExecution item:', shorten(item?.params?.item && { status: item.params.item.status, command: item.params.item.command, out: item.params.item.aggregatedOutput }, 300));
    const finalMsg = [...B.notifications].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage');
    log('(a) final agent message:', shorten(finalMsg?.params?.item?.text, 200));
    // 遅れて A が同じ id に答えたら（二重の答え）
    A.respond(pendingReq.id, decisionFor(pendingReq));
    await sleep(500);
    log('(a) double answer from A: server still alive =', holder.exit === null);

    // (b) 依頼が来たとき、誰も付いていなかった（入れ替えの間）
    holder.detach();
    const mark = holder.seq;
    const C = attachClient('C', holder.seq, 2000);
    holder.detach();
    await C.request('turn/start', { threadId, input: [{ type: 'text', text: 'SHELL again', text_elements: [] }] }).catch(() => {});
    await sleep(3000);
    log('(b) lines buffered with nobody attached:', holder.seq - mark);
    const D = attachClient('D', mark, 3000);
    const req2 = D.serverRequests[0];
    log('(b) D got replayed server request:', !!req2, req2 && shorten({ id: req2.id, method: req2.method }));
    if (req2) {
      D.respond(req2.id, decisionFor(req2));
      const done2 = await D.waitFor((n) => n.method === 'turn/completed', 20000, 'turn/completed (b)');
      log('(b) turn/completed =', !!done2, done2?.params?.turn?.status);
    }
  }
} finally {
  log('stderr tail:', holder.err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /ERROR|error|WARN/.test(l) && !/featured plugin/.test(l)).slice(-5).join(' | ').slice(0, 600));
  holder.kill(); await sleep(800); await E.close();
}

function decisionFor(req) {
  if (/commandExecution\/requestApproval|execCommandApproval/.test(req.method)) return { decision: 'accept' };
  if (/fileChange\/requestApproval|applyPatchApproval/.test(req.method)) return { decision: 'accept' };
  return { decision: 'accept' };
}
