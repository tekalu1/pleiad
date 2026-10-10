// ホストに任せたタスクの写し（agent-tasks の host の行。docs/agent-delegation.md「リモートのホストへ任せる」、ADR 0146）の台帳の規則。
//   - adopt: ホストの便りの taskId は形を確かめ、手元のタスクと同じ ID・__proto__ は受けない。最初から終わっている行は完了通知を送らない（戻りで知らせ済み）
//   - mirror: ホストの状態をそのまま写し、終わったら完了通知の対象にする。止める予定（cancelPending）の間は、ホストの running で止めた状態を戻さない
//   - 止める: 応答しないホストは短い待ちで切り上げて「止める予定」に残し、会話の中断は並列に止める（ホストごとに直列で待たない）
//   - 追えなくなった（hostLost）行にホストの便りが戻れば、ホストの状態に戻して完了通知もやり直す
//   - descendants: 任された子の子孫（孫・ひ孫）の行を辿れる
//   - 端末側の取り込み（remote-delegation。橋は身代わり）: オフライン中の止めるを、つながり直して送る・ホストが許可を切れば理由付きで終え、戻れば sync で復帰・
//     ホストが知らない ID は sync の答えで終える・任せる設定を切る／ホストを消すと写しを理由付きで終える・質問と「ホストの画面で答える」承認の中継
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createRemoteDelegation } from '../../core/remote-delegation.mjs';
import { hookedTaskStorage } from '../lib/task-storage.mjs';

export const name = 'agent-tasks-remote';
export const title = 'ホストに任せたタスクの写し: adopt の検査・mirror の規則・止める予定・並列の中断・追えなくなった行の復帰・子孫';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ID = n => `ply-task-${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-task-remote-'));
  const hooked = hookedTaskStorage(dir, {});
  const cancelCalls = [], delivered = [];
  let cancelBehavior = () => Promise.resolve(true);
  let seq = 0;
  const manager = await createAgentTasks({
    taskStorage: hooked.taskStorage, dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async () => ({ outcome: 'ok', text: 'x' }),
    ready: async () => true,
    deliver: async tasks => { delivered.push(...tasks.map(x => x.taskId)); return 'ok'; },
    cancelHost: async row => { cancelCalls.push(row.taskId); return cancelBehavior(row); },
  });
  const adopt = (n, extra = {}) => manager.adopt({ taskId: ID(n), parentSessionId: 'parent', host: { hostId: 'h1', name: 'desk' }, title: `t${n}`, task: 'do', status: 'running', ...extra }, 'ja');
  try {
    // ---- adopt の検査
    const rejects = async p => p.then(() => null, e => e);
    t.ok('adopt: ply-task- の形でない taskId（__proto__・短い・手元の形でない）は受けない',
      (await Promise.all(['__proto__', 'constructor', 'x', 'ply-task-zzz', ID(1) + 'x'].map(id => rejects(manager.adopt({ taskId: id, parentSessionId: 'p', host: { hostId: 'h1', name: 'd' }, status: 'running' }, 'ja'))))).every(Boolean));
    await adopt(1);
    t.ok('adopt: 同じ taskId は 2 度入れない（既にある行を返さず断る）', Boolean(await rejects(adopt(1))));
    const local = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'local', title: 'local' });
    t.ok('adopt: 手元のタスクと同じ ID は受けない', Boolean(await rejects(manager.adopt({ taskId: local.taskId, parentSessionId: 'parent', host: { hostId: 'h1', name: 'd' }, status: 'running' }, 'ja'))));
    await adopt(2, { status: 'completed', result: 'done' });
    t.ok('adopt: 最初から終わっている行は完了通知を送らない（read）', manager.get(ID(2)).notification === 'read');

    // ---- mirror: 終わったら完了通知の対象に
    await adopt(3);
    await manager.mirror(ID(3), { status: 'completed', result: 'R' });
    await sleep(700);
    t.ok('mirror: 終わった状態を写し、完了通知を届ける（sent）', manager.get(ID(3)).status === 'completed' && manager.get(ID(3)).notification === 'sent' && delivered.includes(ID(3)));
    t.ok('mirror: ホストの行は動いている数に入らない（busy は通知が済めば false）', manager.busy === false);

    // ---- 止める予定
    await adopt(4);
    cancelBehavior = () => Promise.resolve(false);
    await manager.cancel(ID(4));
    t.ok('cancel: ホストへ届かなければ cancelled にして、止める予定（cancelPending）を残す', manager.get(ID(4)).status === 'cancelled' && manager.get(ID(4)).cancelPending === true);
    await manager.mirror(ID(4), { status: 'running', hostWaiting: true });
    t.ok('mirror: 止める予定の間は、ホストの running の便りで止めた状態を戻さない', manager.get(ID(4)).status === 'cancelled' && manager.get(ID(4)).notification === 'suppressed' && manager.get(ID(4)).cancelPending === true);
    await manager.mirror(ID(4), { cancelPending: null });
    t.ok('mirror: 予定を外すと（ホストへ届いた）外れる', manager.get(ID(4)).cancelPending === undefined);
    await adopt(5);
    cancelBehavior = () => Promise.resolve(false);
    await manager.cancel(ID(5));
    await manager.mirror(ID(5), { status: 'cancelled' });
    t.ok('mirror: ホストが cancelled を返せば、止める予定は外れる', manager.get(ID(5)).cancelPending === undefined && manager.get(ID(5)).status === 'cancelled');

    // ---- 応答しないホスト: 短い待ちで切り上げ、会話の中断は並列
    for (const n of [10, 11, 12, 13]) await adopt(n, { parentSessionId: 'parent2' });
    cancelBehavior = () => new Promise(() => {});   // 返事が来ない
    const t0 = Date.now();
    const stopped = await manager.cancelOwner('parent2');
    const took = Date.now() - t0;
    t.ok('cancelOwner: 応答しないホスト 4 件でも、待ちは直列の 4 倍にならず、短い上限（約 3 秒）で終わる', took < 6000 && stopped.length === 4, `${took}ms`);
    t.ok('cancelOwner: 届かなかった分は止める予定として残る', [10, 11, 12, 13].every(n => manager.get(ID(n)).cancelPending === true && manager.get(ID(n)).status === 'cancelled'));

    // ---- 追えなくなった行の復帰
    await adopt(20);
    await manager.mirror(ID(20), { status: 'failed', hostLost: true, error: 'lost' });
    await sleep(700);
    t.ok('追えなくなった行は失敗として終わる（通知は 1 回）', manager.get(ID(20)).status === 'failed' && manager.get(ID(20)).hostLost === true);
    await manager.mirror(ID(20), { status: 'completed', result: 'REAL' });
    await sleep(700);
    const back = manager.get(ID(20));
    t.ok('ホストの便りが戻れば、ホストの状態に戻り、完了通知もやり直す', back.status === 'completed' && back.result === 'REAL' && back.hostLost === undefined && back.notification === 'sent');

    // ---- 子孫
    cancelBehavior = () => Promise.resolve(true);
    const child = await manager.call('root', 'ply_delegate', { backend: 'fake', task: 'child', title: 'c' });
    const grand = await manager.call(child.sessionId, 'ply_delegate', { backend: 'fake', task: 'grand', title: 'g' });
    const great = await manager.call(grand.sessionId, 'ply_delegate', { backend: 'fake', task: 'great', title: 'gg' });
    const ids = manager.descendants([child.sessionId]).map(r => r.taskId).sort();
    t.ok('descendants: 会話が作った行の子孫（孫・ひ孫）まで辿れる。自分の行は含めない', ids.join() === [grand.taskId, great.taskId].sort().join());
    t.ok('descendants: 会話が無ければ空', manager.descendants([]).length === 0 && manager.descendants(['nope']).length === 0);

    // ---- 端末側の取り込み（橋は身代わり）
    {
      const handlers = { event: [], state: [], ready: [], hosts: [] };
      const requests = [], answers = [], syncs = [], opened = [], closed = [];
      let online = true, nowHosts;
      const bridge = {
        get hosts() { return nowHosts; },
        onEvent: f => { handlers.event.push(f); return () => {}; },
        onState: f => { handlers.state.push(f); return () => {}; },
        onReady: f => { handlers.ready.push(f); return () => {}; },
        onHosts: f => { handlers.hosts.push(f); return () => {}; },
        refresh: async () => {},
        request: async (hostId, op, args) => { requests.push([op, args.taskId]); if (!online) throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); return { ok: true }; },
        answer: async (hostId, msg) => { answers.push(msg); return { ok: true }; },
        sync: async (hostId, ids) => { syncs.push(ids); },
      };
      const host = (over = {}) => ({ hostId: 'h2', name: 'desk2', agentUse: true, allowed: true, state: 'ready', ...over });
      nowHosts = [host()];
      let cardSeq = 0;
      const cards = { open: c => { const id = `card-${++cardSeq}`; opened.push({ id, ...c }); return id; }, close: (id, res) => closed.push([id, res]), online: () => {} };
      let rd;
      const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-task-remote2-'));
      const hooked2 = hookedTaskStorage(dir2, {});
      const m2 = await createAgentTasks({
        taskStorage: hooked2.taskStorage, dataDir: dir2, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
        prepare: async () => ({ sessionId: 'x', backend: 'fake' }), execute: async () => ({ outcome: 'ok', text: 'x' }), ready: async () => true, deliver: async () => 'ok',
        cancelHost: row => rd.cancelHost(row),
      });
      rd = createRemoteDelegation({ bridge, tasks: () => m2, agentT: (_l, key) => key, cards, locale: () => 'ja' });
      rd.start();
      const emit = (ev) => handlers.event.forEach(f => f('h2', ev));
      const setState = status => { nowHosts = [host({ state: status.state, allowed: status.allowed })]; handlers.state.forEach(f => f('h2', status)); };
      const ready = status => { nowHosts = [host({ state: 'ready', allowed: status.allowed })]; handlers.ready.forEach(f => f('h2', status)); };
      const add2 = (n, extra = {}) => m2.adopt({ taskId: ID(n), parentSessionId: 'conv', host: { hostId: 'h2', name: 'desk2' }, title: `r${n}`, task: 'do', status: 'running', ...extra }, 'ja');
      try {
        // オフライン中の止める → つながり直したら送って、予定を外す
        await add2(1);
        online = false; nowHosts = [host({ state: 'offline' })];
        await m2.cancel(ID(1));
        t.ok('取り込み: オフライン中の止めるは「止める予定」として残る（cancelled・cancelPending）', m2.get(ID(1)).status === 'cancelled' && m2.get(ID(1)).cancelPending === true);
        emit({ t: 'task', task: { taskId: ID(1), status: 'running', updatedAt: 1 } });
        await sleep(50);
        t.ok('取り込み: オフラインの間の running の便りで、止めた状態を戻さない', m2.get(ID(1)).status === 'cancelled');
        online = true; requests.length = 0;
        ready({ state: 'ready', allowed: true });
        await sleep(100);
        t.ok('取り込み: つながり直したら止める依頼を送り、成功したら止める予定を外す', requests.some(r => r[0] === 'cancel' && r[1] === ID(1)) && m2.get(ID(1)).cancelPending === undefined);
        // ホストが許可を切る → 理由付きで終え、戻れば sync で復帰
        await add2(2);
        setState({ state: 'ready', allowed: false });
        await sleep(100);
        t.ok('取り込み: ホストが許可を切ると、動いていた写しは失敗（追えなくなった印 hostLost）として終わる', m2.get(ID(2)).status === 'failed' && m2.get(ID(2)).hostLost === true);
        syncs.length = 0;
        ready({ state: 'ready', allowed: true });
        await sleep(100);
        t.ok('取り込み: つながり直すと、失敗にした行も sync に含める', syncs.flat().includes(ID(2)));
        emit({ t: 'task', task: { taskId: ID(2), status: 'completed', result: 'BACK', resultLength: 4, updatedAt: 2 } });
        await sleep(100);
        t.ok('取り込み: ホストの便りで、失敗にした行がホストの状態（completed）に戻る', m2.get(ID(2)).status === 'completed' && m2.get(ID(2)).result === 'BACK' && m2.get(ID(2)).hostLost === undefined);
        await add2(27);
        emit({ t: 'task', task: { taskId: ID(27), rawStatus: 'running', status: 'running', telemetry: { version: 1,
          lastActivityAt: 123, lastOutputAt: null, lockWaiting: true, background: null,
          activeCommands: [{ noticeId: 'command-7', command: 'build', state: 'running', observedAt: 123, pausedMs: 0, notified: true }] } } });
        await sleep(50);
        t.ok('取り込み: 新しいホストの活動と実行中コマンドの写しを受ける',
          m2.get(ID(27)).hostTelemetry === true && m2.get(ID(27)).lastActivityAt >= 123 && m2.get(ID(27)).hostLockWaiting === true
          && m2.get(ID(27)).activeCommands[0].command === 'build');
        setState({ state: 'offline', allowed: true });
        await sleep(50);
        t.ok('取り込み: オフラインでは古い活動の写しによる通知を止める', m2.get(ID(27)).hostTelemetry === undefined);
        ready({ state: 'ready', allowed: true });
        emit({ t: 'task', task: { taskId: ID(27), rawStatus: 'running', status: 'running', telemetry: {
          version: 1, lastActivityAt: 124, activeCommands: [], lockWaiting: false, background: null } } });
        await sleep(50);
        emit({ t: 'task', task: { taskId: ID(27), rawStatus: 'running', status: 'running' } });
        await sleep(50);
        t.ok('取り込み: 古いホストの便りへ戻ったら活動の写しを使わない', m2.get(ID(27)).hostTelemetry === undefined && m2.get(ID(27)).activeCommands.length === 0);
        // ホストが知らない
        await add2(3);
        emit({ t: 'synced', unknown: [ID(3), 'nope', ID(2)] });
        await sleep(100);
        t.ok('取り込み: sync の答えで「ホストが知らない」行は、記録が無いものとして失敗で終わる（終わった行・知らない ID は触らない）', m2.get(ID(3)).status === 'failed' && /hostNoRecord/.test(m2.get(ID(3)).error) && m2.get(ID(2)).status === 'completed');
        // 質問と hostOnly の中継
        await add2(4); await add2(5);
        emit({ t: 'relay', relay: { id: 'rq', taskId: ID(4), requesterSessionId: 'conv', receipt: 'rc', kind: 'question', questions: [{ question: 'Q?', options: [] }], toolName: 'AskUserQuestion', input: {} } });
        emit({ t: 'relay', relay: { id: 'rh', taskId: ID(5), requesterSessionId: 'conv', receipt: 'rc2', kind: 'hostOnly', toolName: 'set_setting', input: {} } });
        const cq = opened.find(c => c.relayId === 'rq'), ch = opened.find(c => c.relayId === 'rh');
        t.ok('取り込み: 質問（kind: question）は質問の中身つきのカードになり、hostOnly は答えられない知らせのカードになる', cq?.kind === 'question' && cq.questions?.[0]?.question === 'Q?' && ch?.kind === 'hostOnly' && ch.hostOnly === true);
        const aq = await rd.answerCard(cq.id, { allow: true, answers: { 'Q?': 'A' } });
        t.ok('取り込み: 質問への答え（選んだ項目）は受領証つきでホストへ送る', aq.ok === true && answers.at(-1)?.id === 'rq' && answers.at(-1).receipt === 'rc' && answers.at(-1).answers?.['Q?'] === 'A');
        const ah = await rd.answerCard(ch.id, { allow: true });
        t.ok('取り込み: 「ホストの画面で答える」知らせへは答えを送らない（HOST_ONLY）', ah.ok === false && ah.code === 'HOST_ONLY' && !answers.some(a => a.id === 'rh'));
        emit({ t: 'relay', relay: { id: 'rcw', taskId: ID(4), requesterSessionId: 'conv', receipt: 'rc3', kind: 'tool', toolName: 'ply_browser', input: {}, chromeWait: { reason: 'connect' } } });
        emit({ t: 'relay', relay: { id: 'rtool', taskId: ID(4), requesterSessionId: 'conv', receipt: 'rc4', kind: 'tool', toolName: 'Bash', input: {} } });
        const ccw = opened.find(c => c.relayId === 'rcw'), ctool = opened.find(c => c.relayId === 'rtool');
        t.ok('取り込み: Chrome の操作待ちの印（chromeWait）はカードへ引き継ぎ、ふつうの承認には付かない', ccw?.chromeWait?.reason === 'connect' && ctool && ctool.chromeWait === undefined, JSON.stringify([ccw?.chromeWait, ctool?.chromeWait]));
        t.ok('取り込み: 承認待ちの行を AI に見せるとき、ホストの画面で答える旨（hostOnlyApproval）が付く', Boolean(rd.presentList({ tasks: [m2.get(ID(5))] }).tasks[0].hostOnlyApproval));
        // 任せる設定を切る・ホストを消す
        await add2(6);
        nowHosts = [host({ agentUse: false })];
        handlers.hosts.forEach(f => f([{ hostId: 'h2', agentUse: false }]));
        await sleep(100);
        t.ok('取り込み: この PC 側で任せる設定を切ると、動いていた写しは理由付きで終わる（hostUnlinked）', m2.get(ID(6)).status === 'failed' && /hostUnlinked/.test(m2.get(ID(6)).error) && m2.get(ID(6)).hostLost === true);
        await add2(7);
        nowHosts = [];
        handlers.hosts.forEach(f => f([]));
        await sleep(100);
        t.ok('取り込み: ホストを消しても、動いていた写しは理由付きで終わる', m2.get(ID(7)).status === 'failed' && /hostUnlinked/.test(m2.get(ID(7)).error));
      } finally {
        await m2.close();
        await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    await manager.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
