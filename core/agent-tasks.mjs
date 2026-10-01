import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t, agentT } from './i18n.mjs';
import { observeCommand, pauseCommands, commandElapsed, commandView } from './task-commands.mjs';
import { taskTitle } from './task-title.mjs';
import { writeAtomic, RENAME_DELAYS } from './atomic-file.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
// 保存障害の間、スケジューラーが保存をやり直す間隔の上限（ms）。500ms から倍にしていく
const RETRY_MAX = 15000;
// 保存障害の記録（agent-tasks-errors.log）の大きさの上限。超えたら新しい半分だけ残す
const LOG_MAX = 64 * 1024;
// 1 タスクに持つ実行前の拒否（rejections）の上限。超えた分は捨て、rejectionsDropped に数だけ残す
const MAX_REJECTIONS = 50;
// これらの通知の状態なら、今の rejections は依頼元へ渡した（か、止めた）。ply_task_send で始まる次の回は新しく数え直す
// read: 依頼元が ply_task_status / ply_task_wait で完了と結果を受け取った（完了通知は送らない。ADR 0057）
const NOTICED = new Set(['delivering', 'sent', 'unknown', 'suppressed', 'read']);
// 依頼元が結果を受け取ったら通知の対象から外す状態（終わって、まだ通知を送っていない）
const readable = r => ['completed', 'failed'].includes(r.status) && ['none', 'pending'].includes(r.notification);
// call() のエラーと子への依頼文はエージェントが読むので、会話の言語（locale）で引く（agent 名前空間）
const text = (locale, value, name, max = 60000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(agentT(locale, 'tasks.textLength', { name, max }));
  return value;
};

/**
 * 子の会話の記録（getMessages）から、委譲の結果にする返答を選ぶ（docs/agent-delegation.md「子の結果」）。
 * この回（最後の user の発言より後）の assistant の本文のうち、最後のもの。ただし、バックエンドが
 * stopHookFollowUp を付けた発言（Stop フックに止められて書いた、中身の仕事をしていない続き。Claude の
 * claude-normalize.mjs の stopHookFollowUps）は飛ばす。飛ばすと何も残らないときは、今までどおり最後の本文
 */
export function finalReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const reply = (m) => m?.role === 'assistant' && typeof m.text === 'string' && m.text;
  const run = list.slice(list.findLastIndex((m) => m?.role === 'user') + 1);
  return (run.findLast((m) => reply(m) && !m.stopHookFollowUp) ?? list.findLast(reply))?.text ?? '';
}

// Pleiad owns these tasks, independently of each engine's native subagent registry.
// Writes are serialized; only the scheduler starts work. No blind replay after a crash.
// 保存の失敗（docs/agent-delegation.md「保存・画面・再起動」）:
// - 保存に失敗しても manager は閉じない。closed は close()（正常終了）だけが立てる。
// - 先へ進む前に保存が要る書き換え（受け付け・子の実行の開始・通知を送る前の delivering）は、失敗したらメモリを戻して進まない（commit）。
// - 起きたことの記録（結果・送った通知・止めたこと）は取り消せないので、メモリはそのままにして後で書き直す（record）。
// - 障害の間は、スケジューラーは間隔を空けて保存をやり直すだけにする。list / status はメモリの状態を障害中の印付きで返す。
// ready は「親が完了通知を受け取れるか」。受け取れない間は delivering にせず、ファイルも書かない。
// io・log・renameDelays・retryMax はテストで失敗を差し込み、記録を読み、待ちを縮めるためのもの
// ready は「親が新しいターンで完了通知を受け取れるか」、steerable は「走っている親のターンへ今すぐ渡せるか」（ADR 0057）。
// deliver は同じ親へ届ける完了通知（1 件以上）をまとめて受け取る。無音・コマンドの通知は ready だけで決める
// childSteerable は「走っている子のターンへ追加指示を今すぐ渡せるか」、steer(task, { id, text }) はその途中送信。
// 'delivered'（受理。合図の無いバックエンドは渡ったものとして扱う）/ 'pending'（受理。渡った合図を steered() で待つ）/
// 'requeue'（受理されない。待機のまま次のターンで）/ 'error'（結果不明。送り直さない）を返す（ADR 0065）
export async function createAgentTasks({ dataDir, prepare, rollback = async () => {}, execute, deliver, deliverSilence = async () => 'ok', deliverCommand = async () => 'ok', cancelBackground = async () => {}, ready = async () => true, steerable = async () => false, childSteerable = async () => false, steer = async () => 'requeue', changed = () => {}, waiting = () => false,
  // コンピューターの操作のロックを待っているか（docs/computer-use.md「ロック・待ち・止めた印」）。承認待ちではないので status: waiting にはせず、沈黙の通知にだけ数えない
  lockWaiting = () => false,
  now = Date.now, silenceMinutes = Number(process.env.AGENT_HOST_TASK_SILENCE_MINUTES ?? 5),
  commandMinutes = Number(process.env.AGENT_HOST_TASK_COMMAND_MINUTES ?? 5),
  io = fs, log = line => console.error(line), renameDelays = RENAME_DELAYS, retryMax = RETRY_MAX }) {
  const silenceMs = Number.isFinite(silenceMinutes) && silenceMinutes > 0 ? silenceMinutes * 60000 : 0;
  const commandMs = Number.isFinite(commandMinutes) && commandMinutes > 0 ? commandMinutes * 60000 : 0;
  const commandNotices = new Set();
  const file = path.join(dataDir, 'agent-tasks.json');
  const logFile = path.join(dataDir, 'agent-tasks-errors.log');
  let records = {};
  try { records = JSON.parse(await io.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bySession = new Map(Object.values(records).map(r => [r.sessionId, r]));
  // Older files kept only prompt strings in queue. Preserve their order and make
  // pending follow-ups visible without replaying the initial delegation request.
  for (const r of Object.values(records)) {
    r.instructions ??= [];
    const initial = !r.revision && !r.result && r.status === 'queued' && r.createdAt === r.updatedAt;
    r.queue = (r.queue ?? []).map((entry, index) => {
      if (typeof entry !== 'string' || (initial && index === 0)) return entry;
      const instruction = { id: crypto.randomUUID(), text: entry, at: r.updatedAt ?? r.createdAt ?? Date.now(), state: 'queued' };
      r.instructions.push(instruction);
      return { instructionId: instruction.id };
    });
  }
  const setInstruction = (r, id, state) => {
    if (!id) return;
    const instruction = r.instructions?.find(x => x.id === id);
    if (instruction && instruction.state !== state) { instruction.state = state; r.instructionRevision = (r.instructionRevision ?? 0) + 1; }
  };
  const dropInstructions = r => {
    for (const instruction of r.instructions ?? []) if (instruction.state === 'queued') setInstruction(r, instruction.id, 'dropped');
    r.queue = [];
  };
  let writes = Promise.resolve(), closed = false, mutating = false, probing = false;
  // fault: 保存障害（最後の失敗の errno・操作・タスク ID・時刻）。dirty: メモリにだけある記録が残っている
  let fault = null, dirty = false;
  // ファイルに書けた通知の状態（taskId → notification）。ファイルがすでに delivering なら送る前に書き直さない
  let persisted = new Map(Object.values(records).map(r => [r.taskId, r.notification]));
  // noticeOwners: 完了通知を送っている最中の親（同じ親への配送は 1 つずつ。次に溜まった分は次の kick でまとめて送る）
  // waited: 依頼元が ply_task_wait で待っているタスク（taskId → 待ちの数）。待ちの間は完了通知を送らない（ADR 0057）
  // steers: 走っている子のターンへ途中送信で渡している追加指示（taskId → 指示 ID の集合）。メモリだけ（再起動では sending が delivered に戻る）
  const steers = new Map();
  const live = new Map(), notices = new Set(), noticeOwners = new Set(), waited = new Map(), silenceNotices = new Set(), silenceWaiting = new Map(), listeners = new Set();
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
  // restored: 再起動で止まった（interrupted にした）タスク。server が依頼元の会話の「止めたもの」に残す（docs/design.md「中断と再開」）
  const restored = [];
  for (const r of Object.values(records)) {
    if (ACTIVE.has(r.status)) {
      restored.push({ taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status });
      r.status = 'interrupted'; r.error = t('tasks.interruptedByRestart');
      for (const instruction of r.instructions ?? []) if (instruction.state === 'sending') setInstruction(r, instruction.id, 'delivered');
      dropInstructions(r);
    }
    for (const c of r.activeCommands ?? []) { c.state = 'unknown'; c.pausedAt = null; }
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
    const { result = '', queue, context, instructions, rejections = [], silenceNotifiedAt, activeCommands = [], ...rest } = r;
    pauseCommands(r, now(), waiting(r.sessionId));
    return { ...rest, activeCommands: activeCommands.map(c => commandView(c, now())), silenceMinutes: r.status === 'running' && !waiting(r.sessionId) && !lockWaiting(r.sessionId) && r.lastActivityAt != null
      ? Math.max(0, Math.floor((now() - r.lastActivityAt) / 60000)) : null,
      rejections, pendingMessages: instructions.filter(x => x.state === 'queued').length, result: result.slice(offset, offset + 16000), resultOffset: offset,
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
  // 依頼元が ply_task_status / ply_task_wait で終了状態と結果を受け取った。同じ結果の完了通知は後から送らない（ADR 0057）。
  // 送っている最中（delivering）と送り終えたものは触らない。結果が長くて nextOffset が残っていても、受け取った時点で配達済みとする。
  // 終わった直後で通知がまだ始まっていない（none）ものも対象で、その後の run.notice が read を pending に戻さない
  async function markRead(r) {
    if (!readable(r)) return;
    await record(r.taskId, row => { if (readable(row)) row.notification = 'read'; }, 'notify.read');
  }
  // 途中送信の指示を待機へ戻す（受理されない・捨てられた・合図が来ないままターンが終わった）。
  // 次のターンで 1 回だけ送る。ID で claim を持っているものだけ戻すので、合図が先に来て配送済みにしたものは戻さない
  function unclaim(taskId, instructionId) {
    return serial(async () => {
      const row = records[taskId];
      if (!row || !steers.get(taskId)?.delete(instructionId)) return;
      if (!steers.get(taskId).size) steers.delete(taskId);
      if (['cancelled', 'interrupted'].includes(row.status)) setInstruction(row, instructionId, 'dropped');   // 止めたタスクを指示で生き返らせない
      else {
        row.queue.unshift({ instructionId }); setInstruction(row, instructionId, 'queued');
        // 走っていた回がもう終わっていたら、待機の指示のために再開する（send と同じ）
        if (!ACTIVE.has(row.status)) { row.status = 'queued'; row.notification = 'none'; }
      }
      row.updatedAt = Date.now();
      await persist('send.steer.requeue', taskId); touched();
    });
  }
  // 途中送信の指示を配送済み（か、渡らなかったもの dropped）にして片付ける
  function resolveClaim(taskId, instructionId, state) {
    return serial(async () => {
      const row = records[taskId];
      if (!row || !steers.get(taskId)?.delete(instructionId)) return;
      if (!steers.get(taskId).size) steers.delete(taskId);
      setInstruction(row, instructionId, state); row.updatedAt = Date.now();
      await persist('send.steer.done', taskId); touched();
    });
  }
  // ply_task_send で積んだ指示を、走っている子のターンへ途中送信で渡してみる。渡せなければ何も変えない（待機のまま）。
  // 渡すのは、後ろに待機の指示が無く（順序を守る）、前の途中送信が決着している（二重にしない）ときだけ
  async function steerInstruction(r, instructionId) {
    if (r.status !== 'running' || !live.has(r.taskId) || steers.get(r.taskId)?.size || r.queue.length !== 1) return;
    if (!(await childSteerable(structuredClone(r)).catch(() => false))) return;
    const claimed = await serial(async () => {
      const row = records[r.taskId];
      if (!row || row.status !== 'running' || !live.has(row.taskId) || steers.get(row.taskId)?.size
        || row.queue.length !== 1 || row.queue[0]?.instructionId !== instructionId) return false;
      row.queue.shift(); setInstruction(row, instructionId, 'sending'); row.updatedAt = Date.now();
      steers.set(row.taskId, new Set([instructionId]));
      await persist('send.steer', row.taskId); touched();
      return true;
    });
    if (!claimed) return;
    const text = r.instructions.find(x => x.id === instructionId)?.text ?? '';
    const outcome = await steer(structuredClone(r), { id: instructionId, text }).catch(() => 'error');
    if (outcome === 'delivered') await resolveClaim(r.taskId, instructionId, 'delivered');
    else if (outcome === 'error') await resolveClaim(r.taskId, instructionId, 'dropped');
    else if (outcome !== 'pending') await unclaim(r.taskId, instructionId);
    return outcome;
  }
  async function run(r, controller) {
    // stalled: 実行の開始を保存できなかった。子は動かしていないので queued のまま、次のタイマーでやり直す
    let stalled = false, requeued = false, activeInstructionId;
    // close()（正常終了）の abort。止めたことは書かず、走っていた状態のままファイルに残す（再起動で interrupted になる。
    // docs/agent-delegation.md「保存・画面・再起動」）。利用者の取り消しは先に cancelling にするので、それは cancelled を書く
    const halted = () => closed && r.status !== 'cancelling';
    try {
      while (!controller.signal.aborted) {
        let prompt, instructionId;
        try { await commit(r.taskId, row => {
          const entry = row.queue.shift();
          instructionId = entry?.instructionId;
          prompt = instructionId ? row.instructions.find(x => x.id === instructionId)?.text : entry;
          setInstruction(row, instructionId, 'sending');
          row.status = 'running'; row.lastActivityAt = now(); row.silenceNotifiedAt = null;
        }, 'run.start'); }
        catch { stalled = true; break; }
        activeInstructionId = instructionId;
        const result = await execute(structuredClone(r), prompt, controller.signal);
        if (halted()) return;
        if (result?.requeue) {
          await record(r.taskId, row => { row.queue.unshift(instructionId ? { instructionId } : prompt); setInstruction(row, instructionId, 'queued'); row.status = 'queued'; }, 'run.requeue');
          activeInstructionId = undefined; requeued = true;
          return;
        }
        await record(r.taskId, row => {
          row.result = String(result?.text ?? ''); row.error = result?.error ?? null;
          setInstruction(row, instructionId, 'delivered');
          // 実行前に拒否されたコマンド。前の完了通知の後に走った回の分を足していく（通知の前に続けて走った回の分も落とさない）
          const got = Array.isArray(result?.rejections) ? result.rejections : [];
          if (got.length) {
            const all = [...(row.rejections ?? []), ...got];
            row.rejections = all.slice(0, MAX_REJECTIONS);
            if (all.length > MAX_REJECTIONS) row.rejectionsDropped = (row.rejectionsDropped ?? 0) + all.length - MAX_REJECTIONS;
          }
          // 子が返答を終えた後も終わらず、Pleiad が止めた裏の作業（この回の分。docs/agent-delegation.md「子に残った裏の作業」）
          const stopped = Array.isArray(result?.stoppedBackground) ? result.stoppedBackground.slice(0, MAX_REJECTIONS) : [];
          if (stopped.length) row.stoppedBackground = stopped; else delete row.stoppedBackground;
          row.status = controller.signal.aborted ? 'cancelled' : result?.outcome === 'ok' ? (row.queue.length ? 'queued' : 'completed') : 'failed';
          if (['failed', 'cancelled'].includes(row.status)) dropInstructions(row);
        }, 'run.result');
        activeInstructionId = undefined;
        if (r.status !== 'queued') break;
      }
    } catch (e) {
      if (!halted()) await record(r.taskId, row => { row.status = controller.signal.aborted ? 'cancelled' : 'failed'; row.error = String(e.message ?? e); setInstruction(row, activeInstructionId, 'dropped'); dropInstructions(row); }, 'run.error');
    } finally {
      if (halted()) { live.delete(r.taskId); return; }
      // 止まった後（run.result / run.error で cancelled）に ply_task_send で積まれた指示は、止めた回の分ではない。
      // cancelled に戻して捨てず、下の kick で次の実行にする（docs/agent-delegation.md「ツール」の ply_task_send）
      if (r.status === 'cancelling' || controller.signal.aborted) await record(r.taskId, row => { if (!requeued && row.status === 'queued' && row.queue.length) return; row.status = 'cancelled'; dropInstructions(row); }, 'run.cancelled');
      live.delete(r.taskId);
      if (!stalled || controller.signal.aborted) {
        if (r.queue.length && !controller.signal.aborted) await record(r.taskId, row => { row.status = 'queued'; row.notification = 'none'; }, 'run.queued');
        // 依頼元が結果を先に受け取っていたら（read）通知を送らない。通知は次の指示で走る回のためにまた始まる
        else if (!ACTIVE.has(r.status)) await record(r.taskId, row => { row.notification = row.status === 'cancelled' ? 'suppressed' : row.notification === 'read' ? 'read' : 'pending'; }, 'run.notice');
        // Busy sessions retry on the timer, never in a recursive write loop. 止めた後に積まれた指示はすぐ走らせる
        if (r.status !== 'queued' || controller.signal.aborted) kick();
      }
    }
  }
  // 通知を送る前に delivering を保存する（送ったか分からないまま落ちたら、再起動で unknown にして再送しない）。
  // ファイルがすでに delivering（直前の requeue をメモリだけで pending に戻した）なら書き直さない。保存できなければ送らない。
  // 同じ親への通知は 1 回の保存にまとめる。まだ pending のものだけ返す（依頼元が受け取り済みの read は外れる）
  async function begin(rows) {
    return serial(async () => {
      const list = rows.filter(r => r.notification === 'pending' && !waited.has(r.taskId) && !ACTIVE.has(r.status));
      if (!list.length) return [];
      const before = list.map(r => r.updatedAt);
      for (const r of list) r.notification = 'delivering';
      if (list.every(r => persisted.get(r.taskId) === 'delivering')) return list;
      for (const r of list) r.updatedAt = Date.now();
      try { await write(); } catch (e) {
        list.forEach((r, i) => { r.notification = 'pending'; r.updatedAt = before[i]; });
        failed(e, 'notify.delivering', list[0].taskId); return [];
      }
      touched(); return list;
    });
  }
  async function notify(owner, rows) {
    noticeOwners.add(owner);
    for (const r of rows) notices.add(r.taskId);
    try {
      // 親が受け取れない間（新しいターンも、走っているターンへの途中送信も）は delivering にせず、何も書かない（pending のまま次のタイマーで見る）
      const head = structuredClone(rows[0]);
      if (!(await ready(head).catch(() => false)) && !(await steerable(head).catch(() => false))) return;
      const sending = await begin(rows);
      if (!sending.length) return;
      const revisions = new Map(sending.map(r => [r.taskId, r.revision ?? 0]));
      // delivery callback only returns 'requeue' when no prompt was accepted.
      const outcome = await deliver(sending.map(r => structuredClone(r))).catch(() => 'error');
      if (outcome === 'requeue') {
        // 受け取られていない。親が空くまで何度も来るので、ファイルは delivering のまま書かず、メモリだけ pending に戻す
        await serial(async () => { for (const r of sending) if ((r.revision ?? 0) === revisions.get(r.taskId) && r.notification === 'delivering') r.notification = 'pending'; });
        return;
      }
      await serial(async () => {
        for (const r of sending) if ((r.revision ?? 0) === revisions.get(r.taskId)) { r.notification = outcome === 'ok' ? 'sent' : 'unknown'; r.updatedAt = Date.now(); }
        await persist('notify.done', sending[0].taskId);
        touched();
      });
    } finally { for (const r of rows) notices.delete(r.taskId); noticeOwners.delete(owner); }
  }
  async function notifySilence(r) {
    silenceNotices.add(r.taskId);
    const activityAt = r.lastActivityAt;
    try {
      if (!(await ready(structuredClone(r)).catch(() => false))) return;
      if (r.status !== 'running' || waiting(r.sessionId) || lockWaiting(r.sessionId) || r.lastActivityAt !== activityAt || r.silenceNotifiedAt === activityAt) return;
      // Mark before delivery, as with completion notices: an uncertain delivery must not be repeated.
      try { await commit(r.taskId, row => { row.silenceNotifiedAt = activityAt; }, 'silence.notice'); }
      catch { return; }
      if (r.status !== 'running' || waiting(r.sessionId) || lockWaiting(r.sessionId) || r.lastActivityAt !== activityAt) return;
      const outcome = await deliverSilence(structuredClone(r), Math.max(1, Math.floor((now() - activityAt) / 60000))).catch(() => 'error');
      if (outcome === 'requeue' && r.lastActivityAt === activityAt) await record(r.taskId, row => { row.silenceNotifiedAt = null; }, 'silence.requeue');
    } finally { silenceNotices.delete(r.taskId); }
  }
  async function notifyCommand(r, command) {
    const id = command.noticeId;
    commandNotices.add(id);
    const current = () => r.activeCommands?.find(c => c.noticeId === id);
    const eligible = () => {
      const c = current();
      return c && c.state !== 'unknown' && !waiting(r.sessionId) && commandElapsed(c, now()) >= commandMs;
    };
    try {
      if (!(await ready(structuredClone(r)).catch(() => false)) || !eligible() || current().notified) return;
      const marked = await serial(async () => {
        if (!eligible() || current().notified) return false;
        current().notified = true;
        try { await write(); return true; }
        catch (e) {
          if (current()) current().notified = false;
          failed(e, 'command.notice', r.taskId);
          return false;
        }
      });
      if (!marked) return;
      if (!eligible()) {
        if (current()) await record(r.taskId, () => { if (current()) current().notified = false; }, 'command.defer');
        return;
      }
      const c = current();
      const outcome = await deliverCommand(structuredClone(r), { ...commandView(c, now()), noticeId: id }).catch(() => 'error');
      if (outcome === 'requeue' && current()) await record(r.taskId, () => { if (current()) current().notified = false; }, 'command.requeue');
    } finally { commandNotices.delete(id); }
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
    const groups = new Map();
    for (const r of Object.values(records)) {
      pauseCommands(r, now(), waiting(r.sessionId));
      for (const c of r.activeCommands ?? []) {
        if (commandMs && c.state !== 'unknown' && !waiting(r.sessionId) && !c.notified
          && commandElapsed(c, now()) >= commandMs && !commandNotices.has(c.noticeId)) {
          void notifyCommand(r, c).catch(e => report({ event: 'unexpected', operation: 'command', taskId: r.taskId, code: e?.code ?? null }));
        }
      }
      if (r.status === 'running') {
        // 承認待ちとロック待ちは、どちらも「子が黙っている」ことに数えない（待ちが終わったら数え直す）
        const isWaiting = waiting(r.sessionId) || lockWaiting(r.sessionId);
        if (isWaiting) {
          if (!silenceWaiting.has(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
          silenceWaiting.set(r.taskId, true);
        }
        else if (silenceWaiting.delete(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
        if (silenceMs && !isWaiting && r.lastActivityAt != null && now() - r.lastActivityAt >= silenceMs
          && r.silenceNotifiedAt !== r.lastActivityAt && !silenceNotices.has(r.taskId)) {
          void notifySilence(r).catch(e => report({ event: 'unexpected', operation: 'silence', taskId: r.taskId, code: e?.code ?? null }));
        }
      } else silenceWaiting.delete(r.taskId);
      if (r.status === 'queued' && !live.has(r.taskId)) {
        const ac = new AbortController(); live.set(r.taskId, ac);
        void run(r, ac).catch(e => { live.delete(r.taskId); report({ event: 'unexpected', operation: 'run', taskId: r.taskId, code: e?.code ?? null }); });
      }
      if (r.notification === 'pending' && !notices.has(r.taskId) && !waited.has(r.taskId) && !ACTIVE.has(r.status)) {
        if (!groups.has(r.parentSessionId)) groups.set(r.parentSessionId, []);
        groups.get(r.parentSessionId).push(r);
      }
    }
    // 同じ親へ届ける完了通知は 1 つにまとめる（ADR 0057）
    for (const [owner, rows] of groups) {
      if (noticeOwners.has(owner)) continue;
      void notify(owner, rows).catch(e => report({ event: 'unexpected', operation: 'notify', taskId: rows[0].taskId, code: e?.code ?? null }));
    }
  }
  const timer = setInterval(kick, 500); timer.unref();
  return {
    get busy() { return live.size > 0 || notices.size > 0 || silenceNotices.size > 0 || commandNotices.size > 0 || Object.values(records).some(r => ACTIVE.has(r.status) || r.notification === 'pending'); },
    list(owner) { return Object.values(records).filter(r => !owner || r.parentSessionId === owner).map(r => view(r)); },
    get(taskId) { return records[taskId] ? view(records[taskId]) : null; },
    observe(sessionId, event) {
      const r = bySession.get(sessionId);
      if (!r || !event?.type) return;
      this.activity(sessionId);
      if (!['tool.start', 'tool.result', 'task.command'].includes(event.type)) return;
      const before = JSON.stringify(r.activeCommands ?? []);
      observeCommand(r, event, now(), waiting(sessionId));
      if (before !== JSON.stringify(r.activeCommands)) void serial(async () => {
        await persist('command.observe', r.taskId);
      });
    },
    activity(sessionId) {
      const r = bySession.get(sessionId);
      if (r?.status === 'running') { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
    },
    checkSilence: kick,
    /**
     * 走っているターンへ渡した完了通知が、読まれないままターンが終わった。まだ同じ回のものなら、空いたときの経路で送り直す
     * （人間の発言と違い、通知は送り直してよい。ADR 0057）。items: [{ taskId, revision }]
     */
    async renotify(items) {
      const rows = items.map(x => records[x.taskId] && [records[x.taskId], x.revision ?? 0]).filter(Boolean)
        .filter(([r, revision]) => r.notification === 'sent' && (r.revision ?? 0) === revision && !ACTIVE.has(r.status));
      if (!rows.length) return;
      await serial(async () => {
        for (const [r] of rows) if (r.notification === 'sent') { r.notification = 'pending'; r.updatedAt = Date.now(); }
        await persist('notify.renotify', rows[0][0].taskId);
        touched();
      });
      kick();
    },
    /**
     * 途中送信で渡した追加指示への「渡った」合図（'delivered'）か、読まれずに捨てられた合図（'dropped'）。
     * 捨てられたら待機へ戻し、次のターンで送る（親からの指示なので送り直してよい。合図の ID で照合するので二重にならない）
     */
    async steered(taskId, instructionId, event) {
      if (event === 'delivered') await resolveClaim(taskId, instructionId, 'delivered');
      else await unclaim(taskId, instructionId);
    },
    /** 子のターンが終わった。渡った合図が来ないままの途中送信は読まれたか分からない（読まれていれば合図が先に来ている）ので待機へ戻し、次のターンで送る */
    async settleSteers(sessionId) {
      const r = bySession.get(sessionId);
      if (!r) return;
      for (const instructionId of [...(steers.get(r.taskId) ?? [])]) await unclaim(r.taskId, instructionId);
    },
    instructions(taskId) { const r = records[taskId]; return r ? { taskId, revision: r.instructionRevision ?? 0, instructions: structuredClone(r.instructions) } : null; },
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
            result: '', error: null, instructions: [], instructionRevision: 0,
            queue: [args.context ? agentT(locale, 'tasks.withContext', { task: args.task, context: args.context }) : args.task] };
          records[taskId] = row; bySession.set(row.sessionId, row);
          try { await write(); } catch (e) { failed(e, 'delegate', taskId); throw refused(locale); }
          touched(); return view(row);
          } catch (e) { delete records[taskId]; bySession.delete(prepared.sessionId); await rollback(prepared); throw e; }
        });
        kick(); return row;
      }
      // 読み取りは保存障害の間も答える。状態はメモリのもので、障害中なら storageFault を添える
      // 一覧は短く保つ。拒否は件数だけ（中身は ply_task_status）
      if (name === 'ply_task_list') return { tasks: Object.values(records).filter(r => r.parentSessionId === owner).map(r => { const { result, rejections, ...rest } = shown(r); return { ...rest, rejectionCount: rejections.length }; }), ...storage(locale) };
      const r = owned(owner, text(locale, args.taskId, 'taskId', 100), locale);
      if (name === 'ply_task_status') {
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) throw new Error(agentT(locale, 'tasks.offsetInvalid'));
        const out = { ...shown(r, offset), ...storage(locale) };
        await markRead(r);
        return out;
      }
      if (name === 'ply_task_wait') {
        const seconds = args.seconds ?? 30;
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error(agentT(locale, 'tasks.secondsInvalid'));
        // 人間の承認待ちになったら待たずに戻る。待つ相手が人間に変わったことを依頼元へ早く伝える
        const pending = () => ACTIVE.has(r.status) && !waiting(r.sessionId);
        // 待っている間に終わったら、結果はこの戻り値で渡す。同じ結果の完了通知を走っているターンへ重ねないよう、待ちの間は通知を控える
        waited.set(r.taskId, (waited.get(r.taskId) ?? 0) + 1);
        try {
          if (pending()) await new Promise(resolve => {
            const done = () => { clearTimeout(timeout); listeners.delete(check); signal?.removeEventListener('abort', done); resolve(); };
            const check = () => { if (!pending()) done(); };
            const timeout = setTimeout(done, seconds * 1000); listeners.add(check); signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
          });
          const out = { ...shown(r), ...storage(locale) };
          await markRead(r);
          return out;
        } finally {
          if (waited.get(r.taskId) > 1) waited.set(r.taskId, waited.get(r.taskId) - 1); else waited.delete(r.taskId);
        }
      }
      if (name === 'ply_task_send') {
        text(locale, args.message, 'message');
        // 追加の指示も新しい仕事なので、保存できなければ受けない（commit が理由付きで断る）
        let instructionId;
        await commit(r.taskId, row => {
          if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
          row.revision = (row.revision ?? 0) + 1;
          // 前の回の拒否を依頼元へ渡し終えていれば、この指示で走る回の分で置き換える。まだ渡していなければ（走っている・通知の前）足していく
          if (NOTICED.has(row.notification)) { delete row.rejections; delete row.rejectionsDropped; }
          const instruction = { id: crypto.randomUUID(), text: args.message, at: Date.now(), state: 'queued' };
          instructionId = instruction.id;
          row.instructions.push(instruction); row.instructionRevision = (row.instructionRevision ?? 0) + 1;
          row.queue.push({ instructionId: instruction.id }); row.notification = 'none'; row.error = null;
          if (!live.has(row.taskId) || !ACTIVE.has(row.status)) row.status = 'queued';
        }, 'send', locale);
        // 子のターンが走っていて途中送信を受けられるなら、待たずに今のターンへ渡す（ADR 0065）
        const steered = await steerInstruction(r, instructionId).catch(e => { report({ event: 'unexpected', operation: 'steer', taskId: r.taskId, code: e?.code ?? null }); });
        kick();
        // 渡ったか分からない指示は送り直さない。依頼元のエージェントには、確かめるよう一言添える
        return steered === 'error' ? { ...view(r), warning: agentT(locale, 'tasks.steerUnknown') } : view(r);
      }
      if (name === 'ply_task_cancel') {
        // 終わったタスクの結果はこの戻り値で渡る。同じ結果の完了通知を後から送らない
        await this.cancel(r.taskId); const out = view(r); await markRead(r); return out;
      }
      throw new Error(agentT(locale, 'tasks.unknownTool'));
    },
    // 取り消したとき止まったもの（走っていた・待っていた）なら、止めた時点の状態を返す（無ければ null）。
    // 終わったタスク（止めるものが無い）の届いていない完了通知は止めない。以前は止めていて、依頼元に結果が届かなかった。
    // 子孫（descendant）は依頼元（このタスクの子の会話）ごと止まるので、今どおり通知も止める
    async cancel(taskId, { descendant = false } = {}) {
      const r = records[taskId]; if (!r) return null;
      // Stop descendant Pleiad tasks too; engine-native children follow their engine's cancellation.
      for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) await this.cancel(child.taskId, { descendant: true });
      const was = r.status, stopping = ACTIVE.has(r.status) || live.has(taskId) || r.queue.length > 0;
      if (!descendant && !stopping && readable(r)) return null;
      // 止めることは保存できなくても止める（record。ファイルは後で追いつく）
      await record(taskId, row => { row.revision = (row.revision ?? 0) + 1; dropInstructions(row); row.notification = 'suppressed'; if (ACTIVE.has(row.status)) row.status = live.has(taskId) ? 'cancelling' : 'cancelled'; }, 'cancel');
      live.get(taskId)?.abort();
      if (!live.has(taskId) && r.activeCommands?.length) await cancelBackground(view(r));
      return stopping && was !== 'cancelling' ? { taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: was } : null;
    },
    // 承認待ちの増減で ply_task_wait を起こす。保存する状態は変わらないので write() は通らない
    wake() { for (const r of Object.values(records)) pauseCommands(r, now(), waiting(r.sessionId)); for (const fn of [...listeners]) fn(); },
    // 会話を止めたときに、その会話が作ったタスク（と子孫）をまとめて止める。cancel と同じ書き換えを、
    // 書き換えて何かが変わるものにだけ行い、保存は 1 回にする。以前は終わったタスクまで 1 件ずつ保存していて
    // （1 会話で数十件になる）、会話の停止を遅らせていた。止め終わって通知も抑えたもの（cancel を呼んでも
    // revision と updatedAt しか変わらない）は飛ばす。子孫は親を飛ばしても辿る。
    // 中断した会話を勝手に再開しないので、終わっていて完了通知が届いていない（none / pending）タスクの通知も止める。
    // その結果は捨てずに返す（unread: true。ply_task_status で読める）。走っていた・待っていたタスクは止めた時点の状態で返す。
    // 返すのは [{ taskId, parentSessionId, title, status, unread }]。server が依頼元の会話ごとに「止めたもの」に残し、
    // 次のターンでエージェントへ伝える（docs/design.md「中断と再開」）
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
      if (!change.length) return [];
      const stopped = [];
      // cancel と同じく、保存できなくても止める
      await serial(async () => {
        for (const r of change) {
          const running = (ACTIVE.has(r.status) || live.has(r.taskId) || r.queue.length > 0) && r.status !== 'cancelling';
          if (running || readable(r)) stopped.push({ taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status, unread: !running });
          r.revision = (r.revision ?? 0) + 1; dropInstructions(r); r.notification = 'suppressed';
          if (ACTIVE.has(r.status)) r.status = live.has(r.taskId) ? 'cancelling' : 'cancelled';
          r.updatedAt = Date.now();
        }
        await persist('cancelOwner');
        touched();
      });
      for (const r of change) live.get(r.taskId)?.abort();
      return stopped;
    },
    /** 再起動で止まった（interrupted にした）タスク。[{ taskId, parentSessionId, title, status }]（status は止まる前の状態） */
    get restored() { return structuredClone(restored); },
    /** 保存障害（無ければ null）。errno・操作・タスク ID・時刻だけ */
    get fault() { return fault && { code: fault.code, syscall: fault.syscall, operation: fault.operation, taskId: fault.taskId, since: fault.since, at: fault.at, failures: fault.failures }; },
    // 正常終了。保存障害では閉じない
    close() { closed = true; clearInterval(timer); for (const ac of live.values()) ac.abort(); },
  };
}
