// 段階 3 の 3-0 a: サブエージェントが走っている Codex の付け直し。LLM は呼ばない（偽のモデル提供元。SPAWN:<依頼文>）。
//   node 80-subagent-swap.mjs <running|approval>
//   running   親のターンも子のターンも走っている最中に A を外し、B が initialize も thread/resume も送らずに付け直す。
//             B に子の通知（threadId = 子）が届くか・親子は thread/read / thread/list の parentThreadId で引き直せるか・親も子も終わりまで届くか
//   approval  子が承認（SHELL）を求めている最中に入れ替える。B が子の依頼に答えて、子も親も続くか（依頼の threadId は子）
// 通知の一覧は method と threadId の別で数える。親子の判別は B がやることなので、ここでは B が読めるものだけを見る。
import { makeEnv, Rpc, handshake, log, sleep } from './lib.mjs';
import { HolderSim } from './holder-sim.mjs';
import { codexExe } from './lib.mjs';

const scenario = process.argv[2] ?? 'running';
process.env.SPAWN_PARENT_SLOW = scenario === 'running' ? '8' : '4';
const E = await makeEnv({ extraConfig: 'approval_policy = "never"' });
const holder = new HolderSim(codexExe(), ['app-server'], { env: E.env });
const attachClient = (name, from = 0, idBase = 0) => {
  const rpc = new Rpc(name, (s) => holder.write(s));
  rpc.nextId = idBase;
  holder.attach((line) => rpc.feed(line + '\n'), from);
  return rpc;
};
const shorten = (o, n = 300) => JSON.stringify(o)?.slice(0, n);
const byThread = (rpc, id) => rpc.notifications.filter((n) => n.params?.threadId === id);
try {
  const A = attachClient('A');
  await handshake(A);
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: scenario === 'approval' ? 'untrusted' : 'never', sandbox: 'danger-full-access' });
  const parent = ts.result.thread.id;
  const prompt = scenario === 'running' ? 'SPAWN:SLOW:10 child work' : 'SPAWN:SHELL child needs approval';
  await A.request('turn/start', { threadId: parent, input: [{ type: 'text', text: prompt, text_elements: [] }] });
  // 子が生まれるまで。0.160.0 は子の thread/started を出さず、親の collabAgentToolCall(spawnAgent) の receiverThreadIds が子の id を運ぶ
  const spawned = await A.waitFor((n) => n.params?.item?.type === 'collabAgentToolCall' && (n.params.item.receiverThreadIds ?? []).length > 0, 20000, 'spawnAgent item');
  const child = spawned?.params?.item?.receiverThreadIds?.[0];
  const childStarted = A.notifications.find((n) => n.method === 'thread/started' && n.params?.thread?.id === child);
  log('child thread:', child, '| thread/started for the child seen:', Boolean(childStarted), '| collab item:', shorten({ tool: spawned?.params?.item?.tool, sender: spawned?.params?.item?.senderThreadId === parent }, 200));
  if (scenario === 'running') {
    await A.waitFor((n) => n.method === 'item/agentMessage/delta' && n.params?.threadId === child, 20000, 'child delta');
    await sleep(1000);
  } else {
    const req = await A.waitFor((m) => m.id !== undefined && m.method && m.params?.threadId === child, 20000, 'child approval request');
    log('A got the child approval request: id', req?.id, 'method', req?.method, 'threadId is child:', req?.params?.threadId === child);
  }
  const aSeen = holder.seq;
  const aParent = byThread(A, parent).length, aChild = byThread(A, child).length;
  holder.detach();
  log(`A detached at seq ${aSeen}. A saw: parent ${aParent}, child ${aChild} notifications`);
  await sleep(3000);
  log('gap over; lines buffered during the gap:', holder.seq - aSeen);
  const B = attachClient('B', aSeen, 1000);          // initialize も thread/resume も送らない
  // 付け直した直後の B が、親子を引き直す道
  const loaded = await B.request('thread/loaded/list', {});
  log('B thread/loaded/list ->', shorten(loaded.result ?? loaded, 300));
  const readChild = await B.request('thread/read', { threadId: child });
  log('B thread/read(child): parentThreadId =', readChild.result?.thread?.parentThreadId, 'agentNickname =', readChild.result?.thread?.agentNickname, readChild.error ? shorten(readChild.error) : '');
  const list = await B.request('thread/list', { parentThreadId: parent, limit: 100 });
  log('B thread/list{parentThreadId} -> ids', shorten((list.result?.data ?? []).map((t) => t.id)), 'contains child:', (list.result?.data ?? []).some((t) => t.id === child));
  if (scenario === 'approval') {
    const req = B.serverRequests[0];
    log('B was redelivered the child approval request? (replay from ack — the request was before ack; manual redelivery as the holder would do):', Boolean(req));
    // 保持役は、答えていない依頼を控えて付け直しで渡し直す。この身代わりは控えを持たないので、A が見た依頼をそのまま渡す
    const pending = A.serverRequests[0];
    B.dispatch(pending);
    B.respond(pending.id, { decision: 'accept' });
  }
  const doneChild = await B.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === child, 30000, 'child turn/completed');
  const doneParent = await B.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === parent, 30000, 'parent turn/completed');
  log('B got child turn/completed:', Boolean(doneChild), shorten(doneChild?.params?.turn?.status), '| parent turn/completed:', Boolean(doneParent), shorten(doneParent?.params?.turn?.status));
  const aDeltas = (id) => A.notifications.filter((n) => n.method === 'item/agentMessage/delta' && n.params?.threadId === id).length;
  const bDeltas = (id) => B.notifications.filter((n) => n.method === 'item/agentMessage/delta' && n.params?.threadId === id).length;
  log(`deltas A+B: parent ${aDeltas(parent)}+${bDeltas(parent)}, child ${aDeltas(child)}+${bDeltas(child)}`);
  const collabItems = B.notifications.filter((n) => n.params?.item?.type === 'collabAgentToolCall' || n.params?.item?.type === 'subAgentActivity').map((n) => `${n.method}:${n.params.item.type}:${n.params.item.tool ?? n.params.item.kind}`);
  log('B subagent items:', collabItems.join(' '));
  log('B methods:', B.summary());
  // 付け直した後に、親へ次のターンを始められるか
  const t2 = await B.request('turn/start', { threadId: parent, input: [{ type: 'text', text: 'hello again', text_elements: [] }] });
  const done2 = await B.waitFor((n) => n.method === 'turn/completed' && n.params?.turn?.id === t2.result?.turn?.id, 20000, 'turn2');
  log('B second turn on the parent completed:', Boolean(done2));
} finally {
  log('stderr tail:', holder.err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /ERROR|error|WARN/.test(l) && !/featured plugin/.test(l)).slice(-5).join(' | ').slice(0, 600));
  holder.kill(); await sleep(800); await E.close();
}
