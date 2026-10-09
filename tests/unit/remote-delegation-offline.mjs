// ホストの PC が止まったままのとき、依頼元の会話（親の AI）へ知らせる（ADR 0171「ホストが落ちたままのとき」、ADR 0146「切れたとき」）。
//   - 終わっていない子のあるホストが一定時間オフラインのままなら、親ごとに 1 通（ホスト名・いつから・子の数と題）。同じオフラインの間は間隔を空けて 1 回だけ重ねる
//   - 短い切断・main の更新の間（橋の口が無い間）・終わった子だけのホストでは鳴らない
//   - 知らせたホストがつながり直したら、追いつき（sync）の結果を親ごとに 1 通（まだ走っている・終わった・ホストに記録が無い）
//   - ホストの再起動で子の会話が無くなった行は、sync で interrupted として届き、完了通知の対象になる（running のまま残らない）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createRemoteDelegation } from '../../core/remote-delegation.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'remote-delegation-offline';
export const title = 'ホストが落ちたままのとき親へ知らせる・つながり直したら追いつきを 1 通で知らせる';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = n => `ply-task-${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
const until = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout');};
const MIN = 60000;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-remote-offline-'));
  let clock = 1_000_000;
  const delivered = [];
  const manager = await createAgentTasks({ dataDir: dir, now: () => clock, silenceMinutes: 0, commandMinutes: 0, backgroundMinutes: 0, log: () => {},
    prepare: async () => ({ sessionId: 'local', backend: 'fake' }), execute: async () => ({ outcome: 'ok' }),
    ready: async () => true, deliver: async tasks => { delivered.push(...tasks.map(x => x.taskId)); return 'ok'; } });
  const handlers = { event: [], state: [], ready: [], hosts: [] };
  const syncs = [];
  const bridge = {
    hosts: [{ hostId: 'h1', name: 'MSI', state: 'ready', allowed: true, agentUse: true }, { hostId: 'h2', name: 'desk', state: 'ready', allowed: true, agentUse: true }],
    connected: true,
    onEvent: f => { handlers.event.push(f); return () => {}; }, onState: f => { handlers.state.push(f); return () => {}; },
    onReady: f => { handlers.ready.push(f); return () => {}; }, onHosts: f => { handlers.hosts.push(f); return () => {}; },
    refresh: async () => {}, sync: async (hostId, ids) => { syncs.push([hostId, ids]); return true; },
  };
  const sent = [];
  let outcomes = [];
  const remote = createRemoteDelegation({ bridge, tasks: () => manager, agentT, locale: () => 'ja', log: () => {}, now: () => clock,
    offlineMinutes: 10, offlineRepeatMinutes: 60, syncWaitMs: 60,
    deliverNotice: async (owner, build) => { sent.push({ owner, text: build('ja'), en: build('en') }); return outcomes.shift() ?? 'ok'; } });
  remote.start();
  const setState = (hostId, state) => {
    const h = bridge.hosts.find(x => x.hostId === hostId); h.state = state;
    for (const f of handlers.state) f(hostId, { state, allowed: true });
  };
  const ready = async hostId => {
    const h = bridge.hosts.find(x => x.hostId === hostId); h.state = 'ready';
    for (const f of handlers.ready) f(hostId, { state: 'ready', allowed: true });
    await sleep(20);
  };
  const emit = (hostId, ev) => handlers.event.forEach(f => f(hostId, ev));
  const adopt = (n, parent, hostId, extra = {}) => manager.adopt({ taskId: id(n), parentSessionId: parent, host: { hostId, name: hostId === 'h1' ? 'MSI' : 'desk' }, status: 'running', title: `task ${n}`, ...extra }, 'ja');
  const check = async () => { await remote.checkOffline(); };
  try {
    await adopt(1, 'parent', 'h1'); await adopt(2, 'parent', 'h1'); await adopt(3, 'other', 'h1'); await adopt(4, 'parent', 'h2');
    await adopt(5, 'parent', 'h1', { status: 'completed', result: 'done' });

    // 短い切断では鳴らない
    setState('h2', 'offline'); clock += 3 * MIN; await check();
    await ready('h2'); clock += 20 * MIN; await check();
    t.ok('短い切断（つながり直した）では知らせない', sent.length === 0);

    // h1 が落ちたまま
    setState('h1', 'offline');
    clock += 9 * MIN; await check();
    t.ok('閾値の前は知らせない', sent.length === 0);
    bridge.connected = false; clock += 5 * MIN; await check();
    t.ok('main の口が無い間（更新の間）は、ホストが全部オフラインでも知らせない', sent.length === 0);
    bridge.connected = true;
    outcomes = ['requeue'];
    await check();
    const first = sent.splice(0);
    t.ok('親ごとに 1 通（ホストと親の組。子ごとでなく）', first.length === 2 && first.filter(x => x.owner === 'parent').length === 1 && first.filter(x => x.owner === 'other').length === 1);
    await check();
    t.ok('親が忙しくて受け取れなかった（requeue）分だけ、次の確認でもう一度送る', sent.length === 1 && sent[0].owner === 'parent');
    const mine = sent.splice(0);
    await check();
    t.ok('受け取れた後は、同じオフラインの間に何度も鳴らさない', sent.length === 0);
    const text = mine.at(-1).text;
    t.ok('文面にホスト名・走っていた子の数と題・ID が入る', text.includes('MSI') && text.includes('task 1') && text.includes('task 2') && text.includes(id(1)) && !text.includes('task 3') && !text.includes('task 4') && !text.includes('task 5'), text);
    t.ok('文面に、いつから（時刻）と、PC が止まった可能性・つながり直せば追いつくこと・待つか ply_task_cancel か', /\d{1,2}:\d{2}/.test(text) && text.includes('ply_task_cancel') && text.includes('Pleiad'), text);
    t.ok('英語の文面も同じ要素を持つ', mine.at(-1).en.includes('MSI') && mine.at(-1).en.includes('ply_task_cancel') && mine.at(-1).en !== text);

    // 間隔を空けて 1 回だけ重ねる
    clock += 30 * MIN; await check();
    t.ok('繰り返しの間隔の前は鳴らさない', sent.length === 0);
    clock += 31 * MIN; await check();
    t.ok('長く続けば、間隔を空けて 1 回だけ重ねる', sent.filter(x => x.owner === 'parent').length === 1 && sent.filter(x => x.owner === 'other').length === 1);
    sent.length = 0;
    clock += 600 * MIN; await check();
    t.ok('それ以上は鳴らさない', sent.length === 0);

    // つながり直した: sync の答え（task の便りと synced）が揃うまで待って、1 通にまとめる
    // id(1): まだ走っている / id(2): ホストの PC の再起動で interrupted / id(3): ホストに記録が無い
    await ready('h1');
    await until(() => syncs.some(x => x[0] === 'h1'));
    t.ok('つながり直した直後は、追いつきを待ってまだ知らせない', sent.length === 0);
    const s1 = syncs.find(x => x[0] === 'h1')?.[1] ?? [];
    t.ok('sync は走っている子の ID を送る', [id(1), id(2), id(3)].every(x => s1.includes(x)) && !s1.includes(id(5)));
    emit('h1', { t: 'task', task: { taskId: id(1), title: 'task 1', status: 'running', updatedAt: 1 } });
    emit('h1', { t: 'task', task: { taskId: id(2), title: 'task 2', status: 'interrupted', rawStatus: 'interrupted', error: 'restart', updatedAt: 1, result: '', resultLength: 0 } });
    emit('h1', { t: 'synced', unknown: [id(3)] });
    await until(() => sent.length === 2);
    const back = Object.fromEntries(sent.map(x => [x.owner, x.text]));
    t.ok('追いつきを親ごとに 1 通で知らせる', Object.keys(back).length === 2);
    t.ok('走っている子と終わった子の数・題が入る', back.parent.includes('MSI') && back.parent.includes('task 1') && back.parent.includes('task 2') && back.parent.includes(id(1)), back.parent);
    t.ok('ホストに記録が無い子は、追えなくなったと知らせる', back.other.includes('task 3') && back.other.includes(id(3)), back.other);
    t.ok('ホストの再起動で無くなった子は running のまま残らず interrupted になり、完了通知の対象になる',
      manager.get(id(2)).status === 'interrupted' && manager.get(id(1)).status === 'running' && manager.get(id(3)).status === 'failed');
    manager.checkSilence(); await until(() => delivered.includes(id(2)));
    t.ok('interrupted の子の完了通知が届く', delivered.includes(id(2)));
    sent.length = 0;
    await check();
    t.ok('追いつきの通知は 1 回だけ', sent.length === 0);

    // 新しいオフライン: 前の回の印を持ち越さず、閾値から数え直す。synced が来ない古いホストは待ちの上限で知らせる
    setState('h1', 'offline'); clock += 9 * MIN; await check();
    t.ok('新しいオフラインは閾値から数え直す', sent.length === 0);
    clock += 2 * MIN; await check();
    t.ok('もう一度オフラインのままなら、また知らせる', sent.length === 1 && sent[0].owner === 'parent');
    sent.length = 0;
    await ready('h1');
    await until(() => sent.length === 1);
    t.ok('synced を返さない古いホストでも、待ちの上限の後に追いつきを知らせる', sent[0].owner === 'parent' && sent[0].text.includes('task 1'));
    sent.length = 0;

    // 知らせていないオフラインでは、つながり直しても何も知らせない
    setState('h1', 'offline'); clock += 2 * MIN; await check(); await ready('h1'); await sleep(100);
    t.ok('知らせていないオフラインから戻っても、追いつきの通知は出さない', sent.length === 0);

    // 終わった子だけのホストは鳴らない
    await manager.mirror(id(1), { status: 'completed', result: 'x' });
    setState('h1', 'offline'); clock += 60 * MIN; await check();
    t.ok('走っている子が無ければ知らせない', sent.length === 0);
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
