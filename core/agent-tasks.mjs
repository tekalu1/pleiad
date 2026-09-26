import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t, agentT } from './i18n.mjs';
import { taskTitle } from './task-title.mjs';
import { writeAtomic, RENAME_DELAYS } from './atomic-file.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
// 保存障害の間、スケジューラーが保存をやり直す間隔の上限（ms）。500ms から倍にしていく
const RETRY_MAX = 15000;
// 保存障害の記録（agent-tasks-errors.log）の大きさの上限。超えたら新しい半分だけ残す
const LOG_MAX = 64 * 1024;
// call() のエラーと子への依頼文はエージェントが読むので、会話の言語（locale）で引く（agent 名前空間）
const text = (locale, value, name, max = 60000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(agentT(locale, 'tasks.textLength', { name, max }));
  return value;
};

// Pleiad owns these tasks, independently of each engine's native subagent registry.
// Writes are serialized; only the scheduler starts work. No blind replay after a crash.
// 保存の失敗（docs/agent-delegation.md「保存・画面・再起動」）:
// - 保存に失敗しても manager は閉じない。closed は close()（正常終了）だけが立てる。
// - 先へ進む前に保存が要る書き換え（受け付け・子の実行の開始・通知を送る前の delivering）は、失敗したらメモリを戻して進まない（commit）。
// - 起きたことの記録（結果・送った通知・止めたこと）は取り消せないので、メモリはそのままにして後で書き直す（record）。
// - 障害の間は、スケジューラーは間隔を空けて保存をやり直すだけにする。list / status はメモリの状態を障害中の印付きで返す。
// ready は「親が完了通知を受け取れるか」。受け取れない間は delivering にせず、ファイルも書かない。
// io・log・renameDelays・retryMax はテストで失敗を差し込み、記録を読み、待ちを縮めるためのもの
export async function createAgentTasks({ dataDir, prepare, rollback = async () => {}, execute, deliver, ready = async () => true, changed = () => {}, waiting = () => false,
  io = fs, log = line => console.error(line), renameDelays = RENAME_DELAYS, retryMax = RETRY_MAX }) {
  const file = path.join(dataDir, 'agent-tasks.json');
  const logFile = path.join(dataDir, 'agent-tasks-errors.log');
  let records = {};
  try { records = JSON.parse(await io.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let writes = Promise.resolve(), closed = false, mutating = false, probing = false;
  // fault: 保存障害（最後の失敗の errno・操作・タスク ID・時刻）。dirty: メモリにだけある記録が残っている
  let fault = null, dirty = false;
  // ファイルに書けた通知の状態（taskId → notification）。ファイルがすでに delivering なら送る前に書き直さない
  let persisted = new Map(Object.values(records).map(r => [r.taskId, r.notification]));
  const live = new Map(), notices = new Set(), listeners = new Set();
  const serial = fn => {
    const next = writes.then(async () => { mutating = true; try { return await fn(); } finally { mutating = false; } });
    writes = next.catch(() => {});
    return next;
  };
  const touched = () => { changed(); for (const fn of [...listeners]) fn(); };
  // 障害の記録。秘密・依頼文・結果・パスは書かない（errno・操作・タスク ID・時刻だけ）。
  // stderr はデスクトップ版ではファイルに残らないので、データ置き場にも大きさの上限付きで残す
  const report = entry => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    log(`[agent-tasks] ${line}`);
    void (async () => {
      const size = await io.stat(logFile).then(s => s.size, () => 0);
      if (size > LOG_MAX) { const old = await io.readFile(logFile, 'utf8'); await io.writeFile(logFile, old.slice(-LOG_MAX / 2).replace(/^[^\n]*\n/, '')); }
      await io.appendFile(logFile, line + '\n');
    })().catch(() => {});
  };
  const write = async () => {
    const notes = new Map(Object.values(records).map(r => [r.taskId, r.notification]));
    await io.mkdir(dataDir, { recursive: true });
    await writeAtomic(file, JSON.stringify(records), { io, delays: renameDelays });
    persisted = notes; dirty = false;
    if (fault) { report({ event: 'saveRecovered', failures: fault.failures, since: new Date(fault.since).toISOString() }); fault = null; }
  };
  const failed = (e, operation, taskId = null) => {
    const at = Date.now(), failures = (fault?.failures ?? 0) + 1;
    fault = { code: String(e?.code ?? 'UNKNOWN'), syscall: e?.syscall ?? null, operation, taskId, since: fault?.since ?? at, at, failures,
      retryAt: at + Math.min(retryMax, 500 * 2 ** (failures - 1)) };
    report({ event: 'saveFailed', code: fault.code, errno: e?.errno ?? null, syscall: fault.syscall, operation, taskId, failures });
  };
  // 起きたことを書く。失敗したらメモリはそのままにし、スケジューラーが後で書き直す
  const persist = async (operation, taskId) => { try { await write(); } catch (e) { dirty = true; failed(e, operation, taskId); } };
  // 保存できないので受け付けなかった、という依頼元への返事
  const refused = locale => new Error(agentT(locale, 'tasks.storageFailed', { code: fault?.code ?? 'UNKNOWN' }));
  const storage = locale => fault ? { storageFault: { error: agentT(locale, 'tasks.storageFault', { code: fault.code, since: new Date(fault.since).toISOString() }),
    code: fault.code, since: fault.since, failures: fault.failures } } : {};
  // 再起動: 実行中だったものは再実行しない。まだ親に渡っていない pending はそのまま送り直す。
  // 渡ったか分からない delivering だけを unknown にする（二重に届けない）
  for (const r of Object.values(records)) {
    if (ACTIVE.has(r.status)) { r.status = 'interrupted'; r.error = t('tasks.interruptedByRestart'); r.queue = []; }
    if (r.notification === 'delivering') r.notification = 'unknown';
  }
  await serial(() => persist('restore'));
  const owned = (owner, id, locale) => {
    const r = records[id];
    if (!r || r.parentSessionId !== owner) throw new Error(agentT(locale, 'tasks.notOwned'));
    return r;
  };
  // context は「別の候補でやり直す」で同じ依頼を渡し直すために持つだけ（長いので一覧・状態には載せない）
  const view = (r, offset = 0) => {
    const { result = '', queue, context, ...rest } = r;
    return { ...rest, pendingMessages: queue.length, result: result.slice(offset, offset + 16000), resultOffset: offset,
      resultLength: result.length, nextOffset: offset + 16000 < result.length ? offset + 16000 : null };
  };
  // 依頼元のエージェントへ返す形。人間の承認待ちは「いま待っているか」から導く見せかけの状態で、
  // 保存する status（queued / running …）は変えない。ACTIVE の集合と再起動時の interrupted の扱いを壊さないため
  const shown = (r, offset = 0) => {
    const v = view(r, offset);
    return ACTIVE.has(r.status) && waiting(r.sessionId) ? { ...v, status: 'waiting' } : v;
  };
  const restore = (r, before) => { for (const key of Object.keys(r)) delete r[key]; Object.assign(r, before); };
  // 保存できてから先へ進む書き換え。保存に失敗したらメモリを戻し、理由付きのエラーを投げる
  async function commit(id, fn, operation, locale) {
    return serial(async () => {
      const r = records[id], before = structuredClone(r);
      try { fn(r); r.updatedAt = Date.now(); } catch (e) { restore(r, before); throw e; }
      try { await write(); } catch (e) { restore(r, before); failed(e, operation, id); throw refused(locale); }
      touched();
    });
  }
  // 起きたことの記録。保存に失敗しても投げない（メモリが正しく、ファイルは後で追いつく）
  async function record(id, fn, operation) {
    return serial(async () => {
      const r = records[id];
      fn(r); r.updatedAt = Date.now();
      await persist(operation, id);
      touched();
    });
  }
  async function run(r, controller) {
    // stalled: 実行の開始を保存できなかった。子は動かしていないので queued のまま、次のタイマーでやり直す
    let stalled = false;
    try {
      while (!controller.signal.aborted) {
        let prompt;
        try { await commit(r.taskId, row => { prompt = row.queue.shift(); row.status = 'running'; }, 'run.start'); }
        catch { stalled = true; break; }
        const result = await execute(structuredClone(r), prompt, controller.signal);
        if (result?.requeue) {
          await record(r.taskId, row => { row.queue.unshift(prompt); row.status = 'queued'; }, 'run.requeue');
          return;
        }
        await record(r.taskId, row => {
          row.result = String(result?.text ?? ''); row.error = result?.error ?? null;
          row.status = controller.signal.aborted ? 'cancelled' : result?.outcome === 'ok' ? (row.queue.length ? 'queued' : 'completed') : 'failed';
          if (['failed', 'cancelled'].includes(row.status)) row.queue = [];
        }, 'run.result');
        if (r.status !== 'queued') break;
      }
    } catch (e) {
      await record(r.taskId, row => { row.status = controller.signal.aborted ? 'cancelled' : 'failed'; row.error = String(e.message ?? e); row.queue = []; }, 'run.error');
    } finally {
      if (r.status === 'cancelling' || controller.signal.aborted) await record(r.taskId, row => { row.status = 'cancelled'; row.queue = []; }, 'run.cancelled');
      live.delete(r.taskId);
      if (!stalled || controller.signal.aborted) {
        if (r.queue.length && !controller.signal.aborted) await record(r.taskId, row => { row.status = 'queued'; row.notification = 'none'; }, 'run.queued');
        else if (!ACTIVE.has(r.status)) await record(r.taskId, row => { row.notification = row.status === 'cancelled' ? 'suppressed' : 'pending'; }, 'run.notice');
        // Busy sessions retry on the timer, never in a recursive write loop.
        if (r.status !== 'queued') kick();
      }
    }
  }
  // 通知を送る前に delivering を保存する（送ったか分からないまま落ちたら、再起動で unknown にして再送しない）。
  // ファイルがすでに delivering（直前の requeue をメモリだけで pending に戻した）なら書き直さない。保存できなければ送らない
  async function begin(r) {
    return serial(async () => {
      if (r.notification !== 'pending' || ACTIVE.has(r.status)) return false;
      r.notification = 'delivering';
      if (persisted.get(r.taskId) === 'delivering') return true;
      const updatedAt = r.updatedAt; r.updatedAt = Date.now();
      try { await write(); } catch (e) { r.notification = 'pending'; r.updatedAt = updatedAt; failed(e, 'notify.delivering', r.taskId); return false; }
      touched(); return true;
    });
  }
  async function notify(r) {
    notices.add(r.taskId);
    const revision = r.revision ?? 0;
    try {
      // 親が受け取れない間は delivering にせず、何も書かない（pending のまま次のタイマーで見る）
      if (!(await ready(structuredClone(r)).catch(() => false))) return;
      if (!(await begin(r))) return;
      // delivery callback only returns 'requeue' when no prompt was accepted.
      const outcome = await deliver(structuredClone(r)).catch(() => 'error');
      if (outcome === 'requeue') {
        // 受け取られていない。親が空くまで何度も来るので、ファイルは delivering のまま書かず、メモリだけ pending に戻す
        await serial(async () => { if ((r.revision ?? 0) === revision && r.notification === 'delivering') r.notification = 'pending'; });
        return;
      }
      await record(r.taskId, row => { if ((row.revision ?? 0) === revision) row.notification = outcome === 'ok' ? 'sent' : 'unknown'; }, 'notify.done');
    } finally { notices.delete(r.taskId); }
  }
  // 保存障害の間は、間隔を空けて保存だけをやり直す（1 回に 1 秒ほど待つ保存を、500ms ごとに仕事の数だけ重ねない）。
  // 書けたら障害を解き、次のタイマーから実行の開始と通知を再開する
  function probe() {
    if (probing || Date.now() < fault.retryAt) return;
    probing = true;
    void serial(async () => { try { await write(); touched(); } catch (e) { failed(e, dirty ? 'flush' : 'retry'); } })
      .finally(() => { probing = false; });
  }
  function kick() {
    if (closed || mutating) return;
    if (fault) { probe(); return; }
    for (const r of Object.values(records)) {
      if (r.status === 'queued' && !live.has(r.taskId)) {
        const ac = new AbortController(); live.set(r.taskId, ac);
        void run(r, ac).catch(e => { live.delete(r.taskId); report({ event: 'unexpected', operation: 'run', taskId: r.taskId, code: e?.code ?? null }); });
      }
      if (r.notification === 'pending' && !notices.has(r.taskId) && !ACTIVE.has(r.status)) {
        void notify(r).catch(e => report({ event: 'unexpected', operation: 'notify', taskId: r.taskId, code: e?.code ?? null }));
      }
    }
  }
  const timer = setInterval(kick, 500); timer.unref();
  return {
    get busy() { return live.size > 0 || notices.size > 0 || Object.values(records).some(r => ACTIVE.has(r.status) || r.notification === 'pending'); },
    list(owner) { return Object.values(records).filter(r => !owner || r.parentSessionId === owner).map(r => view(r)); },
    get(taskId) { return records[taskId] ? view(records[taskId]) : null; },
    /** 最初の依頼（task と context）。やり直しで同じ依頼を渡す。context を持つ前に作ったタスクは task だけ */
    request(taskId) { const r = records[taskId]; return r ? { task: r.task, title: r.title ?? null, context: r.context ?? null } : null; },
    // locale は呼び出した会話（owner）の言語。子の会話も同じ言語を継ぐので、子への依頼文もこれで作る
    async call(owner, name, args = {}, signal, locale) {
      if (closed || signal?.aborted) throw new Error(agentT(locale, 'tasks.halted'));
      if (name === 'ply_delegate') {
        text(locale, args.backend, 'backend', 40); text(locale, args.task, 'task');
        if (args.context !== undefined) text(locale, args.context, 'context');
        if (args.title !== undefined && typeof args.title !== 'string') throw new Error(agentT(locale, 'tasks.textLength', { name: 'title', max: 40 }));
        args = { ...args, title: taskTitle(args.title, args.task) };
        const row = await serial(async () => {
          // 保存できない間は新しい仕事を受けない。子の会話を作る前に、書けるかを確かめる
          if (fault) { try { await write(); touched(); } catch (e) { failed(e, 'delegate'); throw refused(locale); } }
          // 同時の件数・1 会話の件数・深さに上限は置かない（2026-09-27 に廃止。depth は記録だけ残す）
          const parent = Object.values(records).find(r => r.sessionId === owner);
          const depth = (parent?.depth ?? 0) + 1;
          const taskId = `ply-task-${crypto.randomUUID()}`;
          const prepared = await prepare(owner, args, taskId, signal);
          try {
          if (signal?.aborted) throw new Error(agentT(locale, 'tasks.aborted'));
          const row = { ...prepared, taskId, parentSessionId: owner, manager: 'ply', depth, task: args.task, title: args.title, ...(args.context !== undefined ? { context: args.context } : {}),
            createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
            result: '', error: null, queue: [args.context ? agentT(locale, 'tasks.withContext', { task: args.task, context: args.context }) : args.task] };
          records[taskId] = row;
          try { await write(); } catch (e) { failed(e, 'delegate', taskId); throw refused(locale); }
          touched(); return view(row);
          } catch (e) { delete records[taskId]; await rollback(prepared); throw e; }
        });
        kick(); return row;
      }
      // 読み取りは保存障害の間も答える。状態はメモリのもので、障害中なら storageFault を添える
      if (name === 'ply_task_list') return { tasks: Object.values(records).filter(r => r.parentSessionId === owner).map(r => { const { result, ...rest } = shown(r); return rest; }), ...storage(locale) };
      const r = owned(owner, text(locale, args.taskId, 'taskId', 100), locale);
      if (name === 'ply_task_status') {
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) throw new Error(agentT(locale, 'tasks.offsetInvalid'));
        return { ...shown(r, offset), ...storage(locale) };
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
        return { ...shown(r), ...storage(locale) };
      }
      if (name === 'ply_task_send') {
        text(locale, args.message, 'message');
        // 追加の指示も新しい仕事なので、保存できなければ受けない（commit が理由付きで断る）
        await commit(r.taskId, row => {
          if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
          row.revision = (row.revision ?? 0) + 1;
          row.queue.push(args.message); row.notification = 'none'; row.error = null;
          if (!live.has(row.taskId) || !ACTIVE.has(row.status)) row.status = 'queued';
        }, 'send', locale);
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
      // 止めることは保存できなくても止める（record。ファイルは後で追いつく）
      await record(taskId, row => { row.revision = (row.revision ?? 0) + 1; row.queue = []; row.notification = 'suppressed'; if (ACTIVE.has(row.status)) row.status = live.has(taskId) ? 'cancelling' : 'cancelled'; }, 'cancel');
      live.get(taskId)?.abort();
    },
    // 承認待ちの増減で ply_task_wait を起こす。保存する状態は変わらないので write() は通らない
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
      // cancel と同じく、保存できなくても止める
      await serial(async () => {
        for (const r of change) {
          r.revision = (r.revision ?? 0) + 1; r.queue = []; r.notification = 'suppressed';
          if (ACTIVE.has(r.status)) r.status = live.has(r.taskId) ? 'cancelling' : 'cancelled';
          r.updatedAt = Date.now();
        }
        await persist('cancelOwner');
        touched();
      });
      for (const r of change) live.get(r.taskId)?.abort();
    },
    /** 保存障害（無ければ null）。errno・操作・タスク ID・時刻だけ */
    get fault() { return fault && { code: fault.code, syscall: fault.syscall, operation: fault.operation, taskId: fault.taskId, since: fault.since, at: fault.at, failures: fault.failures }; },
    // 正常終了。保存障害では閉じない
    close() { closed = true; clearInterval(timer); for (const ac of live.values()) ac.abort(); },
  };
}
