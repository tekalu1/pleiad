// 端末の AI からの委譲の口 /agent（ホストの側。core/remote/agent-port.mjs、docs/remote.md §4.5、ADR 0141）。
// 中継（relay/server.mjs）をこのプロセスで立て、fake バックエンドのサーバーを別プロセスで立て、試験用の端末（tests/lib/remote-device.mjs）から
// /agent を開く。LLM もネットワークも使わない。許可（既定オフ・デスクトップ版の端末だけ・人だけが変える）・防火壁・委譲と状態と完了・
// 承認モードの継承と引き上げの確かめ・上限・出どころ・承認の中継と人の答え（受領証・1 回だけ・ほかの端末は答えられない）・取り消しで止まる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { pairDevice, connectDevice } from '../lib/remote-device.mjs';
import { openAgent, requesterOf } from '../lib/remote-agent-client.mjs';
import { checkPath } from '../../core/remote/forward.mjs';
import { createAgentPort } from '../../core/remote/agent-port.mjs';
import { AGENT_LIMITS, remoteOwnerId, parseRemoteOwner, normalizeRequester, relayReceipt } from '../../core/remote/agent-protocol.mjs';

export const name = 'remote-agent';
export const title = '端末の AI からの委譲の口（/agent）: 許可・防火壁・委譲と状態・承認モード・上限・承認の中継と人の答え・取り消し';

const SECRET = crypto.randomBytes(32).toString('base64url');
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const rejects = p => p.then(() => null, e => e);

export default async function (t) {
  // ---- 純粋な部品
  t.ok('仮の親の ID は remote:<deviceId>:<会話> で、読み戻せる', (() => {
    const id = remoteOwnerId('dABC', 'sess:with:colon');
    const p = parseRemoteOwner(id);
    return id === 'remote:dABC:sess:with:colon' && p?.deviceId === 'dABC' && p?.sessionId === 'sess:with:colon' && parseRemoteOwner('local-session') === null && parseRemoteOwner('remote:x:') === null;
  })());
  t.ok('依頼元の正規化: 会話の ID が無ければ null、承認モードの不明な値は弱い側へ', (() => {
    const bad = normalizeRequester({ title: 'x' });
    const weak = normalizeRequester({ sessionId: 's', mode: { scope: 'root', autonomy: 'always', enforced: 'yes' } });
    return bad === null && weak.mode.scope === 'workspace' && weak.mode.autonomy === 'ask' && weak.mode.enforced === false;
  })());
  t.ok('受領証は承認の ID・タスク・道具・入力に結ばれる', (() => {
    const a = relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' });
    return a === relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' })
      && a !== relayReceipt({ id: '2', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' })
      && a !== relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 2 }, salt: 's' })
      && a !== relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 'z' });
  })());
  t.ok('防火壁: /agent は接続口が自分で受ける（checkPath は通すが、forwardStream はローカルへ通さない）', checkPath('/agent')?.pathname === '/agent');

  // ---- 口だけの部品（サーバーなし）: 頻度の上限
  {
    const sent = [];
    let stream;
    const mk = () => {
      const handlers = {};
      stream = { kind: 'ws', destroyed: false, localDone: false, on: (n, f) => { handlers[n] = f; }, accept: () => Promise.resolve(), send: m => { sent.push(JSON.parse(m)); return Promise.resolve(); }, close: () => Promise.resolve(), reset() {}, handlers };
      return stream;
    };
    const port = createAgentPort({ allowed: () => true, hostName: () => 'h', invoke: async () => ({ ok: 1 }), now: () => 1_000 });
    port.attach(mk(), { id: 'dX', name: 'x', platform: 'desktop' });
    await sleep(10);
    for (let i = 0; i < AGENT_LIMITS.perMinute + 3; i++) {
      stream.handlers.message(Buffer.from(JSON.stringify({ t: 'req', id: `a${i}`, op: 'send', args: { taskId: 'x', message: 'y' }, requester: requesterOf() })), true, () => {});
    }
    await sleep(50);
    const limited = sent.filter(m => m.t === 'res' && m.code === 'RATE_LIMITED').length;
    t.ok(`頻度の上限: delegate・send は 1 分に ${AGENT_LIMITS.perMinute} 件まで（超えた分は RATE_LIMITED）`, limited === 3 && sent.filter(m => m.t === 'res' && m.ok).length === AGENT_LIMITS.perMinute, `${limited}`);
  }

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-agent-')));
  const dataDir = path.join(scratch, 'data');
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
  const devices = [], agents = [];
  const pair = async (name, platform) => {
    const offer = await cmd('remotePairingStart');
    const from = c.mark();
    const p = pairDevice({ payload: offer.payload, name, platform });
    const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await cmd('remotePairingApprove', { id: req.request.id });
    const creds = await within(p.result, 15_000, 'ペアリングの結果');
    const d = await connectDevice(creds);
    devices.push(d);
    return { creds, d, id: creds.deviceId };
  };
  const agent = async dev => { const a = await within(openAgent(dev.d), 15_000, '/agent を開く'); if (a.accepted) agents.push(a); return a; };
  const hostRows = () => cmd('agentTasks');
  try {
    await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from: 0, ms: 10_000 });
    const laptop = await pair('laptop', 'desktop');
    const phone = await pair('Pixel 9', 'android');

    // ---- 既定はオフ
    const list0 = await cmd('remoteDevices');
    const lap0 = list0.find(d => d.id === laptop.id), pho0 = list0.find(d => d.id === phone.id);
    t.ok('端末の行に agent が出る: デスクトップ版は available・既定オフ、スマホは available でない', lap0.agent.available === true && lap0.agent.enabled === false && pho0.agent.available === false && pho0.agent.enabled === false, JSON.stringify([lap0.agent, pho0.agent]));
    const a0 = await agent(laptop);
    t.ok('オフの端末でも口は開くが、ready の allowed は false', a0.accepted && a0.ready.allowed === false && a0.ready.v === 1 && a0.ready.hostName === 'desk-test');
    const denied0 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:NO' });
    t.ok('許可していない端末の依頼は NOT_ALLOWED で、タスクは作られない', denied0.ok === false && denied0.code === 'NOT_ALLOWED' && (await hostRows()).length === 0, JSON.stringify(denied0));
    const http = await laptop.d.get('/agent');
    t.ok('/agent を HTTP で取りに来ても、ローカルのサーバーへは通さない（RESET 3）', http.reset === 3, String(http.reset ?? http.status));
    const wsOther = await laptop.d.ws('/agent/x');
    t.ok('/agent の下のパスも通さない（/ws 以外の WebSocket は RESET 3）', wsOther.reset === 3, JSON.stringify(wsOther.reset ?? wsOther.status));
    t.ok('スマホの端末では許可を入れられない（デスクトップ版の端末だけ）', Boolean(await rejects(cmd('setRemoteDeviceAgent', { id: phone.id, enabled: true }))));
    t.ok('知らない端末の許可は変えられない', Boolean(await rejects(cmd('setRemoteDeviceAgent', { id: 'dNOPE', enabled: true }))));
    const phoneAgent = await agent(phone);
    t.ok('スマホの端末の口の ready も allowed は false（依頼は NOT_ALLOWED）', phoneAgent.ready.allowed === false && (await phoneAgent.call('list', {})).code === 'NOT_ALLOWED');

    // ---- 許可を入れる（人だけ）
    const grant = await cmd('setRemoteDeviceAgent', { id: laptop.id, enabled: true });
    t.ok('許可を入れると端末の行の agent.enabled が true になる', grant.agent?.enabled === true);
    const allowedEv = await a0.next(e => e.t === 'allowed' && e.allowed === true, 5000, '許可の便り');
    t.ok('つながっている口へ allowed: true が届く', Boolean(allowedEv));
    const devFile = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8'));
    t.ok('devices.json の端末に agentDelegation: true が残る（秘密は増えない）', devFile.devices.find(d => d.id === laptop.id)?.agentDelegation === true && !devFile.devices.find(d => d.id === phone.id)?.agentDelegation);

    // ---- 委譲・状態・完了
    const req1 = requesterOf('conv-A', { title: 'CI を緑にする' });
    const d1 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:HELLO', title: 'ホストで挨拶', host: 'nested', remote: { evil: true } }, req1);
    t.ok('委譲が通り、taskId（ply-task-）とタスクの形が返る', d1.ok && /^ply-task-/.test(d1.result.task.taskId) && d1.result.task.requesterSessionId === 'conv-A', JSON.stringify(d1).slice(0, 200));
    const taskId = d1.result.task.taskId;
    const done1 = await a0.next(e => e.t === 'task' && e.task.taskId === taskId && e.task.status === 'completed', 15_000, '完了の便り');
    t.ok('完了すると task の便りで結果（最初のページ）が届く', done1.task.result === 'HELLO' && done1.task.resultLength === 5, JSON.stringify(done1.task).slice(0, 200));
    t.ok('承認モードは依頼元（都度確認）に合わせた', done1.task.mode === 'default');
    const rows1 = await hostRows();
    const row1 = rows1.find(r => r.taskId === taskId);
    t.ok('ホストの台帳の親は仮の ID（remote:<deviceId>:<端末の会話>）で、出どころ（requester）と remoteOrigin が残る',
      row1.parentSessionId === `remote:${laptop.id}:conv-A` && row1.requester?.deviceId === laptop.id && row1.requester?.sessionId === 'conv-A' && row1.remoteOrigin === true, JSON.stringify([row1.parentSessionId, row1.requester]));
    await sleep(300);
    const rows1b = await hostRows();
    t.ok('完了の通知は端末へ便りで届き（sent）、ホストの会話に新しいターンは始まらない', rows1b.find(r => r.taskId === taskId).notification === 'sent' && !(await cmd('listSessions')).some(s => s.title === 'CI を緑にする'));
    const sessions = await cmd('listSessions');
    const child = sessions.find(s => s.id === row1.sessionId);
    t.ok('子の会話に出どころ（delegation.remote）と、依頼元の承認モードが残る', child?.delegation?.remote?.deviceId === laptop.id && child.delegation.remote.title === 'CI を緑にする' && child.delegation.remote.mode?.autonomy === 'ask', JSON.stringify(child?.delegation));
    const st = await a0.call('status', { taskId }, req1);
    t.ok('status は同じ ID で結果と、写しの更新に使うタスクの形を返す', st.ok && st.result.result === 'HELLO' && st.result.task.status === 'completed');
    const stOther = await a0.call('status', { taskId }, requesterOf('conv-B'));
    t.ok('別の端末の会話の taskId は見えない（所有の判定は仮の親の ID で行う）', stOther.ok === false, JSON.stringify(stOther));
    const send1 = await a0.call('send', { taskId, message: 'echo:AGAIN' }, req1);
    t.ok('send で同じ子に追加の指示が届く', send1.ok, JSON.stringify(send1));
    const done2 = await a0.next(e => e.t === 'task' && e.task.taskId === taskId && e.task.status === 'completed' && e.task.result === 'AGAIN', 15_000, '追加の指示の完了');
    t.ok('追加の指示の結果も便りで届く', Boolean(done2));
    const sendSettings = await a0.call('send', { taskId, message: 'x', model: 'fast' }, req1);
    t.ok('子の設定を替える send（backend・model・effort）は、初版ではホストのタスクに使えない', sendSettings.ok === false && sendSettings.code === 'UNSUPPORTED', JSON.stringify(sendSettings));
    const list1 = await a0.call('list', {}, req1);
    t.ok('list はその依頼元の会話のタスクだけを返す', list1.ok && list1.result.tasks.length === 1 && list1.result.tasks[0].taskId === taskId);
    const sync1 = await (async () => { await a0.send({ t: 'sync', taskIds: [taskId] }); return a0.next(e => e.t === 'relays', 5000, 'sync の答え'); })();
    t.ok('sync でタスクの今の状態と、待っている中継する承認の一覧が返る', Boolean(sync1) && a0.events.filter(e => e.t === 'task' && e.task.taskId === taskId).length >= 3);

    // ---- 読み取り・計画モードの依頼元・引き上げ
    const ro = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:NO' }, requesterOf('conv-RO', { scope: 'readonly' }));
    t.ok('読み取り・計画モードの依頼元からは委譲できない（READ_ONLY_MODE）', ro.ok === false && ro.code === 'READ_ONLY_MODE', JSON.stringify(ro));
    const before = (await hostRows()).length;
    const esc = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC' }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('引き上げが要るときは子を作らず、計画（鍵・委譲先・モード）を返す', esc.ok && esc.result.plan?.key && esc.result.plan.modeId === 'auto' && (await hostRows()).length === before, JSON.stringify(esc));
    const bad = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC', confirm: 'wrong' }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('違う鍵では確定せず、計画を返し直す', bad.ok && bad.result.plan?.key === esc.result.plan.key && (await hostRows()).length === before);
    const ok2 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC', confirm: esc.result.plan.key }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('同じ鍵で確定すると子が作られ、モードは計画のもの', ok2.ok && ok2.result.task?.mode === 'auto', JSON.stringify(ok2).slice(0, 200));
    const noKind = await a0.call('delegate', { task: 'echo:X', backend: 'fake' }, req1);
    t.ok('kind が無いなど、手元と同じ検査はホストでも効く', noKind.ok === false);
    const garbage = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:G', cwd: path.join(scratch, 'no-such-dir') }, req1);
    t.ok('作業場所はホストのパスで解釈する（無いフォルダーは断る）', garbage.ok === false, JSON.stringify(garbage).slice(0, 160));

    // ---- 口の頑丈さ
    await a0.send({ t: 'req' }); await a0.raw.send('not json', { text: true }); await a0.send({ t: 'nonsense' }); await a0.send({ t: 'req', id: 'z', op: 'shell', args: {}, requester: requesterOf() });
    await a0.send({ t: 'ping' });
    t.ok('形の違う便り・知らない種類・委譲の 6 つ以外の操作は無視して、口は生きている（ping に pong）', Boolean(await a0.next(e => e.t === 'pong', 5000, 'pong')));
    const op = await a0.call('shell', { command: 'x' });
    t.ok('委譲の 6 つ以外の操作（invoke の汎用の道）は BAD_REQUEST', op.ok === false && op.code === 'BAD_REQUEST');

    // ---- 上限: 動いているタスクは 8 件まで
    const slowIds = [];
    for (let i = 0; i < AGENT_LIMITS.active; i++) {
      const r = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-S'));
      if (r.ok && r.result.task) slowIds.push(r.result.task.taskId);
    }
    t.ok(`動いているタスクは ${AGENT_LIMITS.active} 件まで（その分は通る）`, slowIds.length >= AGENT_LIMITS.active - 2, String(slowIds.length));
    const stats = (await cmd('remoteDevices')).find(d => d.id === laptop.id).agent;
    t.ok('端末の行に任された作業の数が出る', stats.active >= slowIds.length, JSON.stringify(stats));
    const over = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-S'));
    t.ok('上限を超えると TOO_MANY_TASKS', over.ok === false && over.code === 'TOO_MANY_TASKS', JSON.stringify(over));
    const stopped = await cmd('setRemoteDeviceAgent', { id: laptop.id, stopAll: true });
    await within((async () => { for (;;) { const rows = await hostRows(); if (rows.filter(r => r.parentSessionId?.startsWith(`remote:${laptop.id}:`)).every(r => !['queued', 'running', 'cancelling'].includes(r.status))) return; await sleep(100); } })(), 20_000, 'すべて止める');
    t.ok('「すべて止める」で任された作業がすべて止まる（許可は残る）', stopped.agent.enabled === true && (await cmd('remoteDevices')).find(d => d.id === laptop.id).agent.active === 0);
    const cancelLive = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-C'));
    const cancelId = cancelLive.result.task.taskId;
    await a0.next(e => e.t === 'task' && e.task.taskId === cancelId && e.task.status === 'running', 15_000, '実行中');
    const cx = await a0.call('cancel', { taskId: cancelId }, requesterOf('conv-C'));
    t.ok('cancel でホストのタスクが止まり、状態が便りで届く', cx.ok && Boolean(await a0.next(e => e.t === 'task' && e.task.taskId === cancelId && e.task.status === 'cancelled', 15_000, '取り消しの便り')));

    // ---- 承認の中継と人の答え（別の端末 desk2 で。laptop は頻度の上限に近い）
    const desk2 = await pair('desk2', 'desktop');
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: true });
    const ax = await agent(desk2);
    const reqP = requesterOf('conv-P', { title: '承認を試す会話' });
    const ask1 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const askTask = ask1.result.task.taskId;
    const relayEv = await ax.next(e => e.t === 'relay' && e.relay.taskId === askTask, 15_000, '中継する承認');
    const relay1 = relayEv.relay;
    t.ok('子の承認が依頼元へ中継される（承認の ID・受領証・道具・入力。常に許可は出さない）',
      relay1.toolName === 'fake_write' && relay1.canAlways === false && /^[0-9a-f]{64}$/.test(relay1.receipt) && relay1.requesterSessionId === 'conv-P' && relay1.input?.path === 'a.txt', JSON.stringify(relay1).slice(0, 220));
    const waitingEv = await ax.next(e => e.t === 'task' && e.task.taskId === askTask && e.task.status === 'waiting', 10_000, '承認待ちの便り');
    t.ok('承認待ちの間、タスクの状態は waiting', Boolean(waitingEv));
    const childP = waitingEv.task.sessionId;
    const hostCard = await c.waitFor(e => e.type === 'permission' && e.toolName === 'fake_write' && e.sessionId === childP, { from: 0, ms: 10_000 }).catch(() => null);
    t.ok('ホストの画面にも子の会話のカードが出る（常に許可も今どおり）', Boolean(hostCard) && hostCard.canAlways === true);
    t.ok('端末の行の「承認待ち」の数が増える', (await cmd('remoteDevices')).find(d => d.id === desk2.id).agent.waiting === 1);
    // 受領証が違う・別の ID・別の端末は答えられない
    await ax.send({ t: 'answer', id: relay1.id, receipt: 'f'.repeat(64), allow: true });
    const mismatch = await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '受領証の違う答え');
    t.ok('受領証が違う答えは捨てる（RECEIPT_MISMATCH）。承認は待ち続ける', mismatch.ok === false && mismatch.code === 'RECEIPT_MISMATCH' && (await c.cmd('running')).permissions.some(p => p.id === hostCard.id));
    await ax.send({ t: 'answer', id: 'no-such-relay', receipt: relay1.receipt, allow: true });
    t.ok('知らない承認の ID への答えは捨てる（NOT_FOUND）', (await ax.fresh(e => e.t === 'answered' && e.id === 'no-such-relay', 5000, '知らない ID')).code === 'NOT_FOUND');
    t.ok('別の端末（laptop）には中継されない', (await a0.none(e => e.t === 'relay' && e.relay.id === relay1.id)) === true);
    await a0.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: true });
    t.ok('別の端末が承認の ID と受領証を知っていても答えられない（NOT_FOUND）', (await a0.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '別の端末の答え')).code === 'NOT_FOUND');
    t.ok('それでも承認は待ち続ける', (await c.cmd('running')).permissions.some(p => p.id === hostCard.id));
    // 2 本目の口には、待っている承認が snapshot で届く
    const ax2 = await agent(desk2);
    t.ok('つなぎ直した口（2 本目）には、待っている承認が relays で届く', Boolean(await ax2.next(e => e.t === 'relays' && e.relays.some(r => r.id === relay1.id), 5000, '中継の snapshot')));
    // 正しい答え（許可）
    await ax.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: true });
    const answered = await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 10_000, '答えの受領');
    const ended = await ax.next(e => e.t === 'relayEnd' && e.id === relay1.id, 5000, '決着');
    t.ok('正しい受領証の答えは受け取られ、決着が端末の側（device）として流れる', answered.ok === true && ended.by === 'device' && ended.allow === true, JSON.stringify([answered, ended]));
    const askDone = await ax.next(e => e.t === 'task' && e.task.taskId === askTask && e.task.status === 'completed', 15_000, '承認後の完了');
    t.ok('許可はホストの子の承認として効き、子が続きを走らせる（許可された）', askDone.task.result === '許可された', askDone.task.result);
    t.ok('2 本目の口にも決着が届く', Boolean(await ax2.next(e => e.t === 'relayEnd' && e.id === relay1.id, 5000, '2 本目の決着')));
    await ax.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: false });
    t.ok('同じ承認への 2 回目の答えは受けない（1 回だけ）', (await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '2 回目')).code === 'NOT_FOUND');
    const hist = (await cmd('sessionChanges', { sessionId: childP })).changes;
    t.ok('人の答えは「human・via: remote-device・端末」で子の会話の記録に残る', hist.some(h => h.by === 'human' && h.via === 'remote-device' && h.byDevice === desk2.id && h.to === 'permission.answer'), JSON.stringify(hist));
    t.ok('委譲は「agent・via: remote・端末」で子の会話の記録に残る', hist.some(h => h.by === 'agent' && h.via === 'remote' && h.byDevice === desk2.id && h.to === 'delegation.delegate'), JSON.stringify(hist));

    // ホストで先に答える
    const ask2 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const ask2Id = ask2.result.task.taskId;
    const relay2 = (await ax.next(e => e.t === 'relay' && e.relay.taskId === ask2Id, 15_000, '2 件目の中継')).relay;
    const child2 = (await hostRows()).find(r => r.taskId === ask2Id).sessionId;
    const card2 = await within((async () => { for (;;) { const p = (await c.cmd('running')).permissions.find(x => x.sessionId === child2 && !x.relay); if (p) return p; await sleep(50); } })(), 10_000, 'ホストの承認カード');
    await cmd('resolvePermission', { id: card2.id, allow: false });
    const end2 = await ax.next(e => e.t === 'relayEnd' && e.id === relay2.id, 10_000, 'ホストで答えた決着');
    t.ok('ホストの画面で先に答えると、端末へ relayEnd（by: host・allow）が流れる', end2.by === 'host' && end2.allow === false, JSON.stringify(end2));
    await ax.send({ t: 'answer', id: relay2.id, receipt: relay2.receipt, allow: true });
    t.ok('決着した後の端末の答えは受けない', (await ax.fresh(e => e.t === 'answered' && e.id === relay2.id, 5000, '決着後の答え')).ok === false);

    // 質問のカードは中継しない（ホストの子の会話のカードにだけ出る）
    const q = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'question' }, reqP);
    const qId = q.result.task.taskId;
    await ax.next(e => e.t === 'task' && e.task.taskId === qId && e.task.status === 'waiting', 15_000, '質問の待ち');
    t.ok('子の質問のカード（kind: question）は端末へ中継しない', (await ax.none(e => e.t === 'relay' && e.relay.taskId === qId)) === true);
    await ax.call('cancel', { taskId: qId }, reqP);

    // 許可を切る: 口が閉じ、新しい依頼と答えは受けない。任された作業は止めない
    const ask3 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const ask3Id = ask3.result.task.taskId;
    const relay3 = (await ax.next(e => e.t === 'relay' && e.relay.taskId === ask3Id, 15_000, '3 件目の中継')).relay;
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: false });
    const closedCode = await within(ax.closed, 8000, '許可を切ったときの口');
    t.ok('許可を切ると口が閉じる（1008）', closedCode.code === 1008, JSON.stringify(closedCode));
    const aAgain = await agent(desk2);
    t.ok('切った後に開いた口は allowed: false で、依頼は NOT_ALLOWED', aAgain.ready.allowed === false && (await aAgain.call('list', {}, reqP)).code === 'NOT_ALLOWED');
    await aAgain.send({ t: 'answer', id: relay3.id, receipt: relay3.receipt, allow: true });
    t.ok('許可が無い端末の答えは受けない', (await aAgain.fresh(e => e.t === 'answered' && e.id === relay3.id, 5000, '許可なしの答え')).ok === false);
    t.ok('許可を切っても、任された作業は止めない（止めるのは「すべて止める」と取り消し）', ['running', 'queued'].includes((await hostRows()).find(r => r.taskId === ask3Id)?.status));

    // ---- 取り消し: 任された作業も止まり、口は閉じる
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: true });
    const aRev = await agent(desk2);
    await cmd('remoteRevoke', { id: desk2.id });
    await within((async () => { for (;;) { const rows = (await hostRows()).filter(r => r.parentSessionId?.startsWith(`remote:${desk2.id}:`)); if (rows.every(r => !['queued', 'running', 'cancelling'].includes(r.status))) return; await sleep(100); } })(), 20_000, '取り消しで止まる');
    t.ok('端末を取り消すと、任された作業もすべて止まる', (await hostRows()).filter(r => r.parentSessionId?.startsWith(`remote:${desk2.id}:`)).every(r => !['queued', 'running', 'cancelling'].includes(r.status)));
    t.ok('取り消すと口も閉じる', Boolean(await Promise.race([aRev.closed, sleep(5000).then(() => null)])));
  } finally {
    for (const a of agents) { try { a.close(); } catch {} }
    for (const d of devices) { try { d.close(); } catch {} }
    c.close();
    await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
