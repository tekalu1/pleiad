// 段階 3 の 3-0 c: 裏の端末（unified_exec）が走っている Codex の付け直し。LLM は呼ばない（偽のモデル提供元。BGTERM）。
//   node 82-bg-terminal-swap.mjs
// A が裏の端末を 1 本起こして（exec_command が数百 ms で session id を返し、プロセスは走ったまま）ターンを終え、A を外す。
// B が initialize も thread/resume も送らずに付け直して、端末の一覧の形（thread/backgroundTerminals/list の要素。これまで未確認）・
// 止める（terminate）と item/completed が遅れて届くこと・端末の出力の通知が続くかを見る。codex-background.mjs の追跡器を B で作り直せるか（札に何を置くか）の材料
import { makeEnv, Rpc, handshake, log, sleep } from './lib.mjs';
import { HolderSim } from './holder-sim.mjs';
import { codexExe } from './lib.mjs';

const E = await makeEnv({ extraConfig: 'approval_policy = "never"' });
const holder = new HolderSim(codexExe(), ['app-server'], { env: E.env });
const attachClient = (name, from = 0, idBase = 0) => {
  const rpc = new Rpc(name, (s) => holder.write(s));
  rpc.nextId = idBase;
  holder.attach((line) => rpc.feed(line + '\n'), from);
  return rpc;
};
const shorten = (o, n = 500) => JSON.stringify(o)?.slice(0, n);
try {
  const A = attachClient('A');
  await handshake(A);
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;
  await A.request('turn/start', { threadId, input: [{ type: 'text', text: 'BGTERM start a background terminal', text_elements: [] }] });
  const done = await A.waitFor((n) => n.method === 'turn/completed', 30000, 'turn/completed');
  log('A: turn/completed =', Boolean(done));
  const cmdItems = A.notifications.filter((n) => n.params?.item?.type === 'commandExecution').map((n) => shorten({ m: n.method, id: n.params.item.id, status: n.params.item.status, processId: n.params.item.processId, source: n.params.item.source }, 240));
  log('A commandExecution notifications:', cmdItems.join(' | '));
  const aList = await A.request('thread/backgroundTerminals/list', { threadId });
  log('A thread/backgroundTerminals/list ->', shorten(aList));
  const aSeen = holder.seq;
  holder.detach();
  await sleep(3000);
  const B = attachClient('B', aSeen, 1000);
  const bList = await B.request('thread/backgroundTerminals/list', { threadId });
  log('B thread/backgroundTerminals/list ->', shorten(bList));
  const entries = bList.result?.data ?? bList.result?.terminals ?? [];
  const first = entries[0];
  log('entry keys:', first ? Object.keys(first).join(',') : '(none)');
  await sleep(2500);
  log('B methods after 2.5s (output deltas from the terminal?):', B.summary() || '(nothing)');
  // 止める: B から terminate。processId は一覧の要素か item の processId
  const processId = String(first?.processId ?? first?.process_id ?? A.notifications.find((n) => n.params?.item?.processId)?.params.item.processId ?? '');
  const term = await B.request('thread/backgroundTerminals/terminate', { threadId, processId });
  log('B terminate ->', shorten(term));
  await sleep(2000);
  log('B methods after terminate:', B.summary());
  const late = B.notifications.find((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution');
  log('late item/completed: turnId =', late?.params?.turnId, '(the old turn:', done?.params?.turn?.id, ') status =', late?.params?.item?.status);
  const after = await B.request('thread/backgroundTerminals/list', { threadId });
  log('B list after terminate ->', shorten(after));
} finally {
  log('stderr tail:', holder.err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /ERROR|error|WARN/.test(l) && !/featured plugin|defaultPrompt|Unknown model/.test(l)).slice(-5).join(' | ').slice(0, 600));
  holder.kill(); await sleep(800); await E.close();
}
