import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t, agentT } from './i18n.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
// call() のエラーと子への依頼文はエージェントが読むので、会話の言語（locale）で引く（agent 名前空間）
const text = (locale, value, name, max = 60000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(agentT(locale, 'tasks.textLength', { name, max }));
  return value;
};

// Pleiad owns these tasks, independently of each engine's native subagent registry.
// Writes are serialized; only the scheduler starts work. No blind replay after a crash.
export async function createAgentTasks({ dataDir, prepare, rollback = async () => {}, execute, deliver, changed = () => {}, waiting = () => false, maxActive = 8 }) {
  const file = path.join(dataDir, 'agent-tasks.json');
  let records = {};
  try { records = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let writes = Promise.resolve(), closed = false, mutating = false;
  const live = new Map(), notices = new Set(), listeners = new Set();
  const serial = fn => {
    const next = writes.then(async () => { mutating = true; try { return await fn(); } finally { mutating = false; } });
    writes = next.catch(() => {});
    return next;
  };
  const save = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(records));
    await fs.rename(file + '.tmp', file);
    changed();
    for (const fn of [...listeners]) fn();
  };
  for (const r of Object.values(records)) {
    if (ACTIVE.has(r.status)) { r.status = 'interrupted'; r.error = t('tasks.interruptedByRestart'); r.queue = []; }
    if (['pending', 'delivering'].includes(r.notification)) r.notification = 'unknown';
  }
  await serial(save);
  const owned = (owner, id, locale) => {
    const r = records[id];
    if (!r || r.parentSessionId !== owner) throw new Error(agentT(locale, 'tasks.notOwned'));
    return r;
  };
  const view = (r, offset = 0) => {
    const { result = '', queue, ...rest } = r;
    return { ...rest, pendingMessages: queue.length, result: result.slice(offset, offset + 16000), resultOffset: offset,
      resultLength: result.length, nextOffset: offset + 16000 < result.length ? offset + 16000 : null };
  };
  // 依頼元のエージェントへ返す形。人間の承認待ちは「いま待っているか」から導く見せかけの状態で、
  // 保存する status（queued / running …）は変えない。ACTIVE の集合と再起動時の interrupted の扱いを壊さないため
  const shown = (r, offset = 0) => {
    const v = view(r, offset);
    return ACTIVE.has(r.status) && waiting(r.sessionId) ? { ...v, status: 'waiting' } : v;
  };
  async function update(id, fn) {
    return serial(async () => {
      const r = records[id], before = structuredClone(r);
      try { fn(r); r.updatedAt = Date.now(); await save(); }
      catch (e) { for (const key of Object.keys(r)) delete r[key]; Object.assign(r, before); throw e; }
    });
  }
  async function run(r, controller) {
    try {
      while (!controller.signal.aborted) {
        let prompt;
        await update(r.taskId, row => { prompt = row.queue.shift(); row.status = 'running'; });
        const result = await execute(structuredClone(r), prompt, controller.signal);
        if (result?.requeue) {
          await update(r.taskId, row => { row.queue.unshift(prompt); row.status = 'queued'; });
          return;
        }
        await update(r.taskId, row => {
          row.result = String(result?.text ?? ''); row.error = result?.error ?? null;
          row.status = controller.signal.aborted ? 'cancelled' : result?.outcome === 'ok' ? (row.queue.length ? 'queued' : 'completed') : 'failed';
          if (['failed', 'cancelled'].includes(row.status)) row.queue = [];
        });
        if (r.status !== 'queued') break;
      }
    } catch (e) {
      await update(r.taskId, row => { row.status = controller.signal.aborted ? 'cancelled' : 'failed'; row.error = String(e.message ?? e); row.queue = []; });
    } finally {
      if (r.status === 'cancelling' || controller.signal.aborted) await update(r.taskId, row => { row.status = 'cancelled'; row.queue = []; });
      live.delete(r.taskId);
      if (r.queue.length && !controller.signal.aborted) await update(r.taskId, row => { row.status = 'queued'; row.notification = 'none'; });
      else if (!ACTIVE.has(r.status)) await update(r.taskId, row => { row.notification = row.status === 'cancelled' ? 'suppressed' : 'pending'; });
      // Busy sessions retry on the timer, never in a recursive write loop.
      if (r.status !== 'queued') kick();
    }
  }
  async function notify(r) {
    notices.add(r.taskId);
    const revision = r.revision ?? 0;
    try {
      // delivery callback only returns 'requeue' when no prompt was accepted.
      await update(r.taskId, row => { row.notification = 'delivering'; });
      const outcome = await deliver(structuredClone(r));
      await update(r.taskId, row => { if ((row.revision ?? 0) === revision) row.notification = outcome === 'requeue' ? 'pending' : outcome === 'ok' ? 'sent' : 'unknown'; });
    } catch { await update(r.taskId, row => { if ((row.revision ?? 0) === revision) row.notification = 'unknown'; }); }
    finally { notices.delete(r.taskId); }
  }
  function kick() {
    if (closed || mutating) return;
    for (const r of Object.values(records)) {
      if (r.status === 'queued' && !live.has(r.taskId)) {
        const ac = new AbortController(); live.set(r.taskId, ac);
        void run(r, ac).catch(() => { closed = true; clearInterval(timer); for (const controller of live.values()) controller.abort(); console.error('Pleiad タスクの保存に失敗したため委譲を停止しました'); });
      }
      if (r.notification === 'pending' && !notices.has(r.taskId) && !ACTIVE.has(r.status)) void notify(r).catch(() => { closed = true; clearInterval(timer); console.error('Pleiad タスクの通知状態を保存できませんでした'); });
    }
  }
  const timer = setInterval(kick, 500); timer.unref();
  return {
    get busy() { return live.size > 0 || notices.size > 0 || Object.values(records).some(r => ACTIVE.has(r.status) || r.notification === 'pending'); },
    list(owner) { return Object.values(records).filter(r => !owner || r.parentSessionId === owner).map(r => view(r)); },
    get(taskId) { return records[taskId] ? view(records[taskId]) : null; },
    // locale は呼び出した会話（owner）の言語。子の会話も同じ言語を継ぐので、子への依頼文もこれで作る
    async call(owner, name, args = {}, signal, locale) {
      if (closed || signal?.aborted) throw new Error(agentT(locale, 'tasks.halted'));
      if (name === 'ply_delegate') {
        text(locale, args.backend, 'backend', 40); text(locale, args.task, 'task');
        if (args.context !== undefined) text(locale, args.context, 'context');
        const row = await serial(async () => {
          if (Object.values(records).filter(r => ACTIVE.has(r.status)).length >= maxActive) throw new Error(agentT(locale, 'tasks.maxActive', { max: maxActive }));
          if (Object.values(records).filter(r => r.parentSessionId === owner).length >= 100) throw new Error(agentT(locale, 'tasks.maxPerConversation', { max: 100 }));
          const parent = Object.values(records).find(r => r.sessionId === owner);
          const depth = (parent?.depth ?? 0) + 1;
          if (depth > 4) throw new Error(agentT(locale, 'tasks.maxDepth', { max: 4 }));
          const taskId = `ply-task-${crypto.randomUUID()}`;
          const prepared = await prepare(owner, args, taskId, signal);
          try {
          if (signal?.aborted) throw new Error(agentT(locale, 'tasks.aborted'));
          const row = { ...prepared, taskId, parentSessionId: owner, manager: 'ply', depth, task: args.task,
            createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
            result: '', error: null, queue: [args.context ? agentT(locale, 'tasks.withContext', { task: args.task, context: args.context }) : args.task] };
          records[taskId] = row; await save(); return view(row);
          } catch (e) { delete records[taskId]; await rollback(prepared); throw e; }
        });
        kick(); return row;
      }
      if (name === 'ply_task_list') return { tasks: Object.values(records).filter(r => r.parentSessionId === owner).map(r => { const { result, ...rest } = shown(r); return rest; }) };
      const r = owned(owner, text(locale, args.taskId, 'taskId', 100), locale);
      if (name === 'ply_task_status') {
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) throw new Error(agentT(locale, 'tasks.offsetInvalid'));
        return shown(r, offset);
      }
      if (name === 'ply_task_wait') {
        const seconds = args.seconds ?? 30;
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error(agentT(locale, 'tasks.secondsInvalid'));
        // 人間の承認待ちになったら待たずに戻る。待つ相手が人間に変わったことを依頼元へ早く伝える
        const pending = () => ACTIVE.has(r.status) && !waiting(r.sessionId);
        if (pending()) await new Promise(resolve => {
          const done = () => { clearTimeout(timeout); listeners.delete(check); signal?.removeEventListener('abort', done); resolve(); };
          const check = () => { if (!pending()) done(); };
          const timeout = setTimeout(done, seconds * 1000); listeners.add(check); signal?.addEventListener('abort', done, { once: true });
          if (signal?.aborted) done();
        });
        return shown(r);
      }
      if (name === 'ply_task_send') {
        text(locale, args.message, 'message');
        await update(r.taskId, row => {
          if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
          if (row.queue.length >= 20) throw new Error(agentT(locale, 'tasks.maxQueued'));
          if (!ACTIVE.has(row.status) && Object.values(records).filter(r => ACTIVE.has(r.status)).length >= maxActive) throw new Error(agentT(locale, 'tasks.limitReached'));
          row.revision = (row.revision ?? 0) + 1;
          row.queue.push(args.message); row.notification = 'none'; row.error = null;
          if (!live.has(row.taskId) || !ACTIVE.has(row.status)) row.status = 'queued';
        });
        kick(); return view(r);
      }
      if (name === 'ply_task_cancel') {
        await this.cancel(r.taskId); return view(r);
      }
      throw new Error(agentT(locale, 'tasks.unknownTool'));
    },
    async cancel(taskId) {
      const r = records[taskId]; if (!r) return;
      // Stop descendant Pleiad tasks too; engine-native children follow their engine's cancellation.
      for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) await this.cancel(child.taskId);
      await update(taskId, row => { row.revision = (row.revision ?? 0) + 1; row.queue = []; row.notification = 'suppressed'; if (ACTIVE.has(row.status)) row.status = live.has(taskId) ? 'cancelling' : 'cancelled'; });
      live.get(taskId)?.abort();
    },
    // 承認待ちの増減で ply_task_wait を起こす。保存する状態は変わらないので save() は通らない
    wake() { for (const fn of [...listeners]) fn(); },
    // 会話を止めたときに、その会話が作ったタスク（と子孫）をまとめて止める。cancel と同じ書き換えを、
    // 書き換えて何かが変わるものにだけ行い、保存は 1 回にする。以前は終わったタスクまで 1 件ずつ保存していて
    // （1 会話で数十件になる）、会話の停止を遅らせていた。止め終わって通知も抑えたもの（cancel を呼んでも
    // revision と updatedAt しか変わらない）は飛ばす。子孫は親を飛ばしても辿る
    async cancelOwner(owner) {
      const targets = [], seen = new Set();
      const visit = r => {
        if (seen.has(r.taskId)) return;
        seen.add(r.taskId);
        for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) visit(child);
        targets.push(r);
      };
      for (const r of Object.values(records).filter(r => !owner || r.parentSessionId === owner)) visit(r);
      const settled = r => !ACTIVE.has(r.status) && !r.queue.length && r.notification === 'suppressed' && !live.has(r.taskId);
      const change = targets.filter(r => !settled(r));
      if (!change.length) return;
      await serial(async () => {
        const before = change.map(r => [r, structuredClone(r)]);
        try {
          for (const r of change) {
            r.revision = (r.revision ?? 0) + 1; r.queue = []; r.notification = 'suppressed';
            if (ACTIVE.has(r.status)) r.status = live.has(r.taskId) ? 'cancelling' : 'cancelled';
            r.updatedAt = Date.now();
          }
          await save();
        } catch (e) {
          for (const [r, old] of before) { for (const key of Object.keys(r)) delete r[key]; Object.assign(r, old); }
          throw e;
        }
      });
      for (const r of change) live.get(r.taskId)?.abort();
    },
    close() { closed = true; clearInterval(timer); for (const ac of live.values()) ac.abort(); },
  };
}
