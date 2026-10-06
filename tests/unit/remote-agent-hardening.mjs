// 端末の AI の口（core/remote/agent-port.mjs）へのレビュー後の守り（docs/remote.md §4.5、ADR 0146）。
//   口だけの部品（偽のストリーム）: 同時数の予約（確かめと行の作成の競合）・send の起こし直しも枠に数える・許可を切る／すべて止めるで作りかけの依頼を今打ち切る・
//     口の数の上限・sync が知らない ID を返す
//   サーバー越し（fake・中継・試験用の端末）: 取り消し・すべて止めるが任された子の子孫（孫）まで止める（終わった子の下の孫も）・止めた子の会話は新しいターンを始めない・
//     数にも孫を含める・質問の中継と答え・設定の変更の承認は「ホストの画面で答える」知らせ（口からは答えられない）・
//     端末の画面（中継越し）から許可を入れられない・send と cancel が子の会話の記録に残る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRelay } from '../../relay/server.mjs';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { pairDevice, connectDevice } from '../lib/remote-device.mjs';
import { openAgent, requesterOf } from '../lib/remote-agent-client.mjs';
import { createAgentPort } from '../../core/remote/agent-port.mjs';
import { AGENT_LIMITS } from '../../core/remote/agent-protocol.mjs';

export const name = 'remote-agent-hardening';
export const title = '端末の AI の口の守り: 同時数の予約・作りかけの打ち切り・子孫まで止める・質問と「ホストの画面で答える」承認の中継・端末の画面から許可を入れられない';

const SECRET = crypto.randomBytes(32).toString('base64url');
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const until = async (fn, ms, label) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`); await sleep(100); } };
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const control = (name, args) => 'control:' + JSON.stringify({ name, arguments: args });

class FakeStream extends EventEmitter {
  constructor() { super(); this.kind = 'ws'; this.destroyed = false; this.localDone = false; this.out = []; this.closed = null; }
  accept() { return Promise.resolve(); }
  send(body) { this.out.push(JSON.parse(body)); return Promise.resolve(); }
  close(code, reason) { this.localDone = true; this.closed = { code, reason }; return Promise.resolve(); }
  reset() { this.destroyed = true; }
  push(msg) { this.emit('message', Buffer.from(JSON.stringify(msg)), true, () => {}); }
}

export default async function (t) {
  const requester = { sessionId: 's1', mode: { scope: 'workspace', autonomy: 'ask' } };
  const mk = (deps, id = 'dev') => { const port = createAgentPort(deps); const s = new FakeStream(); port.attach(s, { id, name: 'laptop', platform: 'desktop' }); return { port, s }; };

  // ---- 口だけ: 同時数の予約
  {
    let created = 0;
    const { s } = mk({ allowed: () => true, activeTasks: () => created, invoke: async () => { await sleep(40); created++; return { task: { taskId: `t${created}` } }; } });
    await sleep(5);
    for (let i = 0; i < 20; i++) s.push({ t: 'req', id: `r${i}`, op: 'delegate', args: {}, requester });
    await sleep(300);
    const ok = s.out.filter(m => m.t === 'res' && m.ok).length, over = s.out.filter(m => m.code === 'TOO_MANY_TASKS').length;
    t.ok(`同時に 20 件の delegate を投げても、動いている数の上限（${AGENT_LIMITS.active}）を超えて通らない（確かめる前に枠を予約する）`, ok === AGENT_LIMITS.active && over === 20 - AGENT_LIMITS.active, `ok=${ok} over=${over}`);
  }
  // ---- 口だけ: send の起こし直しも枠を使う（動いているタスクへの send は使わない）
  {
    let wake = true;
    const { s } = mk({ allowed: () => true, activeTasks: () => AGENT_LIMITS.active, wakes: () => wake, invoke: async () => ({ ok: 1 }) });
    await sleep(5);
    s.push({ t: 'req', id: 'a', op: 'send', args: { taskId: 'x', message: 'y' }, requester });
    wake = false;
    s.push({ t: 'req', id: 'b', op: 'send', args: { taskId: 'x', message: 'y' }, requester });
    await sleep(100);
    t.ok('終わったタスクを起こし直す send は枠が要り（上限なら TOO_MANY_TASKS）、動いているタスクへの send は要らない',
      s.out.find(m => m.id === 'a')?.code === 'TOO_MANY_TASKS' && s.out.find(m => m.id === 'b')?.ok === true);
  }
  // ---- 口だけ: 許可を切る・すべて止めるで、作りかけの依頼を今打ち切る
  for (const how of ['closeDevice', 'cutOff']) {
    let aborted = false, sawValid = null;
    const { port, s } = mk({ allowed: () => true, invoke: async ({ signal, valid }) => { signal.addEventListener('abort', () => { aborted = true; }); await sleep(120); sawValid = valid(); return { task: { taskId: 'late' } }; } }, `dev-${how}`);
    await sleep(5);
    s.push({ t: 'req', id: 'r1', op: 'delegate', args: {}, requester });
    await sleep(20);
    port[how](`dev-${how}`, 'revoked');
    const abortedNow = aborted;
    await sleep(250);
    const res = s.out.find(m => m.t === 'res' && m.id === 'r1');
    t.ok(`${how === 'closeDevice' ? '許可を切る・取り消す' : '「すべて止める」'}と、作りかけの依頼は相手の close を待たずに今打ち切られ（signal）、終わっても子を作った答えを返さない（NOT_ALLOWED）`,
      abortedNow === true && sawValid === false && (res ? res.ok === false && res.code === 'NOT_ALLOWED' : how === 'closeDevice'), JSON.stringify({ abortedNow, sawValid, res }));
  }
  // ---- 口だけ: 口の数の上限
  {
    const port = createAgentPort({ allowed: () => true, invoke: async () => ({}) });
    const streams = [];
    for (let i = 0; i < AGENT_LIMITS.portsPerDevice + 1; i++) { const s = new FakeStream(); port.attach(s, { id: 'dev-ports', name: 'x', platform: 'desktop' }); streams.push(s); }
    await sleep(30);
    t.ok(`端末 1 台の口は ${AGENT_LIMITS.portsPerDevice} 本まで（それを超える口は受けてすぐ閉じる）`, streams.slice(0, AGENT_LIMITS.portsPerDevice).every(s => !s.closed) && streams.at(-1).closed?.code === 1013);
  }
  // ---- 口だけ: sync は知らない ID を返す
  {
    const { s } = mk({ allowed: () => true, tasksFor: (_d, ids) => ids.filter(i => i === 'known').map(taskId => ({ taskId })), invoke: async () => ({}) });
    await sleep(5);
    s.push({ t: 'sync', taskIds: ['known', 'gone1', 'gone2'] });
    await sleep(50);
    const synced = s.out.find(m => m.t === 'synced');
    t.ok('sync の答えに、ホストが知らない ID（unknown）が載る', synced?.unknown?.join() === 'gone1,gone2' && s.out.some(m => m.t === 'task' && m.task.taskId === 'known'));
  }

  // ---- サーバー越し
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-hardening-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ confirmAgentSites: true, agentSitePermissions: [] }));
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
  const devices = [], agents = [];
  const pair = async (name, platform = 'desktop') => {
    const offer = await cmd('remotePairingStart');
    const from = c.mark();
    const p = pairDevice({ payload: offer.payload, name, platform });
    const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await cmd('remotePairingApprove', { id: req.request.id });
    const creds = await within(p.result, 15_000, 'ペアリング');
    const d = await connectDevice(creds);
    devices.push(d);
    return { creds, d, id: creds.deviceId };
  };
  const agent = async dev => { const a = await within(openAgent(dev.d), 15_000, '/agent'); agents.push(a); return a; };
  const hostRows = () => cmd('agentTasks');
  const sessions = () => cmd('listSessions');
  try {
    await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from: 0, ms: 10_000 });

    // ---- 端末の画面（中継越しの /ws）から、ホストの許可を入れられない（切る・すべて止めるはできる）
    const lap = await pair('laptop');
    const w = await lap.d.ws('/ws');
    await w.next();   // ready
    let n = 0;
    const wsCmd = async (command, args) => {
      const id = `w${++n}`;
      await w.send(JSON.stringify({ kind: 'command', command, id, args }));
      for (let i = 0; i < 50; i++) { const m = JSON.parse(await w.next()); if (m.kind === 'response' && m.id === id) return m; }
      throw new Error('応答が来ない');
    };
    const tryOn = await wsCmd('setRemoteDeviceAgent', { id: lap.id, enabled: true });
    t.ok('端末の画面（中継越し）からは、自分の「AI からの依頼を受ける」を入れられない（ホストの PC の画面だけ）',
      tryOn.ok === false && !(await cmd('remoteDevices')).find(d => d.id === lap.id).agent.enabled, JSON.stringify(tryOn));
    await cmd('setRemoteDeviceAgent', { id: lap.id, enabled: true });
    const tryOff = await wsCmd('setRemoteDeviceAgent', { id: lap.id, enabled: false });
    t.ok('切るのは端末の画面からもできる', tryOff.ok === true && !(await cmd('remoteDevices')).find(d => d.id === lap.id).agent.enabled);
    await cmd('setRemoteDeviceAgent', { id: lap.id, enabled: true });
    const a = await agent(lap);

    // ---- 取り消し・すべて止めるが、子の子孫まで止める
    const req = requesterOf('conv-G', { title: '孫を作らせる' });
    const grandPrompt = ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow', title: '孫' });
    const d1 = await a.call('delegate', { kind: 'mechanical', backend: 'fake', task: grandPrompt, title: '子' }, req);
    const childTask = d1.result.task.taskId;
    const child = await until(async () => (await hostRows()).find(r => r.taskId === childTask && r.sessionId), 30_000, '子の行');
    const grand = await until(async () => (await hostRows()).find(r => r.parentSessionId === child.sessionId && r.status === 'running'), 30_000, '孫が動いている');
    t.ok('任された作業の数に、ホストの中で子が作った孫も数える（子 1 + 孫 1）', (await cmd('remoteDevices')).find(d => d.id === lap.id).agent.active === 2, JSON.stringify((await cmd('remoteDevices')).find(d => d.id === lap.id).agent));
    const mark = c.mark();
    await cmd('setRemoteDeviceAgent', { id: lap.id, stopAll: true });
    await until(async () => (await hostRows()).find(r => r.taskId === grand.taskId)?.status === 'cancelled', 20_000, '孫が止まる');
    t.ok('「すべて止める」は、任された子の下の孫まで止める（子も止まる）', Boolean(await until(async () => (await hostRows()).find(r => r.taskId === childTask).status === 'cancelled', 20_000, '子が止まる').catch(() => null)));
    const marked = (await sessions()).find(s => s.id === child.sessionId);
    t.ok('止めた子の会話には「止めた」印が付く（その会話へ後から届く通知で、新しいターンを始めない）', Boolean(marked?.delegation?.remote?.stoppedAt));
    await sleep(800);
    t.ok('止めた後、子の会話で新しいターンは始まらない', !c.since(mark).some(e => e.type === 'turnStart' && e.sessionId === child.sessionId));
    t.ok('止めた後は、動いている作業は 0', (await cmd('remoteDevices')).find(d => d.id === lap.id).agent.active === 0);

    // 取り消し（子の孫）
    const lap2 = await pair('laptop2');
    await cmd('setRemoteDeviceAgent', { id: lap2.id, enabled: true });
    const a2 = await agent(lap2);
    const d2 = await a2.call('delegate', { kind: 'mechanical', backend: 'fake', task: grandPrompt, title: '子 2' }, requesterOf('conv-H'));
    const child2 = await until(async () => (await hostRows()).find(r => r.taskId === d2.result.task.taskId && r.sessionId), 30_000, '子 2');
    const grand2 = await until(async () => (await hostRows()).find(r => r.parentSessionId === child2.sessionId && r.status === 'running'), 30_000, '孫 2');
    await cmd('remoteRevoke', { id: lap2.id });
    await until(async () => (await hostRows()).find(r => r.taskId === grand2.taskId)?.status === 'cancelled', 20_000, '取り消しで孫が止まる');
    t.ok('端末の取り消しも、任された子の下の孫まで止める', Boolean(await until(async () => (await hostRows()).find(r => r.taskId === d2.result.task.taskId).status === 'cancelled', 20_000, '子 2 が止まる').catch(() => null)));

    // ---- 質問・設定の変更の承認の中継
    const lap3 = await pair('laptop3');
    await cmd('setRemoteDeviceAgent', { id: lap3.id, enabled: true });
    const a3 = await agent(lap3);
    const reqQ = requesterOf('conv-Q');
    const q = await a3.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'question' }, reqQ);
    const qRelay = (await a3.next(e => e.t === 'relay' && e.relay.taskId === q.result.task.taskId, 15_000, '質問の中継')).relay;
    t.ok('子の質問（kind: question）も端末へ中継される（質問の中身つき）', qRelay.kind === 'question' && qRelay.questions?.[0]?.question === 'どれにする？' && qRelay.canAlways === false, JSON.stringify(qRelay).slice(0, 200));
    await a3.send({ t: 'answer', id: qRelay.id, receipt: qRelay.receipt, allow: true, answers: { 'どれにする？': 'A' } });
    const qAnswered = await a3.fresh(e => e.t === 'answered' && e.id === qRelay.id, 10_000, '質問の答え');
    const qDone = await a3.next(e => e.t === 'task' && e.task.taskId === q.result.task.taskId && e.task.status === 'completed', 20_000, '質問後の完了');
    t.ok('端末の答え（選んだ項目）が子へ届く（承認と同じ道・受領証・1 回だけ）', qAnswered.ok === true && qDone.task.result === '回答: {"どれにする？":"A"}', qDone.task.result);
    await a3.send({ t: 'answer', id: qRelay.id, receipt: qRelay.receipt, allow: true, answers: { 'どれにする？': 'B' } });
    t.ok('同じ質問への 2 回目は受けない', (await a3.fresh(e => e.t === 'answered' && e.id === qRelay.id, 5000, '2 回目')).code === 'NOT_FOUND');

    const setting = await a3.call('delegate', { kind: 'mechanical', backend: 'fake', task: control('set_setting', { key: 'confirmAgentSites', value: false, reason: 'テスト' }) }, reqQ);
    const sRelay = (await a3.next(e => e.t === 'relay' && e.relay.taskId === setting.result.task.taskId, 20_000, '設定の変更の承認の知らせ')).relay;
    t.ok('設定の変更の承認は、答えられない「ホストの画面で答える」知らせとして端末へ届く（kind: hostOnly）', sRelay.kind === 'hostOnly' && sRelay.canAlways === false, JSON.stringify(sRelay).slice(0, 200));
    await a3.send({ t: 'answer', id: sRelay.id, receipt: sRelay.receipt, allow: true });
    const sAns = await a3.fresh(e => e.t === 'answered' && e.id === sRelay.id, 5000, '知らせへの答え');
    t.ok('「ホストの画面で答える」知らせへは、口から答えられない（受領証が合っても NOT_ANSWERABLE）', sAns.ok === false && sAns.code === 'NOT_ANSWERABLE');
    const hostCard = await c.waitFor(e => e.type === 'permission' && e.settingChange && e.sessionId === (setting.result.task.sessionId ?? e.sessionId), { from: 0, ms: 10_000 });
    await cmd('resolvePermission', { id: hostCard.id, allow: false, receipt: hostCard.settingChange.receipt });
    const sEnd = await a3.next(e => e.t === 'relayEnd' && e.id === sRelay.id, 10_000, '知らせの決着');
    t.ok('ホストの画面で答えると、知らせは畳まれる（by: host）', sEnd.by === 'host');

    // ---- send・cancel が子の会話の記録に残る
    const s1 = await a3.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ONE' }, requesterOf('conv-R'));
    const rTask = s1.result.task.taskId;
    await a3.next(e => e.t === 'task' && e.task.taskId === rTask && e.task.status === 'completed', 15_000, '完了');
    await a3.call('send', { taskId: rTask, message: 'echo:TWO' }, requesterOf('conv-R'));
    await a3.next(e => e.t === 'task' && e.task.taskId === rTask && e.task.result === 'TWO', 15_000, '追加の指示の完了');
    await a3.call('cancel', { taskId: rTask }, requesterOf('conv-R'));
    const rSession = (await hostRows()).find(r => r.taskId === rTask).sessionId;
    const changes = (await cmd('sessionChanges', { sessionId: rSession })).changes;
    t.ok('send と cancel は「agent・via: remote・端末」で子の会話の記録に残る',
      ['delegation.taskSend', 'delegation.taskCancel'].every(to => changes.some(h => h.by === 'agent' && h.via === 'remote' && h.byDevice === lap3.id && h.to === to)), JSON.stringify(changes.map(h => h.to)));
  } finally {
    for (const x of agents) { try { x.close(); } catch {} }
    for (const d of devices) { try { d.close(); } catch {} }
    c.close();
    await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
