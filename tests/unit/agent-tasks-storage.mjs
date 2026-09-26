import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { writeAtomic } from '../../core/atomic-file.mjs';

export const name = 'agent-tasks-storage';
export const title = 'Pleiad 委譲の保存障害: rename のやり直し・閉じない・障害中の読み取り・再起動後の pending の送り直し';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(20); } throw new Error('timeout'); }
const read = async dir => JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'));

// rename に失敗を差し込む。transient: 次の n 回だけ EPERM。broken: 直すまで毎回 EPERM（Get-Content が開いたままの状態）
function faultyIo() {
  const state = { transient: 0, broken: false, renames: 0, failures: 0 };
  const io = { ...fs, rename: async (from, to) => {
    state.renames++;
    if (state.broken || state.transient > 0) {
      if (state.transient > 0) state.transient--;
      state.failures++;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM', errno: -4048, syscall: 'rename' });
    }
    return fs.rename(from, to);
  } };
  return { io, state };
}

export default async function(t) {
  const dirs = [];
  const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-tasks-storage-')); dirs.push(d); return d; };
  const managers = [];
  try {
    // ---- 共通の土台（atomic-file）
    {
      const dir = await tmp(), file = path.join(dir, 'x.json');
      const { io, state } = faultyIo();
      state.transient = 3;
      await writeAtomic(file, '{"a":1}', { io });
      const left = (await fs.readdir(dir)).filter(n => n.endsWith('.tmp'));
      t.ok('一時的な EPERM は待ってやり直し、書けたら一時ファイルを残さない', (await fs.readFile(file, 'utf8')) === '{"a":1}' && state.failures === 3 && !left.length);
      state.broken = true;
      const err = await writeAtomic(file, '{"a":2}', { io, delays: [1, 1] }).then(() => null, e => e);
      t.ok('やり直しの上限を超えたら元の例外を投げ、一時ファイルを残さない', err?.code === 'EPERM' && state.failures === 6 && !(await fs.readdir(dir)).some(n => n.endsWith('.tmp')));
      const other = Object.assign(new Error('nospace'), { code: 'ENOSPC' });
      const once = { ...fs, rename: async () => { throw other; } };
      let tries = 0; once.rename = async () => { tries++; throw other; };
      await writeAtomic(file, '{}', { io: once }).catch(() => {});
      t.ok('EPERM / EBUSY / EACCES 以外はやり直さない', tries === 1);
    }

    // ---- 一時的な EPERM の後に保存が回復し、実行・配送の回数が増えない
    {
      const dir = await tmp();
      const { io, state } = faultyIo();
      let runs = 0; const delivered = [];
      const m = await createAgentTasks({ dataDir: dir, io, log: () => {},
        prepare: async () => ({ sessionId: `c-${Math.random()}`, backend: 'codex' }),
        execute: async (_r, prompt) => { runs++; state.transient = 2; return { outcome: 'ok', text: prompt }; },
        deliver: async r => { delivered.push(r.taskId); return 'ok'; } });
      managers.push(m);
      state.transient = 2;
      const job = await m.call('p', 'ply_delegate', { backend: 'codex', task: 'hello' });
      await until(() => m.get(job.taskId).notification === 'sent');
      await sleep(600);
      const saved = await read(dir);
      t.ok('一時的な rename の EPERM の後に保存が回復する（manager は閉じず、障害も残らない）',
        m.fault === null && state.failures === 4 && saved[job.taskId].status === 'completed' && saved[job.taskId].notification === 'sent');
      t.ok('やり直しで子の実行回数・通知の配送回数が増えない', runs === 1 && delivered.length === 1);
    }

    // ---- 続く保存障害: 閉じない・読み取りは答える・新しい仕事は断る・止めることはできる・直ったら続きを配る
    {
      const dir = await tmp();
      const { io, state } = faultyIo();
      const logs = [];
      let runs = 0, prepared = 0, releaseA; const delivered = [];
      const m = await createAgentTasks({ dataDir: dir, io, log: line => logs.push(line), renameDelays: [1, 1], retryMax: 200,
        prepare: async (owner, a) => ({ sessionId: `child-${++prepared}`, backend: a.backend }),
        execute: async (_r, prompt, signal) => {
          runs++;
          if (prompt === 'SECRET-PROMPT-A') await new Promise(resolve => { releaseA = resolve; });
          if (prompt === 'hold-b') await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return { outcome: signal.aborted ? 'aborted' : 'ok', text: `RESULT-BODY-${prompt}` };
        },
        deliver: async r => { delivered.push(r.taskId); return 'ok'; } });
      managers.push(m);
      const a = await m.call('parent-a', 'ply_delegate', { backend: 'codex', task: 'SECRET-PROMPT-A' });
      const b = await m.call('parent-b', 'ply_delegate', { backend: 'codex', task: 'hold-b' });
      // 実行の開始の保存が済み、両方の子が実際に動き出してから壊す
      await until(() => releaseA && runs === 2);
      state.broken = true;
      releaseA();
      await until(() => m.get(a.taskId).status === 'completed' && m.get(a.taskId).notification === 'pending' && m.fault);
      const fault = m.fault;
      t.ok('保存に失敗しても manager を閉じない（障害として持つ）', fault?.code === 'EPERM' && fault.syscall === 'rename' && typeof fault.since === 'number');
      const listB = await m.call('parent-b', 'ply_task_list', {}, undefined, 'ja');
      const statusB = await m.call('parent-b', 'ply_task_status', { taskId: b.taskId }, undefined, 'en');
      t.ok('障害中も別の親の list・status が返り、障害中である旨を添える',
        listB.tasks.length === 1 && listB.tasks[0].taskId === b.taskId && listB.storageFault?.code === 'EPERM' && /EPERM/.test(listB.storageFault.error)
        && statusB.status === 'running' && /cannot be saved/.test(statusB.storageFault?.error ?? ''), `${listB.tasks.length} / ${statusB.status} / ${listB.storageFault?.code}`);
      const statusA = await m.call('parent-a', 'ply_task_status', { taskId: a.taskId });
      t.ok('障害中も自分の子の結果はメモリから読める', statusA.status === 'completed' && statusA.result === 'RESULT-BODY-SECRET-PROMPT-A');
      const denied = await m.call('stranger', 'ply_task_status', { taskId: a.taskId }).then(() => null, e => e.message);
      t.ok('障害中も所有権の制限は変わらない', typeof denied === 'string' && !/EPERM/.test(denied));
      const before = prepared;
      const refused = await m.call('parent-b', 'ply_delegate', { backend: 'codex', task: 'new work' }, undefined, 'ja').then(() => null, e => e.message);
      t.ok('保存できない間は新しい委譲を理由付きで断り、子の会話も作らない', /保存できない/.test(refused ?? '') && /EPERM/.test(refused) && prepared === before && m.list().length === 2);
      const sendRefused = await m.call('parent-a', 'ply_task_send', { taskId: a.taskId, message: 'more' }).then(() => null, e => e.message);
      t.ok('保存できない間は追加の指示も断り、積まない', typeof sendRefused === 'string' && m.get(a.taskId).pendingMessages === 0 && m.get(a.taskId).status === 'completed');
      await m.cancel(b.taskId);
      await until(() => m.get(b.taskId).status === 'cancelled');
      t.ok('障害中でも明示の中断は子に届く', m.get(b.taskId).notification === 'suppressed');
      await sleep(700);
      t.ok('障害の間は完了通知を配らない', delivered.length === 0);
      const joined = logs.join('\n');
      t.ok('元の例外（errno・操作・タスク ID・時刻）を記録に残す',
        /"code":"EPERM"/.test(joined) && /"errno":-4048/.test(joined) && /"syscall":"rename"/.test(joined) && /"operation":"run\.result"/.test(joined) && joined.includes(a.taskId) && /"at":"\d{4}-/.test(joined));
      t.ok('記録に依頼文・結果・パスを入れない', !/SECRET-PROMPT|RESULT-BODY/.test(joined) && !joined.includes(dir) && !joined.includes('agent-tasks.json'));
      const errorsLog = await fs.readFile(path.join(dir, 'agent-tasks-errors.log'), 'utf8').catch(() => '');
      t.ok('記録はデータ置き場の agent-tasks-errors.log にも残る', /"event":"saveFailed"/.test(errorsLog) && !/SECRET-PROMPT|RESULT-BODY/.test(errorsLog));
      state.broken = false;
      await until(() => m.fault === null && m.get(a.taskId).notification === 'sent');
      await sleep(600);
      const saved = await read(dir);
      t.ok('直ったら次のタイマーで書き直し、止まっていた完了通知を 1 回だけ配る',
        delivered.length === 1 && delivered[0] === a.taskId && saved[a.taskId].status === 'completed' && saved[a.taskId].notification === 'sent' && saved[b.taskId].status === 'cancelled');
      t.ok('障害の間に子を実行し直さない', runs === 2, `runs=${runs}`);
      t.ok('回復も記録する', logs.some(l => /"event":"saveRecovered"/.test(l)));
      const again = await m.call('parent-b', 'ply_delegate', { backend: 'codex', task: 'after recovery' });
      await until(() => m.get(again.taskId).notification === 'sent');
      t.ok('回復後は新しい委譲を受け付ける', delivered.length === 2);
    }

    // ---- 親が忙しい間の保存: ready が偽なら書かない。deliver の requeue はメモリだけで pending に戻す
    {
      const dir = await tmp();
      const { io, state } = faultyIo();
      let open = false, busyDeliver = true; const delivered = [];
      const m = await createAgentTasks({ dataDir: dir, io, log: () => {},
        prepare: async (_o, a) => ({ sessionId: `busy-${Math.random()}`, backend: a.backend }),
        execute: async (_r, prompt) => ({ outcome: 'ok', text: prompt }),
        ready: async () => open,
        deliver: async r => { if (busyDeliver) return 'requeue'; delivered.push(r.taskId); return 'ok'; } });
      managers.push(m);
      const job = await m.call('p', 'ply_delegate', { backend: 'codex', task: 'x' });
      await until(() => m.get(job.taskId).notification === 'pending');
      await sleep(100);
      const w0 = state.renames;
      await sleep(1200);
      t.ok('親が受け取れない間は通知の状態を書かない（ファイルも pending のまま）', state.renames === w0 && (await read(dir))[job.taskId].notification === 'pending');
      open = true;
      await until(() => state.renames > w0);
      await sleep(100);
      const w1 = state.renames;
      await sleep(1200);
      t.ok('deliver が requeue を返すだけの間は delivering→pending をファイルに書かない',
        state.renames === w1 && w1 === w0 + 1 && m.get(job.taskId).notification !== 'sent' && (await read(dir))[job.taskId].notification === 'delivering');
      busyDeliver = false;
      await until(() => m.get(job.taskId).notification === 'sent');
      await sleep(600);
      t.ok('受け取れたら 1 回だけ配って sent を保存する', delivered.length === 1 && (await read(dir))[job.taskId].notification === 'sent');
    }

    // ---- 再起動: pending は送り直す。delivering は unknown。sent は送らない
    {
      const dir = await tmp();
      const row = (id, notification) => ({ taskId: id, sessionId: `s-${id}`, parentSessionId: 'p', manager: 'ply', backend: 'codex', depth: 1, task: 't', title: 't',
        createdAt: 1, updatedAt: 1, status: 'completed', notification, result: `r-${id}`, error: null, queue: [] });
      await fs.writeFile(path.join(dir, 'agent-tasks.json'), JSON.stringify({ pend: row('pend', 'pending'), dlv: row('dlv', 'delivering'), sent: row('sent', 'sent'),
        run: { ...row('run', 'none'), status: 'running', queue: ['next'] } }));
      let runs = 0; const delivered = [];
      const m = await createAgentTasks({ dataDir: dir, log: () => {},
        prepare: async () => { throw new Error('unused'); },
        execute: async () => { runs++; return { outcome: 'ok', text: '' }; },
        deliver: async r => { delivered.push(r.taskId); return 'ok'; } });
      managers.push(m);
      t.ok('再起動で配送途中（delivering）だけを unknown にし、pending は残す', m.get('dlv').notification === 'unknown' && ['pending', 'delivering', 'sent'].includes(m.get('pend').notification));
      await until(() => m.get('pend').notification === 'sent');
      await sleep(1100);
      const saved = await read(dir);
      t.ok('再起動後、まだ親に渡っていない pending を送り直す', delivered.includes('pend') && saved.pend.notification === 'sent');
      t.ok('渡ったか分からない delivering と送信済みは送らない（二重に配らない）', delivered.length === 1 && saved.dlv.notification === 'unknown' && saved.sent.notification === 'sent');
      t.ok('再起動で実行中だったものは再実行しない', runs === 0 && m.get('run').status === 'interrupted');
    }
  } finally {
    for (const m of managers) m.close();
    await sleep(50);
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  }
}
