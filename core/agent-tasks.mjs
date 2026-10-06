import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t, agentT } from './i18n.mjs';
import { observeCommand, pauseCommands, commandElapsed, commandView, isWaitingCommand, commandKey, outputMoving, OUTPUT_MOVING_MS } from './task-commands.mjs';
import { taskTitle } from './task-title.mjs';
import { openData } from './data-schema.mjs';
import { taskTable } from './db.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
// 完了通知がまだ依頼元に届いていない（終わった直後・送る前・送っている最中）。running にはこの間だけ終わったタスクも載せる
const UNDELIVERED = new Set(['none', 'pending', 'delivering']);
// 端末の AI から始まった委譲の鎖の深さの上限（docs/remote.md §4.5、ADR 0146。core/remote/agent-protocol.mjs の AGENT_LIMITS.depth と同じ）。
// 手元の委譲には深さの上限は無い（2026-09-27 に廃止）
const REMOTE_DEPTH_MAX = 4;
// ホストの便りから写しの行へ写す項目（agent-tasks の mirror）。結果・状態・どの委譲先で動いているか
const MIRROR_FIELDS = ['title', 'status', 'error', 'backend', 'model', 'effort', 'mode', 'cwd', 'remoteSessionId', 'worktree', 'routing', 'result', 'resultLength', 'hostWaiting', 'hostPendingMessages', 'cancelPending', 'hostLost'];
// ホストの子を止める依頼を待つ上限。応答しないホストが、会話の中断・「すべて止める」を長く止めない（届かなかった分は cancelPending でつながり直したときに送り直す）
const CANCEL_HOST_MS = 3000;
// ホストが便りで返す taskId の形。端末の台帳の鍵にするので、形を確かめる（__proto__ や手元のタスクの ID を入れさせない）
const TASK_ID = /^ply-task-[0-9a-f-]{36}$/;
// 保存障害の間、スケジューラーが保存をやり直す間隔の上限（ms）。500ms から倍にしていく
const RETRY_MAX = 15000;
// 保存障害の記録（agent-tasks-errors.log）の大きさの上限。超えたら新しい半分だけ残す
const LOG_MAX = 64 * 1024;
// 1 タスクに持つ「知らせた」印（同じコマンド・同じ無音の状態を繰り返し知らせないための印）の上限。古いものから捨てる（ADR 0138）
const NOTICED_MAX = 50;
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
/**
 * 子の作業場所の git の 1 行の要約（変更: <branch> · N ファイル +a −d · コミット k。ADR 0085）。依頼元の言語で。
 * 完了通知（core/server.mjs）と ply_task_status・ply_task_wait の gitSummary が同じ文を使う。要約が無ければ空
 */
export function gitLine(locale, git) {
  if (!git) return '';
  return agentT(locale, 'delegation.noticeGit', { branch: git.branch ?? git.head ?? '(detached)', files: git.files, add: git.add, del: git.del, commits: git.commits });
}

/**
 * 子の worktree の 1 行（作業場所: worktree <branch>（未取り込み · N ファイル）。ADR 0089）。依頼元の言語で。
 * state は core/worktree-host.mjs の taskState（unmerged / merged / empty / unknown / gone）。完了通知と ply_task_status・ply_task_wait の workspaceSummary が同じ文を使う。
 * 作業場所が無ければ（分けていない子）空
 */
export function workspaceLine(locale, worktree, state) {
  if (!worktree) return '';
  const branch = state?.branch ?? worktree.branch, path = state?.path ?? worktree.path, origin = state?.origin ?? worktree.origin;
  const kind = state?.state ?? 'unknown';
  if (kind === 'unmerged') return agentT(locale, 'delegation.noticeWorkspaceUnmerged', { branch, files: state.files ?? 0, path, origin });
  if (kind === 'merged' || (kind === 'gone' && state?.removedAs === 'merged')) return agentT(locale, 'delegation.noticeWorkspaceMerged', { branch });
  if (kind === 'empty' || (kind === 'gone' && state?.removedAs === 'empty')) return agentT(locale, 'delegation.noticeWorkspaceEmpty', { branch });
  // 未取り込みだったものが、もう無い（依頼元が取り込んで片付いた・退避して消した）
  if (kind === 'gone') return agentT(locale, 'delegation.noticeWorkspaceGone', { branch });
  return agentT(locale, 'delegation.noticeWorkspaceUnknown', { branch, path });
}

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
// 記録は SQLite の agent_tasks（1 タスク 1 行。core/db.mjs、ADR 0115）。保存するのは変わった行だけで、タスクが増えても 1 回の保存は重くならない。
// taskStorage・io・log・retryMax はテストで失敗を差し込み、記録を読み、待ちを縮めるためのもの（taskStorage は { loadRows(), save(rows) }、io は障害の記録のファイル）
// ready は「親が新しいターンで完了通知を受け取れるか」、steerable は「走っている親のターンへ今すぐ渡せるか」（ADR 0057）。
// deliver は同じ親へ届ける完了通知（1 件以上）をまとめて受け取る。無音・コマンドの通知は ready だけで決める
// childSteerable は「走っている子のターンへ追加指示を今すぐ渡せるか」、steer(task, { id, text }) はその途中送信。
// 'delivered'（受理。合図の無いバックエンドは渡ったものとして扱う）/ 'pending'（受理。渡った合図を steered() で待つ）/
// 'requeue'（受理されない。待機のまま次のターンで）/ 'error'（結果不明。送り直さない）を返す（ADR 0065）
export async function createAgentTasks({ dataDir, prepare, rollback = async () => {}, execute, deliver, deliverSilence = async () => 'ok', deliverCommand = async () => 'ok', cancelBackground = async () => {}, ready = async () => true, steerable = async () => false, childSteerable = async () => false, steer = async () => 'requeue', changed = () => {}, waiting = () => false,
  // リモートのホストに任せたタスクの写し（row.host を持つ行。docs/agent-delegation.md「リモートのホストへ任せる」）: 今、依頼元の会話に中継された承認を待っているか・ホストのタスクを止める口
  remoteWaiting = () => false, cancelHost = async () => {},
  // コンピューターの操作のロックを待っているか（docs/computer-use.md「ロック・待ち・止めた印」）。承認待ちではないので status: waiting にはせず、沈黙の通知にだけ数えない
  lockWaiting = () => false,
  // 子の worktree の今の状態（core/worktree-host.mjs の taskState）。ply_task_status・ply_task_wait の workspaceSummary に使う
  workspaceState = async () => null,
  now = Date.now, silenceMinutes = Number(process.env.AGENT_HOST_TASK_SILENCE_MINUTES ?? 5),
  commandMinutes = Number(process.env.AGENT_HOST_TASK_COMMAND_MINUTES ?? 5),
  io = fs, log = line => console.error(line), retryMax = RETRY_MAX, taskStorage = null,
  // 付け直すターン（無停止の更新 2b-7）の委譲の子のタスク id。起動の復元で interrupted にせず、adoptRun() が結果の確定を引き継ぐ（stage2-server-state.md S8）
  adopting = [] }) {
  const silenceMs = Number.isFinite(silenceMinutes) && silenceMinutes > 0 ? silenceMinutes * 60000 : 0;
  const commandMs = Number.isFinite(commandMinutes) && commandMinutes > 0 ? commandMinutes * 60000 : 0;
  const commandNotices = new Set();
  const logFile = path.join(dataDir, 'agent-tasks-errors.log');
  let handle = null;
  let rowStore = taskStorage;
  if (!rowStore) {
    handle = openData(dataDir);
    const rows = taskTable(handle.db);
    rowStore = { loadRows: () => rows.loadRows(), save: list => rows.save(list) };
  }
  // 最後に DB へ書けた JSON（taskId -> 文字列）。変わった行だけを書くための比べ元
  const saved = new Map();
  let records = Object.create(null);   // 鍵はホストの便りの taskId も入る。Object.prototype の名前（__proto__ など）で引かれないようにする
  for (const [taskId, json] of rowStore.loadRows()) { records[taskId] = JSON.parse(json); saved.set(taskId, json); }
  // ホストに任せたタスクの写し（host）は、この PC の会話を持たない（sessionId なし）。会話の ID で引く表には入れない
  const bySession = new Map(Object.values(records).filter(r => r.sessionId).map(r => [r.sessionId, r]));
  // Older files kept only prompt strings in queue. Preserve their order and make
  // pending follow-ups visible without replaying the initial delegation request.
  // 承認待ちか。ホストに任せたタスクの写しは、ホストの便り（hostWaiting）か、依頼元の会話に中継された承認の有無で決まる
  const waitingOf = r => r.host ? r.hostWaiting === true || remoteWaiting(r) : waiting(r.sessionId);
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
    for (const instruction of r.instructions ?? []) { deferredInstructions.delete(instruction.id); if (instruction.state === 'queued') setInstruction(r, instruction.id, 'dropped'); }
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
  // RPC の送信順だけを直列化する。配送確認は次の送信を止めない。
  const instructionSends = new Map(), deferredInstructions = new Set(), settlingInstructions = new Set();
  const live = new Map(), notices = new Set(), noticeOwners = new Set(), waited = new Map(), silenceNotices = new Set(), silenceWaiting = new Map(), listeners = new Set();
  const serial = fn => {
    const next = writes.then(async () => { mutating = true; try { return await fn(); } finally { mutating = false; } });
    writes = next.catch(() => {});
    return next;
  };
  // 裏で走らせている仕事（実行・通知・保存のやり直し・障害の記録）。close() は、閉じる前に始まったこれらが書き終えるまで待つ。
  // 渡す Promise は reject しないもの（呼ぶ側で catch 済み）に限る
  const background = new Set();
  const spawn = p => { background.add(p); void p.finally(() => background.delete(p)); };
  const touched = () => { changed(); for (const fn of [...listeners]) fn(); };
  // 障害の記録。秘密・依頼文・結果・パスは書かない（errno・操作・タスク ID・時刻だけ）。
  // stderr はデスクトップ版ではファイルに残らないので、データ置き場にも大きさの上限付きで残す
  const report = entry => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    log(`[agent-tasks] ${line}`);
    spawn((async () => {
      const size = await io.stat(logFile).then(s => s.size, () => 0);
      if (size > LOG_MAX) { const old = await io.readFile(logFile, 'utf8'); await io.writeFile(logFile, old.slice(-LOG_MAX / 2).replace(/^[^\n]*\n/, '')); }
      await io.appendFile(logFile, line + '\n');
    })().catch(() => {}));
  };
  // ids の行（と、前に書けなかった行）のうち、最後に書けた JSON から変わったものだけを書く。ids が無ければ全部の行を見る。
  // 保存障害の間は、変わった行が無くても書き込みを試す（書けるようになったかを確かめる）
  const unsaved = new Set();
  const write = async ids => {
    const targets = new Set([...(ids === undefined ? Object.keys(records) : ids), ...unsaved]);
    const rows = [];
    for (const id of targets) {
      if (!records[id]) continue;
      const json = JSON.stringify(records[id]);
      if (saved.get(id) !== json) rows.push([id, json]);
    }
    try { if (rows.length || fault) await rowStore.save(rows); }
    catch (e) { for (const id of targets) unsaved.add(id); throw e; }
    for (const [id, json] of rows) { saved.set(id, json); persisted.set(id, records[id].notification); }
    for (const id of targets) { unsaved.delete(id); if (records[id] && !rows.some(([rowId]) => rowId === id)) persisted.set(id, records[id].notification); }
    dirty = unsaved.size > 0;
    if (fault) { report({ event: 'saveRecovered', failures: fault.failures, since: new Date(fault.since).toISOString() }); fault = null; }
  };
  const failed = (e, operation, taskId = null) => {
    const at = Date.now(), failures = (fault?.failures ?? 0) + 1;
    fault = { code: String(e?.code ?? 'UNKNOWN'), syscall: e?.syscall ?? null, operation, taskId, since: fault?.since ?? at, at, failures,
      retryAt: at + Math.min(retryMax, 500 * 2 ** (failures - 1)) };
    report({ event: 'saveFailed', code: fault.code, errno: e?.errno ?? null, syscall: fault.syscall, operation, taskId, failures });
  };
  // 起きたことを書く。失敗したらメモリはそのままにし、スケジューラーが後で書き直す
  // taskIds: 書き換えたタスクの id（1 つか配列）。無ければ全部。障害の記録には先頭の 1 件を載せる
  const persist = async (operation, taskIds) => {
    const ids = taskIds === undefined ? undefined : [taskIds].flat();
    try { await write(ids); } catch (e) { dirty = true; failed(e, operation, ids?.[0]); }
  };
  // 保存できないので受け付けなかった、という依頼元への返事
  const refused = locale => new Error(agentT(locale, 'tasks.storageFailed', { code: fault?.code ?? 'UNKNOWN' }));
  const storage = locale => fault ? { storageFault: { error: agentT(locale, 'tasks.storageFault', { code: fault.code, since: new Date(fault.since).toISOString() }),
    code: fault.code, since: fault.since, failures: fault.failures } } : {};
  // 再起動: 実行中だったものは再実行しない。まだ親に渡っていない pending はそのまま送り直す。
  // 渡ったか分からない delivering だけを unknown にする（二重に届けない）
  // restored: 再起動で止まった（interrupted にした）タスク。server が依頼元の会話の「止めたもの」に残す（docs/design.md「中断と再開」）
  const restored = [];
  // 付け直す子のタスク（taskId -> 走っている印）。子のターンは新しいサーバーが続けているので、止めずに adoptRun() を待つ。
  // 走っているのは running か cancelling の行だけ（取り消しの最中なら、その印も付けておく）
  const adoptable = new Map();
  for (const taskId of adopting) {
    const r = records[taskId];
    if (!r || r.host || !['running', 'cancelling'].includes(r.status)) continue;
    const ac = new AbortController();
    if (r.status === 'cancelling') ac.abort();
    adoptable.set(taskId, ac);
  }
  for (const r of Object.values(records)) {
    // ホストに任せたタスクの写しは、ホストで続いている。再起動で止めず、つながり直したときの同期で追いつく
    if (adoptable.has(r.taskId)) continue;
    if (ACTIVE.has(r.status) && !r.host) {
      restored.push({ taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status });
      r.status = 'interrupted'; r.error = t('tasks.interruptedByRestart');
      for (const instruction of r.instructions ?? []) if (instruction.state === 'sending') setInstruction(r, instruction.id, 'delivered');
      dropInstructions(r);
    }
    for (const c of r.activeCommands ?? []) { c.state = 'unknown'; c.pausedAt = null; }
    if (r.notification === 'delivering') r.notification = 'unknown';
  }
  for (const [taskId, ac] of adoptable) live.set(taskId, ac);
  await serial(() => persist('restore'));
  const owned = (owner, id, locale) => {
    const r = records[id];
    if (!r || r.parentSessionId !== owner) throw new Error(agentT(locale, 'tasks.notOwned'));
    return r;
  };
  // context は「別の候補でやり直す」で同じ依頼を渡し直すために持つだけ（長いので一覧・状態には載せない）
  const view = (r, offset = 0) => {
    const { result = '', queue, context, instructions, rejections = [], silenceNotifiedAt, noticedCommands, noticedSilence, lastOutputAt, activeCommands = [], ...rest } = r;
    pauseCommands(r, now(), waitingOf(r));
    return { ...rest, activeCommands: activeCommands.map(c => commandView(c, now())), silenceMinutes: r.status === 'running' && !waitingOf(r) && !lockWaiting(r.sessionId) && r.lastActivityAt != null
      ? Math.max(0, Math.floor((now() - r.lastActivityAt) / 60000)) : null,
      rejections, pendingMessages: instructions.filter(x => x.state === 'queued').length, result: result.slice(offset, offset + 16000), resultOffset: offset,
      resultLength: result.length, nextOffset: offset + 16000 < result.length ? offset + 16000 : null };
  };
  // 依頼元のエージェントへ返す形。人間の承認待ちは「いま待っているか」から導く見せかけの状態で、
  // 保存する status（queued / running …）は変えない。ACTIVE の集合と再起動時の interrupted の扱いを壊さないため
  const shown = (r, offset = 0) => {
    const v = view(r, offset);
    return ACTIVE.has(r.status) && waitingOf(r) ? { ...v, status: 'waiting' } : v;
  };
  // worktree の今の状態の 1 行（ply_task_status・ply_task_wait）。作業場所を持たない子・状態が引けないときは何も足さない。
  // 片付け済み（もう無い）は、完了時の状態（row.workspace）から言う
  async function workspaceOf(r, locale) {
    if (!r.worktree) return {};
    let state = await workspaceState(structuredClone(r)).catch(() => null);
    if (state?.state === 'gone' && r.workspace) state = { ...r.workspace, ...state, state: 'gone', removedAs: r.workspace.state };
    if (!state) state = r.workspace ?? null;
    return { workspace: state ? { branch: state.branch ?? r.worktree.branch, path: state.path ?? r.worktree.path, origin: r.worktree.origin, state: state.state, files: state.files ?? 0 } : undefined,
      workspaceSummary: workspaceLine(locale, r.worktree, state) };
  }
  const restore = (r, before) => { for (const key of Object.keys(r)) delete r[key]; Object.assign(r, before); };
  /**
   * ホストの子を止める。届かなければ（オフライン・許可切れ・応答なし）止める予定（cancelPending）として行に残し、つながり直したとき送り直す
   * （ホストの便りで running に戻さない。mirror）。待つのは CANCEL_HOST_MS まで
   */
  async function stopHost(r) {
    let sent = false, timer;
    try { sent = await Promise.race([cancelHost(structuredClone(r)), new Promise(res => { timer = setTimeout(res, CANCEL_HOST_MS, false); })]) === true; } catch { sent = false; } finally { clearTimeout(timer); }
    if (!sent && records[r.taskId]) await record(r.taskId, row => { row.cancelPending = true; }, 'cancel.pending');
  }
  // 保存できてから先へ進む書き換え。保存に失敗したらメモリを戻し、理由付きのエラーを投げる
  async function commit(id, fn, operation, locale) {
    return serial(async () => {
      const r = records[id], before = structuredClone(r);
      try { fn(r); r.updatedAt = Date.now(); } catch (e) { restore(r, before); throw e; }
      try { await write([id]); } catch (e) { restore(r, before); failed(e, operation, id); throw refused(locale); }
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
  const idsOf = value => Array.isArray(value) ? value : [value];
  function unclaim(taskId, instructionIds) {
    return serial(async () => {
      const row = records[taskId], claims = steers.get(taskId);
      if (!row || !claims) return;
      const ids = idsOf(instructionIds).filter(id => claims.delete(id));
      if (!ids.length) return;
      if (!claims.size) steers.delete(taskId);
      if (['cancelling', 'cancelled', 'interrupted'].includes(row.status)) {
        for (const id of ids) setInstruction(row, id, 'dropped');
      } else {
        for (const id of ids) {
          row.queue.push({ instructionId: id }); setInstruction(row, id, 'queued');
          deferredInstructions.add(id);   // 明示的拒否・未受信は次のターンで送る
        }
        const order = new Map(row.instructions.map((instruction, index) => [instruction.id, index]));
        row.queue.sort((a, b) => (order.get(a.instructionId) ?? -1) - (order.get(b.instructionId) ?? -1));
        if (!ACTIVE.has(row.status)) { row.status = 'queued'; row.notification = 'none'; }
      }
      row.updatedAt = Date.now();
      await persist('send.steer.requeue', taskId); touched();
    });
  }
  function resolveClaim(taskId, instructionIds, state) {
    return serial(async () => {
      const row = records[taskId], claims = steers.get(taskId);
      if (!row || !claims) return;
      const ids = idsOf(instructionIds).filter(id => claims.delete(id));
      if (!ids.length) return;
      if (!claims.size) steers.delete(taskId);
      for (const id of ids) setInstruction(row, id, state);
      row.updatedAt = Date.now();
      await persist('send.steer.done', taskId); touched();
    });
  }
  // その時点の待機分をまとめて送る。先の配送確認を待たず、RPC の受理後に次の待機分も送る。
  function steerInstructions(r) {
    if (instructionSends.has(r.taskId)) return instructionSends.get(r.taskId).then(async unknown => new Set([...unknown, ...await steerInstructions(r)]));
    const eligible = () => !closed && !fault && !settlingInstructions.has(r.taskId)
      && r.status === 'running' && live.has(r.taskId) && r.queue.length
      && !r.queue.some(entry => !entry.instructionId || deferredInstructions.has(entry.instructionId));
    const send = (async () => {
      const unknown = new Set();
      while (eligible() && await childSteerable(structuredClone(r)).catch(() => false)) {
        const batch = await serial(async () => {
          if (!eligible()) return null;
          const before = structuredClone(r);
          const ids = r.queue.map(entry => entry.instructionId);
          const text = ids.map(id => r.instructions.find(i => i.id === id).text).join('\n\n');
          r.queue = [];
          for (const id of ids) setInstruction(r, id, 'sending');
          r.updatedAt = Date.now();
          try { await write([r.taskId]); }
          catch (e) { restore(r, before); failed(e, 'send.steer', r.taskId); throw e; }
          const claims = steers.get(r.taskId) ?? new Set();
          for (const id of ids) claims.add(id);
          steers.set(r.taskId, claims); touched();
          return { id: ids[0], ids, text };
        });
        if (!batch) break;
        const outcome = await steer(structuredClone(r), batch).catch(() => 'error');
        if (outcome === 'delivered') await resolveClaim(r.taskId, batch.ids, 'delivered');
        else if (outcome === 'error') {
          await resolveClaim(r.taskId, batch.ids, 'dropped');
          for (const id of batch.ids) if (r.instructions.find(i => i.id === id)?.state === 'dropped') unknown.add(id);
        }
        else if (outcome !== 'pending') { await unclaim(r.taskId, batch.ids); break; }
      }
      return unknown;
    })();
    instructionSends.set(r.taskId, send);
    const tracked = send.finally(() => instructionSends.delete(r.taskId));
    instructionSends.set(r.taskId, tracked);
    return tracked;
  }
  // adopted: 付け直した子のターン（adopt）の、結果を確定する側（task, signal）=> execute と同じ形の結果。1 回目の実行だけ、実行の開始を書かずにこれを待つ
  async function run(r, controller, adopted = null) {
    // stalled: 実行の開始を保存できなかった。子は動かしていないので queued のまま、次のタイマーでやり直す
    let stalled = false, requeued = false, activeInstructionIds, handedOff = false;
    // close()（正常終了）の abort。止めたことは書かず、走っていた状態のままファイルに残す（再起動で interrupted になる。
    // docs/agent-delegation.md「保存・画面・再起動」）。利用者の取り消しは先に cancelling にするので、それは cancelled を書く。
    // 子のターンを新しいサーバーへ渡した（execute が handedOff を返した）ときも、結果は新しいサーバーが書く
    const halted = () => (closed && r.status !== 'cancelling') || handedOff;
    try {
      while (!controller.signal.aborted) {
        let prompt, instructionIds;
        settlingInstructions.delete(r.taskId);
        if (adopted) {
          // この回の指示は、旧サーバーが実行の開始で sending にしたもの。途中送信で渡している最中の分（steers の claim）は含めない
          const claims = steers.get(r.taskId) ?? new Set();
          instructionIds = (r.instructions ?? []).filter(x => x.state === 'sending' && !claims.has(x.id)).map(x => x.id);
        } else try { await commit(r.taskId, row => {
          const entry = row.queue.shift();
          instructionIds = [];
          if (entry?.instructionId) {
            instructionIds.push(entry.instructionId);
            while (row.queue[0]?.instructionId) instructionIds.push(row.queue.shift().instructionId);
            prompt = instructionIds.map(id => row.instructions.find(x => x.id === id)?.text ?? '').join('\n\n');
          } else prompt = entry;
          for (const id of instructionIds) { setInstruction(row, id, 'sending'); deferredInstructions.delete(id); }
          row.status = 'running'; row.lastActivityAt = now(); row.silenceNotifiedAt = null;
        }, 'run.start'); }
        catch { stalled = true; break; }
        activeInstructionIds = instructionIds;
        const finish = adopted;
        adopted = null;
        const result = finish ? await finish(structuredClone(r), controller.signal) : await execute(structuredClone(r), prompt, controller.signal);
        if (result?.handedOff) handedOff = true;
        if (halted()) return;
        if (result?.requeue) {
          await record(r.taskId, row => { row.queue.unshift(...(instructionIds.length ? instructionIds.map(instructionId => ({ instructionId })) : [prompt])); for (const id of instructionIds) setInstruction(row, id, 'queued'); row.status = 'queued'; }, 'run.requeue');
          activeInstructionIds = undefined; requeued = true;
          return;
        }
        await record(r.taskId, row => {
          row.result = String(result?.text ?? ''); row.error = result?.error ?? null;
          // 子の作業場所の git の要約（ADR 0085。変更・コミットが無ければ載せない）。完了通知と ply_task_status に出る
          if (result?.git) row.git = result.git; else delete row.git;
          // 子の worktree の、終わった時点の状態（ADR 0089。取り込まれていなければ完了通知に 1 行出る）
          if (result?.workspace) row.workspace = result.workspace; else delete row.workspace;
          // 追加の指示で再開した回に、片付いていた作業場所を作り直したとき
          if (result?.worktree) row.worktree = result.worktree;
          for (const id of instructionIds) setInstruction(row, id, 'delivered');
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
        activeInstructionIds = undefined;
        if (r.status !== 'queued') break;
      }
    } catch (e) {
      if (!halted()) await record(r.taskId, row => { row.status = controller.signal.aborted ? 'cancelled' : 'failed'; row.error = String(e.message ?? e); for (const id of activeInstructionIds ?? []) setInstruction(row, id, 'dropped'); dropInstructions(row); }, 'run.error');
    } finally {
      if (halted()) { live.delete(r.taskId); return; }
      // 止まった後（run.result / run.error で cancelled）に ply_task_send で積まれた指示は、止めた回の分ではない。
      // cancelled に戻して捨てず、下の kick で次の実行にする（docs/agent-delegation.md「ツール」の ply_task_send）
      if (r.status === 'cancelling' || controller.signal.aborted) await record(r.taskId, row => { if (!requeued && row.status === 'queued' && row.queue.length) return; row.status = 'cancelled'; dropInstructions(row); }, 'run.cancelled');
      live.delete(r.taskId); settlingInstructions.delete(r.taskId);
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
      try { await write(list.map(r => r.taskId)); } catch (e) {
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
        await persist('notify.done', sending.map(r => r.taskId));
        touched();
      });
    } finally { for (const r of rows) notices.delete(r.taskId); noticeOwners.delete(owner); }
  }
  // 「止まっている可能性」の通知は、待っているだけの子には出さず、出すなら同じ子・同じコマンドで 1 回だけ（ADR 0138）。
  // 待っている先が動いている（実際の出力が伸びている）間と、明らかに待つためのコマンド（until / sleep / gh run watch など）は控える。
  // 控えたものは通知済みにしない（待ちが終わって、なお黙っているなら、そのとき 1 回だけ出す）
  // 裏（background）のコマンドは、子が別の道具や出力で動いている間は、その子の止まっている根拠にしない
  // 「動いている」とみなす間は 1 分。コマンドの時間を短くした設定（テスト）ではその長さまで縮める
  const quietMs = Math.min(OUTPUT_MOVING_MS, commandMs || OUTPUT_MOVING_MS);
  const childBusy = r => r.lastActivityAt != null && now() - r.lastActivityAt < quietMs;
  const commandFit = (r, c) => c.state !== 'unknown' && !isWaitingCommand(c.command) && !outputMoving(r, now(), quietMs) && !(c.state === 'background' && childBusy(r));
  const commandNoticed = (r, c) => Boolean(r.noticedCommands?.includes(commandKey(c.command)));
  const silenceSignature = r => (r.activeCommands ?? []).filter(c => c.state !== 'unknown').map(c => commandKey(c.command)).sort().join('\n');
  const silenceFit = r => !(r.activeCommands ?? []).some(c => c.state !== 'unknown' && isWaitingCommand(c.command));
  const remember = (r, field, key) => { const list = r[field] ??= []; if (!list.includes(key)) { list.push(key); if (list.length > NOTICED_MAX) list.shift(); } };
  const forget = (r, field, key) => { if (r[field]) r[field] = r[field].filter(k => k !== key); };
  async function notifySilence(r) {
    silenceNotices.add(r.taskId);
    const activityAt = r.lastActivityAt;
    const signature = silenceSignature(r);
    try {
      if (!(await ready(structuredClone(r)).catch(() => false))) return;
      if (r.status !== 'running' || waitingOf(r) || lockWaiting(r.sessionId) || r.lastActivityAt !== activityAt || r.silenceNotifiedAt === activityAt
        || !silenceFit(r) || r.noticedSilence?.includes(signature)) return;
      // Mark before delivery, as with completion notices: an uncertain delivery must not be repeated.
      try { await commit(r.taskId, row => { row.silenceNotifiedAt = activityAt; remember(row, 'noticedSilence', signature); }, 'silence.notice'); }
      catch { return; }
      if (r.status !== 'running' || waitingOf(r) || lockWaiting(r.sessionId) || r.lastActivityAt !== activityAt) return;
      const outcome = await deliverSilence(structuredClone(r), Math.max(1, Math.floor((now() - activityAt) / 60000))).catch(() => 'error');
      if (outcome === 'requeue' && r.lastActivityAt === activityAt) await record(r.taskId, row => { row.silenceNotifiedAt = null; forget(row, 'noticedSilence', signature); }, 'silence.requeue');
    } finally { silenceNotices.delete(r.taskId); }
  }
  async function notifyCommand(r, command) {
    const id = command.noticeId;
    commandNotices.add(id);
    const current = () => r.activeCommands?.find(c => c.noticeId === id);
    const eligible = () => {
      const c = current();
      return c && commandFit(r, c) && !waitingOf(r) && commandElapsed(c, now()) >= commandMs;
    };
    // 同じ子で同じコマンドは、もう知らせた（繰り返しの確認・再実行で何度も知らせない）
    const key = command.command;
    const release = () => { if (current()) current().notified = false; forget(r, 'noticedCommands', commandKey(key)); };
    try {
      if (!(await ready(structuredClone(r)).catch(() => false)) || !eligible() || current().notified || commandNoticed(r, current())) return;
      const marked = await serial(async () => {
        if (!eligible() || current().notified || commandNoticed(r, current())) return false;
        current().notified = true;
        remember(r, 'noticedCommands', commandKey(key));
        try { await write([r.taskId]); return true; }
        catch (e) {
          release();
          failed(e, 'command.notice', r.taskId);
          return false;
        }
      });
      if (!marked) return;
      if (!eligible()) {
        if (current()) await record(r.taskId, release, 'command.defer');
        return;
      }
      const c = current();
      const outcome = await deliverCommand(structuredClone(r), { ...commandView(c, now()), noticeId: id }).catch(() => 'error');
      if (outcome === 'requeue' && current()) await record(r.taskId, release, 'command.requeue');
    } finally { commandNotices.delete(id); }
  }
  // 保存障害の間は、間隔を空けて保存だけをやり直す（1 回に 1 秒ほど待つ保存を、500ms ごとに仕事の数だけ重ねない）。
  // 書けたら障害を解き、次のタイマーから実行の開始と通知を再開する
  function probe() {
    if (probing || Date.now() < fault.retryAt) return;
    probing = true;
    spawn(serial(async () => { try { await write([]); touched(); } catch (e) { failed(e, dirty ? 'flush' : 'retry'); } })
      .finally(() => { probing = false; }));
  }
  function kick() {
    if (closed || mutating) return;
    if (fault) { probe(); return; }
    const groups = new Map();
    for (const r of Object.values(records)) {
      // ホストに任せたタスクの写しは走らせない（ホストが正本）。完了通知だけ、手元の委譲と同じに届ける
      if (r.host) {
        if (r.notification === 'pending' && !notices.has(r.taskId) && !waited.has(r.taskId) && !ACTIVE.has(r.status)) {
          if (!groups.has(r.parentSessionId)) groups.set(r.parentSessionId, []);
          groups.get(r.parentSessionId).push(r);
        }
        continue;
      }
      pauseCommands(r, now(), waitingOf(r));
      for (const c of r.activeCommands ?? []) {
        if (commandMs && commandFit(r, c) && !waitingOf(r) && !c.notified && !commandNoticed(r, c)
          && commandElapsed(c, now()) >= commandMs && !commandNotices.has(c.noticeId)) {
          spawn(notifyCommand(r, c).catch(e => report({ event: 'unexpected', operation: 'command', taskId: r.taskId, code: e?.code ?? null })));
        }
      }
      if (r.status === 'running') {
        if (r.queue.length && !instructionSends.has(r.taskId)) spawn(steerInstructions(r).catch(e => report({ event: 'unexpected', operation: 'steer', taskId: r.taskId, code: e?.code ?? null })));
        // 承認待ちとロック待ちは、どちらも「子が黙っている」ことに数えない（待ちが終わったら数え直す）
        const isWaiting = waitingOf(r) || lockWaiting(r.sessionId);
        if (isWaiting) {
          if (!silenceWaiting.has(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
          silenceWaiting.set(r.taskId, true);
        }
        else if (silenceWaiting.delete(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
        if (silenceMs && !isWaiting && r.lastActivityAt != null && now() - r.lastActivityAt >= silenceMs
          && r.silenceNotifiedAt !== r.lastActivityAt && !silenceNotices.has(r.taskId)
          && silenceFit(r) && !r.noticedSilence?.includes(silenceSignature(r))) {
          spawn(notifySilence(r).catch(e => report({ event: 'unexpected', operation: 'silence', taskId: r.taskId, code: e?.code ?? null })));
        }
      } else silenceWaiting.delete(r.taskId);
      if (r.status === 'queued' && !live.has(r.taskId)) {
        const ac = new AbortController(); live.set(r.taskId, ac);
        spawn(run(r, ac).catch(e => { live.delete(r.taskId); report({ event: 'unexpected', operation: 'run', taskId: r.taskId, code: e?.code ?? null }); }));
      }
      if (r.notification === 'pending' && !notices.has(r.taskId) && !waited.has(r.taskId) && !ACTIVE.has(r.status)) {
        if (!groups.has(r.parentSessionId)) groups.set(r.parentSessionId, []);
        groups.get(r.parentSessionId).push(r);
      }
    }
    // 同じ親へ届ける完了通知は 1 つにまとめる（ADR 0057）
    for (const [owner, rows] of groups) {
      if (noticeOwners.has(owner)) continue;
      spawn(notify(owner, rows).catch(e => report({ event: 'unexpected', operation: 'notify', taskId: rows[0].taskId, code: e?.code ?? null })));
    }
  }
  const timer = setInterval(kick, 500); timer.unref();
  return {
    // ホストに任せたタスクの写しは、ホストで動いている（この PC の更新・終了を止めない）。完了通知がまだ届いていないものだけ数える
    get busy() { return live.size > 0 || notices.size > 0 || silenceNotices.size > 0 || commandNotices.size > 0 || Object.values(records).some(r => (ACTIVE.has(r.status) && !r.host) || r.notification === 'pending'); },
    list(owner) { return Object.values(records).filter(r => !owner || r.parentSessionId === owner).map(r => view(r)); },
    /** sessionIds の会話が作った行と、その子孫の行の view（ホストに任された子の下の孫を数える・止める。docs/remote.md §4.5） */
    descendants(sessionIds) {
      const roots = new Set(sessionIds.filter(Boolean));
      const seen = new Set(), out = [];
      for (let grew = true; grew;) {
        grew = false;
        for (const r of Object.values(records)) {
          if (seen.has(r.taskId) || !roots.has(r.parentSessionId)) continue;
          seen.add(r.taskId); out.push(view(r)); grew = true;
          if (r.sessionId) roots.add(r.sessionId);
        }
      }
      return out;
    },
    /** 記録の行が条件に合うものだけの view（端末の AI に任された作業のように、全部を view にしたくないとき） */
    rowsWhere(predicate) { return Object.values(records).filter(predicate).map(r => view(r)); },
    /**
     * 全端末へ配る running に載せる行（docs/agent-delegation.md「保存・画面・再起動」）。終わっていないものと、完了通知がまだ依頼元に
     * 届いていないものだけ。依頼文・振り分けの記録・結果は載せない（過去のタスクは画面が会話ごとに delegation.tasks で読む）
     */
    running() {
      return Object.values(records).filter(r => ACTIVE.has(r.status) || UNDELIVERED.has(r.notification)).map(r => ({
        taskId: r.taskId, title: taskTitle(r.title, r.task), status: r.status, parentSessionId: r.parentSessionId, sessionId: r.sessionId,
        backend: r.backend ?? null, model: r.model ?? null, effort: r.effort ?? null, createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null,
        notification: r.notification, error: r.error ? String(r.error).slice(0, 500) : null,
        pendingMessages: (r.instructions ?? []).filter(x => x.state === 'queued').length, instructionRevision: r.instructionRevision ?? 0,
        worktree: r.worktree ?? null, retryOf: r.routing?.retry?.of ?? null,
        ...(r.host ? { host: r.host, remoteSessionId: r.remoteSessionId ?? null, hostWaiting: waitingOf(r) } : {}),
      }));
    },
    get(taskId, offset = 0) { return records[taskId] ? view(records[taskId], offset) : null; },
    observe(sessionId, event) {
      const r = bySession.get(sessionId);
      if (!r || !event?.type) return;
      if (event.type === 'task.activity' && event.output) r.lastOutputAt = now();
      this.activity(sessionId);
      if (!['tool.start', 'tool.result', 'task.command'].includes(event.type)) return;
      observeCommand(r, event, now(), waiting(sessionId));
      // These observations are live state. A restart marks saved commands as
      // unknown, so saving the whole task file for each command adds no value.
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
        await persist('notify.renotify', rows.map(([r]) => r.taskId));
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
      settlingInstructions.add(r.taskId);
      await instructionSends.get(r.taskId)?.catch(() => {});
      await unclaim(r.taskId, [...(steers.get(r.taskId) ?? [])]);
    },
    /**
     * 付け直した子のターン（起動の adopting に渡した taskId。無停止の更新 2b-7）の、結果の確定を引き継ぐ。
     * finish(task, signal) は execute の後半（子のターンが終わるのを待って結果を作る。execute と同じ形の結果を返す）。
     * claims は途中送信で渡している最中の追加指示の ID（旧サーバーの steers。札の liveInstructions）で、行がまだ sending のものだけ引き継ぐ
     * （旧サーバーが渡った合図を処理し終えていたら、行は delivered か queued になっていて、もう待たない）。
     * finish が無ければ付け直せなかったので、起動の復元と同じに interrupted にする。引き継げたら true
     */
    adoptRun(taskId, finish, { claims = [] } = {}) {
      const r = records[taskId], ac = live.get(taskId);
      if (!r || !ac || !adoptable.delete(taskId)) return false;
      if (!finish) {
        live.delete(taskId);
        spawn(record(taskId, row => {
          row.status = 'interrupted'; row.error = t('tasks.interruptedByRestart');
          for (const instruction of row.instructions ?? []) if (instruction.state === 'sending') setInstruction(row, instruction.id, 'delivered');
          dropInstructions(row);
        }, 'adopt.abandon').catch(() => {}));
        return false;
      }
      const claimed = new Set(claims.filter(id => r.instructions?.find(x => x.id === id)?.state === 'sending'));
      if (claimed.size) steers.set(taskId, claimed);
      spawn(run(r, ac, finish).catch(e => { live.delete(taskId); report({ event: 'unexpected', operation: 'adopt', taskId, code: e?.code ?? null }); }));
      return true;
    },
    /** 子のバックエンドの入力が開いた。起動中に溜まった指示を現在のターンへ渡す */
    async sendQueued(sessionId) {
      const r = bySession.get(sessionId);
      if (r) return steerInstructions(r);
    },
    /**
     * 依頼元が子の設定（エージェント・モデル・思考の強さ）を替えた（ply_task_send の backend・model・effort。ADR 0134）。
     * 子の会話へ入れるのは server（applyTaskSettings）。ここはタスクの記録だけ: backend・model・effort（と替えたなら mode）を新しい値にし、
     * routing.target を新しい委譲先に、routing.changed に「依頼元が替えた」印（最初の委譲先 from・時刻・回数）を残す。保存できなければ断る。
     * 今の値と同じなら何も書かない（changed: false）。最初の委譲先へ戻したら印を外す。
     * 返すのは { task, changed, previous }。previous は書く前の値で、後の失敗で戻すとき（untarget）に使う
     */
    async retarget(owner, taskId, { backend, model, effort, mode, account }, locale) {
      const r = owned(owner, taskId, locale);
      if (r.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
      const same = (a, b) => (a.backend ?? null) === (b.backend ?? null) && (a.model ?? '') === (b.model ?? '') && (a.effort ?? '') === (b.effort ?? '');
      if (same(r, { backend, model, effort }) && (r.mode ?? '') === (mode ?? '')) return { task: view(r), changed: false, previous: null };
      const previous = structuredClone({ backend: r.backend, model: r.model, effort: r.effort, mode: r.mode, routing: r.routing ?? null });
      await commit(r.taskId, row => {
        if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
        const from = row.routing?.changed?.from ?? { backend: row.backend ?? null, model: row.model ?? null, effort: row.effort ?? null };
        const target = row.routing?.target ?? {};
        const sameAccount = backend === target.backend && (account ?? null) === (target.account ?? null);
        row.routing = { ...(row.routing ?? { mode: 'pinned', kind: null }),
          target: { backend, model, account: account ?? null, ...(sameAccount && target.accountLabel ? { accountLabel: target.accountLabel } : {}) } };
        if (same(from, { backend, model, effort })) delete row.routing.changed;
        else row.routing.changed = { by: 'parent', at: new Date().toISOString(), from, count: (previous.routing?.changed?.count ?? 0) + 1 };
        // 選んだ時点の使用率は前の委譲先のものなので外す
        if (backend !== target.backend || model !== target.model) { delete row.routing.targetWindows; delete row.routing.selectedWithLowHeadroom; }
        row.backend = backend; row.model = model; row.effort = effort;
        if (mode) row.mode = mode;
      }, 'retarget', locale);
      return { task: view(r), changed: true, previous };
    },
    /** retarget を書いた後に失敗した（指示を積めなかった）。書く前の値に戻す。保存に失敗しても投げない（メモリが正しく、後で追いつく） */
    async untarget(taskId, previous) {
      if (!records[taskId] || !previous) return;
      await record(taskId, row => {
        for (const k of ['backend', 'model', 'effort', 'mode']) { if (previous[k] === undefined) delete row[k]; else row[k] = previous[k]; }
        if (previous.routing) row.routing = previous.routing; else delete row.routing;
      }, 'untarget');
    },
    /**
     * 子のターンが始まった。子が実際に走る backend・model・effort・mode にタスクの記録を合わせる（人が子の予約を取り消した・替えたときの食い違いを残さない）。
     * 依頼元が替えた委譲（routing.changed）なら routing.target も合わせる。同じなら書かない。書いたらタスクの id を返す
     */
    async sync(sessionId, { backend, model, effort, mode }) {
      const r = bySession.get(sessionId);
      if (!r || ((r.backend ?? null) === backend && (r.model ?? '') === (model ?? '') && (r.effort ?? '') === (effort ?? '') && (r.mode ?? '') === (mode ?? ''))) return null;
      await record(r.taskId, row => {
        row.backend = backend; row.model = model; row.effort = effort; row.mode = mode;
        if (row.routing?.changed && row.routing.target) row.routing.target = { ...row.routing.target, backend, model };
      }, 'sync');
      return r.taskId;
    },
    instructions(taskId) { const r = records[taskId]; return r ? { taskId, revision: r.instructionRevision ?? 0, instructions: structuredClone(r.instructions) } : null; },
    /** 最初の依頼（task と context）。やり直しで同じ依頼を渡す。context を持つ前に作ったタスクは task だけ */
    request(taskId) { const r = records[taskId]; return r ? { task: r.task, title: r.title ?? null, context: r.context ?? null } : null; },
    /**
     * ホストに任せたタスクの写しの行を足す（docs/agent-delegation.md「リモートのホストへ任せる」）。ホストが正本で、走らせるのはホスト。
     * row は { taskId（ホストのもの）, parentSessionId（依頼元の会話）, host: { hostId, name }, … }。同じ taskId が既にあれば何もしない。保存できなければ断る
     */
    async adopt(row, locale) {
      return serial(async () => {
        if (closed) throw new Error(agentT(locale, 'tasks.halted'));
        // ホストの便りの taskId は信じ切らない: 形を確かめ、手元のタスクと同じ ID は受けない（既にある行を返さない）
        if (typeof row.taskId !== 'string' || !TASK_ID.test(row.taskId) || records[row.taskId]) throw new Error(agentT(locale, 'tasks.remoteBadTaskId'));
        const parent = Object.values(records).find(r => r.sessionId === row.parentSessionId);
        const full = { manager: 'remote', depth: (parent?.depth ?? 0) + 1, createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
          result: '', error: null, instructions: [], instructionRevision: 0, queue: [], sessionId: null, ...row };
        // 最初から終わっている（すぐ終わった・すぐ失敗した）依頼は、結果を ply_delegate の戻りで渡すので、完了通知は送らない
        if (!ACTIVE.has(full.status)) full.notification = 'read';
        records[full.taskId] = full;
        try { await write([full.taskId]); } catch (e) { delete records[full.taskId]; failed(e, 'adopt', full.taskId); throw refused(locale); }
        touched();
        return view(full);
      });
    },
    /**
     * ホストの便り（task）で、写しの行を更新する。ホストが正本なので、来た値をそのまま写す。終わった状態になったら、手元の委譲と同じに
     * 完了通知の対象にする（止めたもの suppressed・受け取り済み read はそのまま）。再開（動いている状態に戻る）なら通知をやり直す。変わらなければ書かない
     * 保存できなくても投げない（メモリが正しく、後で追いつく）。戻りは view（行が無い・写しでなければ null）
     */
    async mirror(taskId, patch) {
      const r = records[taskId];
      if (!r?.host) return null;
      return serial(async () => {
        const before = JSON.stringify(r);
        // 追えなくなっていた（hostLost）行にホストの便りが戻ったら、ホストの状態に戻し、完了通知もやり直す
        if (r.hostLost && patch.hostLost == null) r.notification = 'none';
        const was = r.status;
        // 止める予定（cancelPending）の間は、ホストの動いている状態の便り（running・waiting）で止めた状態を戻さない。終わった状態の便りは写し、予定を外す
        const keep = r.cancelPending === true && 'status' in patch && ACTIVE.has(patch.status) && !('cancelPending' in patch);
        for (const k of MIRROR_FIELDS) if (k in patch) {
          if (keep && ['status', 'hostWaiting', 'error'].includes(k)) continue;
          if (patch[k] == null) delete r[k]; else r[k] = patch[k];
        }
        if (r.cancelPending === true && !ACTIVE.has(r.status) && patch.status && !ACTIVE.has(patch.status)) delete r.cancelPending;
        if (patch.hostLost == null) delete r.hostLost;
        const wasActive = ACTIVE.has(was), isActive = ACTIVE.has(r.status);
        if (!isActive && (wasActive || r.notification === 'none')) r.notification = r.status === 'cancelled' ? 'suppressed' : r.notification === 'read' ? 'read' : 'pending';
        else if (isActive && !wasActive) r.notification = 'none';
        if (JSON.stringify(r) !== before) { r.updatedAt = Date.now(); await persist('mirror', taskId); touched(); }
        return view(r);
      });
    },
    /** 依頼元が結果を受け取った（ホストのタスクの ply_task_status・ply_task_wait の戻り）。完了通知を送らない */
    async markRead(taskId) { const r = records[taskId]; if (r) await markRead(r); },
    // locale は呼び出した会話（owner）の言語。子の会話も同じ言語を継ぐので、子への依頼文もこれで作る
    async call(owner, name, args = {}, signal, locale) {
      if (closed || signal?.aborted) throw new Error(agentT(locale, 'tasks.halted'));
      if (name === 'ply_delegate') {
        text(locale, args.backend, 'backend', 40); text(locale, args.task, 'task');
        if (args.context !== undefined) text(locale, args.context, 'context');
        if (args.isolate !== undefined && typeof args.isolate !== 'boolean') throw new Error(agentT(locale, 'tasks.isolateInvalid'));
        if (args.title !== undefined && typeof args.title !== 'string') throw new Error(agentT(locale, 'tasks.textLength', { name: 'title', max: 40 }));
        args = { ...args, title: taskTitle(args.title, args.task) };
        const row = await serial(async () => {
          // 保存できない間は新しい仕事を受けない。子の会話を作る前に、書けるかを確かめる
          if (fault) { try { await write([]); touched(); } catch (e) { failed(e, 'delegate'); throw refused(locale); } }
          // 同時の件数・1 会話の件数・深さに上限は置かない（2026-09-27 に廃止。depth は記録だけ残す）
          const parent = Object.values(records).find(r => r.sessionId === owner);
          const depth = (parent?.depth ?? 0) + 1;
          // 端末の AI から任された作業（args.remote は口の本体だけが付ける）と、その子孫は、深さに上限を効かせる
          const remoteOrigin = Boolean(args.remote || parent?.remoteOrigin);
          if (remoteOrigin && depth > REMOTE_DEPTH_MAX) throw new Error(agentT(locale, 'tasks.remoteDepth', { max: REMOTE_DEPTH_MAX }));
          const taskId = `ply-task-${crypto.randomUUID()}`;
          const prepared = await prepare(owner, args, taskId, signal);
          try {
          if (signal?.aborted) throw new Error(agentT(locale, 'tasks.aborted'));
          const row = { ...prepared, taskId, parentSessionId: owner, manager: 'ply', depth, ...(remoteOrigin ? { remoteOrigin: true } : {}), task: args.task, title: args.title, ...(args.context !== undefined ? { context: args.context } : {}),
            createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
            result: '', error: null, instructions: [], instructionRevision: 0,
            queue: [(args.context ? agentT(locale, 'tasks.withContext', { task: args.task, context: args.context }) : args.task)
              + (prepared.worktree ? agentT(locale, 'tasks.worktreeInstruction', { path: prepared.worktree.path, branch: prepared.worktree.branch, origin: prepared.worktree.origin }) : '')] };
          records[taskId] = row; bySession.set(row.sessionId, row);
          try { await write([taskId]); } catch (e) { failed(e, 'delegate', taskId); throw refused(locale); }
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
        const out = { ...shown(r, offset), ...(r.git ? { gitSummary: gitLine(locale, r.git) } : {}), ...(await workspaceOf(r, locale)), ...storage(locale) };
        await markRead(r);
        return out;
      }
      if (name === 'ply_task_wait') {
        const seconds = args.seconds ?? 30;
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error(agentT(locale, 'tasks.secondsInvalid'));
        // 人間の承認待ちになったら待たずに戻る。待つ相手が人間に変わったことを依頼元へ早く伝える
        const pending = () => ACTIVE.has(r.status) && !waitingOf(r);
        // 待っている間に終わったら、結果はこの戻り値で渡す。同じ結果の完了通知を走っているターンへ重ねないよう、待ちの間は通知を控える
        waited.set(r.taskId, (waited.get(r.taskId) ?? 0) + 1);
        try {
          if (pending()) await new Promise(resolve => {
            const done = () => { clearTimeout(timeout); listeners.delete(check); signal?.removeEventListener('abort', done); resolve(); };
            const check = () => { if (!pending()) done(); };
            const timeout = setTimeout(done, seconds * 1000); listeners.add(check); signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
          });
          const out = { ...shown(r), ...(r.git ? { gitSummary: gitLine(locale, r.git) } : {}), ...(await workspaceOf(r, locale)), ...storage(locale) };
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
        const steered = await steerInstructions(r).catch(e => { report({ event: 'unexpected', operation: 'steer', taskId: r.taskId, code: e?.code ?? null }); });
        kick();
        // 渡ったか分からない指示は送り直さない。依頼元のエージェントには、確かめるよう一言添える
        return steered?.has(instructionId) ? { ...view(r), warning: agentT(locale, 'tasks.steerUnknown') } : view(r);
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
      if (r.host && stopping) await stopHost(r);
      if (!live.has(taskId) && r.activeCommands?.length) await cancelBackground(view(r));
      return stopping && was !== 'cancelling' ? { taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: was } : null;
    },
    // 承認待ちの増減で ply_task_wait を起こす。保存する状態は変わらないので write() は通らない
    wake() { for (const r of Object.values(records)) pauseCommands(r, now(), waitingOf(r)); for (const fn of [...listeners]) fn(); },
    // 会話を止めたときに、その会話が作ったタスク（と子孫）をまとめて止める。cancel と同じ書き換えを、
    // 書き換えて何かが変わるものにだけ行い、保存は 1 回にする。以前は終わったタスクまで 1 件ずつ保存していて
    // （1 会話で数十件になる）、会話の停止を遅らせていた。止め終わって通知も抑えたもの（cancel を呼んでも
    // revision と updatedAt しか変わらない）は飛ばす。子孫は親を飛ばしても辿る。
    // 中断した会話を勝手に再開しないので、終わっていて完了通知が届いていない（none / pending）タスクの通知も止める。
    // その結果は捨てずに返す（unread: true。ply_task_status で読める）。走っていた・待っていたタスクは止めた時点の状態で返す。
    // 返すのは [{ taskId, parentSessionId, title, status, unread }]。server が依頼元の会話ごとに「止めたもの」に残し、
    // 次のターンでエージェントへ伝える（docs/design.md「中断と再開」）
    // since（ミリ秒）を渡すと、その時刻以後に作ったタスクだけを対象にする（巻き戻しで消える範囲で生まれた子。core/server.mjs の rewindConversation）
    async cancelOwner(owner, { since } = {}) {
      const targets = [], seen = new Set();
      const visit = r => {
        if (seen.has(r.taskId)) return;
        seen.add(r.taskId);
        for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) visit(child);
        targets.push(r);
      };
      for (const r of Object.values(records).filter(r => (!owner || r.parentSessionId === owner) && (!Number.isFinite(since) || r.createdAt >= since))) visit(r);
      const settled = r => !ACTIVE.has(r.status) && !r.queue.length && r.notification === 'suppressed' && !live.has(r.taskId);
      const change = targets.filter(r => !settled(r));
      if (!change.length) return [];
      const stopped = [], hostStops = [];
      // cancel と同じく、保存できなくても止める
      await serial(async () => {
        for (const r of change) {
          const running = (ACTIVE.has(r.status) || live.has(r.taskId) || r.queue.length > 0) && r.status !== 'cancelling';
          if (r.host && running) hostStops.push(r);
          if (running || readable(r)) stopped.push({ taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status, unread: !running });
          r.revision = (r.revision ?? 0) + 1; dropInstructions(r); r.notification = 'suppressed';
          if (ACTIVE.has(r.status)) r.status = live.has(r.taskId) ? 'cancelling' : 'cancelled';
          r.updatedAt = Date.now();
        }
        await persist('cancelOwner', change.map(r => r.taskId));
        touched();
      });
      for (const r of change) live.get(r.taskId)?.abort();
      // ホストの子を止める依頼は並列に・短い待ちで（応答しないホストの分だけ中断を遅らせない）
      await Promise.all(hostStops.map(stopHost));
      return stopped;
    },
    /** 再起動で止まった（interrupted にした）タスク。[{ taskId, parentSessionId, title, status }]（status は止まる前の状態） */
    get restored() { return structuredClone(restored); },
    /** 保存障害（無ければ null）。errno・操作・タスク ID・時刻だけ */
    get fault() { return fault && { code: fault.code, syscall: fault.syscall, operation: fault.operation, taskId: fault.taskId, since: fault.since, at: fault.at, failures: fault.failures }; },
    // 正常終了。保存障害では閉じない。返す Promise は、閉じる前に始まった実行・通知・保存が書き終えると解ける
    // （閉じた後も、走っていた分の保存は続く。データ置き場を消す前に待つ）
    async close() {
      closed = true; clearInterval(timer); for (const ac of live.values()) ac.abort();
      await Promise.allSettled([...instructionSends.values()]);
      while (background.size) await Promise.all([...background]);
      await writes;
      handle?.release(); handle = null;
    },
  };
}
