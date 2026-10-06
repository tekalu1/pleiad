// 項目 2: codex app-server --listen ws:// で、接続を切って別の接続から付け直したとき、
// 走っているターンと承認待ちがどうなるか。
//   node 20-ws-reconnect.mjs turn | approval | approval-resume
import { makeEnv, Rpc, spawnAppServer, killTree, log, sleep, INIT_PARAMS } from './lib.mjs';
const scenario = process.argv[2] ?? 'turn';
const E = await makeEnv();
const child = spawnAppServer(E.env, ['--listen', 'ws://127.0.0.1:0']);
let port = null;
child.stderr.on('data', (d) => { const m = /listening on: ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) port = Number(m[1]); });
for (let i = 0; i < 100 && !port; i++) await sleep(100);
log('app-server ws port', port);
const shorten = (o, n = 260) => JSON.stringify(o)?.slice(0, n);

async function connect(name, idBase = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const rpc = new Rpc(name, (s) => ws.send(s.trim()));
  rpc.nextId = idBase;
  ws.onmessage = (ev) => rpc.feed(String(ev.data) + '\n');
  rpc.closed = new Promise((r) => { ws.onclose = (e) => r(e.code); });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error ' + (e.message ?? ''))); });
  rpc.ws = ws;
  return rpc;
}
const init = async (rpc) => { const r = await rpc.request('initialize', INIT_PARAMS); rpc.notify('initialized'); return r; };
const text = (s) => [{ type: 'text', text: s, text_elements: [] }];

try {
  const A = await connect('A');
  log('A initialize ->', shorten(await init(A), 160));
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;

  if (scenario === 'turn') {
    await A.request('turn/start', { threadId, input: text('SLOW:8') });
    await A.waitFor((n) => n.method === 'item/agentMessage/delta', 10000, 'delta');
    await sleep(800);
    log('A closes websocket; A saw', A.notifications.filter((n) => n.method === 'item/agentMessage/delta').length, 'deltas');
    A.ws.close(); await A.closed;
    await sleep(3000);
    const B = await connect('B', 1000);
    log('B initialize ->', shorten(await init(B), 120));
    log('B thread/loaded/list ->', shorten(await B.request('thread/loaded/list', {})));
    const read = await B.request('thread/read', { threadId, includeTurns: true });
    log('B thread/read statuses ->', shorten((read.result?.thread?.turns ?? []).map((t) => t.status)), shorten(read.error ?? ''));
    await sleep(1500);
    log('B notifications BEFORE any resume/subscribe:', B.summary() || '(none)');
    const rs = await B.request('thread/resume', { threadId });
    log('B thread/resume ->', rs.error ? shorten(rs.error) : 'ok; thread.status=' + shorten(rs.result?.thread?.status) + ' turns=' + shorten((rs.result?.thread?.turns ?? []).map((t) => t.status)));
    const done = await B.waitFor((n) => n.method === 'turn/completed', 15000, 'turn/completed');
    log('B got turn/completed after resume:', !!done, done?.params?.turn?.status);
    log('B notification methods after resume:', B.summary().slice(0, 500));
    const read2 = await B.request('thread/read', { threadId, includeTurns: true });
    const last = (read2.result?.thread?.turns ?? []).at(-1);
    log('final turn status from thread/read:', last?.status, 'items:', shorten((last?.items ?? []).map((i) => i.type)));
  }

  if (scenario === 'dual') {
    // 新旧のクライアントが同時につながっている間（引き継ぎの重なり）。通知・承認の依頼はどちらに届くか
    await A.request('turn/start', { threadId, input: text('SLOW:6') });
    await A.waitFor((n) => n.method === 'item/agentMessage/delta', 10000, 'delta');
    const B = await connect('B', 1000);
    await init(B);
    const rs = await B.request('thread/resume', { threadId });
    log('B resumed while A still connected ->', rs.error ? shorten(rs.error) : 'ok');
    await sleep(1500);
    const dA = A.notifications.filter((n) => n.method === 'item/agentMessage/delta').length;
    const dB = B.notifications.filter((n) => n.method === 'item/agentMessage/delta').length;
    log('while both connected: A deltas', dA, 'B deltas', dB);
    await A.waitFor((n) => n.method === 'turn/completed', 15000, 'A turn/completed');
    log('turn/completed on A:', A.notifications.some((n) => n.method === 'turn/completed'), 'on B:', B.notifications.some((n) => n.method === 'turn/completed'));
    // 承認の依頼: 両方がつながっているとき
    await A.request('turn/start', { threadId, input: text('SHELL please') });
    await sleep(2500);
    log('approval request delivered: A', A.serverRequests.length, 'B', B.serverRequests.length);
    const who = B.serverRequests[0] ? B : A;
    const req = who.serverRequests[0];
    if (req) {
      who.respond(req.id, { decision: 'accept' });
      await sleep(2500);
      const last = ((await A.request('thread/read', { threadId, includeTurns: true })).result?.thread?.turns ?? []).at(-1);
      log('answered via', who.name, '-> last turn', last?.status);
    }
    // 古い側(A)を切っても B は続くか
    const before = B.notifications.filter((x) => x.method === 'turn/completed').length;
    await A.request('turn/start', { threadId, input: text('SLOW:4') });
    await sleep(1000);
    A.ws.close(); await A.closed;
    const done = await B.waitFor(() => B.notifications.filter((x) => x.method === 'turn/completed').length > before, 15000, 'B turn/completed after A closed');
    log('after A closed, B still gets live notifications through turn end:', !!done);
  }

  if (scenario === 'approval' || scenario === 'approval-resume') {
    await A.request('turn/start', { threadId, input: text('SHELL please') });
    const req = await A.waitFor((m) => m.id !== undefined && m.method, 15000, 'approval request');
    log('A got server request:', shorten({ id: req.id, method: req.method }));
    A.ws.close(); await A.closed;
    log('A closed with the approval outstanding');
    await sleep(3000);
    const B = await connect('B', 1000);
    await init(B);
    log('B thread/loaded/list ->', shorten(await B.request('thread/loaded/list', {})));
    const read = await B.request('thread/read', { threadId, includeTurns: true });
    const last = (read.result?.thread?.turns ?? []).at(-1);
    log('B thread/read last turn:', last?.status, shorten((last?.items ?? []).map((i) => i.type + ':' + (i.status ?? ''))));
    await sleep(1000);
    log('B received server requests without resume:', B.serverRequests.length);
    if (scenario === 'approval-resume') {
      const rs = await B.request('thread/resume', { threadId });
      log('B thread/resume ->', rs.error ? shorten(rs.error) : 'ok status=' + shorten(rs.result?.thread?.status));
      await sleep(2000);
      log('B received server requests after resume:', B.serverRequests.length, shorten(B.serverRequests.map((m) => ({ id: m.id, method: m.method }))));
      const req2 = B.serverRequests[0];
      if (req2) {
        B.respond(req2.id, { decision: 'accept' });
        const done = await B.waitFor((n) => n.method === 'turn/completed', 15000, 'turn/completed');
        log('B answered replayed request; turn/completed:', !!done, done?.params?.turn?.status);
      }
    }
    // 元の id に別の接続から答える（B が知らない A の依頼 id へ）
    B.respond(req.id, { decision: 'accept' });
    await sleep(2500);
    const read3 = await B.request('thread/read', { threadId, includeTurns: true });
    const last3 = (read3.result?.thread?.turns ?? []).at(-1);
    log('after B answers A\'s old request id: last turn:', last3?.status, shorten((last3?.items ?? []).map((i) => i.type + ':' + (i.status ?? ''))));
    log('commandExecution detail:', shorten((last3?.items ?? []).filter((i) => i.type === 'commandExecution').map((i) => ({ status: i.status, out: i.aggregatedOutput, decl: i.declineReason ?? i.reason })), 300));
  }
} finally {
  log('stderr (errors):', child.stderrBuf.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /ERROR|error|WARN/.test(l) && !/featured plugin|defaultPrompt|Unknown model/.test(l)).slice(-6).join(' | ').slice(0, 800));
  killTree(child); await sleep(800); await E.close();
}
