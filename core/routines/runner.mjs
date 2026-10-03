// ルーティンの 1 回の実行（R1。ADR 0111）。発火ごとにチャンネルへ根の投稿（author.kind: 'routine'）を立て、bot のそのスレッドの会話
// （sidecar bot.kind: 'routine'・モードはルーティンの mode）で走らせる。実行の履歴 = スレッドの並び。
//
//   createRunner({ channels, bots, dispatch, host, clock, record, agentT?, locale? }) → Runner
//     channels … ChannelService・bots … BotService・dispatch … Dispatcher（wake で bot を起こす）・host … createBotHost の道具
//     clock    … core/routines/clock.mjs の { now, setTimer, clearTimer }
//     record(routineId, patch) … Routine.last への書き込み（service が保存して routinesChanged を出す）。patch = { at?, runId, state, postId? }。
//                                at を持つものは新しい実行の始まり、持たないものは runId が last と同じときだけの更新
//
//   Runner:
//     run(routine, { source, missed?, note? }) → Promise<{ runId, postId, state: 'working'|'skipped', reason? }>
//                 … 根の投稿を立てて bot を起こしたところまで（走り終えるのは待たない）。source: 'schedule' | 'missed' | 'event' | 'manual' | 'webhook'。
//                   すでに同じルーティンの実行が走っていれば「スキップ（previousRunning）」。bot が居なければ「スキップ（botMissing）」
//     dryRun(routine) → Promise<{ runId, sessionId, mode, state, summary? }>
//                 … 使い捨ての会話を計画（読み取り）のモードで走らせ、**走り終えるまで待って**結果を返す（チャンネルへは投稿しない）。state は done・failed・stopped、
//                   上限（DRY_RUN_WAIT_MS）までに終わらなければ working。summary は返事の最初の 1 行（失敗なら理由）。承認待ちには期限（approvalTimeoutMin。ただし DRY_RUN_APPROVAL_MAX_MIN 分まで）が付く。
//                   計画のモードを持たないバックエンドは RunnerError('NO_READONLY_MODE')
//     isRunning(routineId) → boolean
//     onTurnEnd(turn, { outcome, interrupted }): Promise<void>   … 実行の会話のターンが終わった → 根の投稿の状態を決める（done・checking・failed・stopped）
//     onPermission(card, phase): void                            … 実行の会話の承認待ちに期限を付ける（approvalTimeoutMin。過ぎたらターンを止めて報告）
//     settleLost(routine): Promise<void>                         … 起動時: Pleiad が止まって終わりを記録できなかった実行の根の投稿を stopped にする
//     stop(): void
//
// 状態: done（終了）・checking（bot が channels.post に state: 'checking' を付けた。要確認）・failed・stopped（人が止めた・更新・終了）・skipped（理由）。緑の「成功」とは出さない。
import { agentT as defaultAgentT } from '../i18n.mjs';
import { newId } from '../channels/types.mjs';

/** bot を起こしてからターンが走り始めるのを待つ上限（ms）。過ぎても走っていなければ失敗にする（始められなかったとき、根の投稿を「作業中」のまま残さない） */
export const START_GRACE_MS = 60_000;
/** 試しの実行（dryRun）が走り終えるのを待つ上限（ms）。過ぎたら state: 'working' で返す（会話はそのまま走り続ける） */
export const DRY_RUN_WAIT_MS = 10 * 60_000;
/** 試しの実行の承認待ちの期限（分）の上限。画面の前で待っている人のための実行なので、本番の期限（既定 30 分）より短く取り消す */
export const DRY_RUN_APPROVAL_MAX_MIN = 5;

export class RunnerError extends Error {
  constructor(code, detail) { super(detail ?? code); this.name = 'RunnerError'; this.code = code; this.detail = detail ?? code; }
}

const log = (...a) => console.error('  routines:', ...a);
const errText = (e) => String(e?.message ?? e);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const routineAuthor = (routine) => ({ kind: 'routine', routineId: routine.id });
const newRunId = (now) => `run_${Math.floor(now).toString(36)}${newId('post', now).slice(-6)}`;

export function createRunner({ channels, bots, dispatch, host, clock, record, agentT = defaultAgentT } = {}) {
  const running = new Map();     // routineId → 実行の記録（始まりから終わりまで。始まる前の確保も含む）
  const bySession = new Map();   // 会話の id → 実行の記録
  let closed = false;
  const locale = () => host?.currentLocale?.() ?? 'ja';

  const textOf = (routine, note) => `${routine.name}\n${routine.prompt}${note ? `\n\n${note}` : ''}`;
  const systemPost = (channelId, threadId, text) => channels.post({ channelId, threadId, text }, { kind: 'system' }).catch((e) => log('could not write a system post:', errText(e)));

  async function modeFor(routine, bot) {
    const modes = host.getBackend?.(bot.backend)?.modes?.() ?? {};
    if (modes[routine.mode]) return routine.mode;
    return modes[bot.mode] ? bot.mode : null;
  }

  async function skipped(routine, channel, { runId, reason, missed, note }, { recordLast }) {
    let postId = null;
    if (channel && !channel.archivedAt) {
      const post = await channels.post({
        channelId: channel.id, threadId: null, text: textOf(routine, note), state: 'skipped',
        routine: { routineId: routine.id, runId, ...(missed ? { missed: true } : {}), reason },
      }, routineAuthor(routine)).catch((e) => { log(`could not write the skipped run of ${routine.name}:`, errText(e)); return null; });
      postId = post?.id ?? null;
    }
    if (recordLast) await record(routine.id, { at: clock.now(), runId, state: 'skipped', ...(postId ? { postId } : {}) });
    return { runId, postId, state: 'skipped', reason };
  }

  async function run(routine, { source = 'manual', missed = false, note = '' } = {}) {
    if (closed) throw new RunnerError('CLOSED', 'the routine runner is stopped');
    const runId = newRunId(clock.now());
    const channel = await channels.get({ channelId: routine.channelId }).catch(() => null);
    const prev = running.get(routine.id);
    if (prev) {
      // 走っている間の発火は、1 つの走っている間に 1 回だけ「スキップ」を残す（毎分のルーティンが遅い実行を待つたびに並べない）
      if (prev.skipNoted) return { runId, postId: null, state: 'skipped', reason: 'previousRunning' };
      prev.skipNoted = true;
      return skipped(routine, channel, { runId, reason: 'previousRunning', missed, note }, { recordLast: false });
    }
    const entry = { routineId: routine.id, runId, postId: null, channelId: routine.channelId, botId: routine.botId, sessionId: null, startedAt: clock.now(),
      timeoutMin: routine.approvalTimeoutMin, timedOut: false, ended: false, skipNoted: false, timers: new Map(), startTimer: null };
    running.set(routine.id, entry);     // 確保。以降の await の間に同じルーティンが重ならない
    try {
      const bot = await bots.get({ botId: routine.botId }).catch(() => null);
      if (!bot) { running.delete(routine.id); return await skipped(routine, channel, { runId, reason: 'botMissing', missed, note }, { recordLast: true }); }
      if (!channel || channel.archivedAt) { running.delete(routine.id); return await skipped(routine, channel, { runId, reason: channel ? 'channelArchived' : 'channelMissing', missed, note }, { recordLast: true }); }

      const root = await channels.post({
        channelId: channel.id, threadId: null, text: textOf(routine, note), state: 'working',
        routine: { routineId: routine.id, runId, ...(missed ? { missed: true } : {}) },
      }, routineAuthor(routine));
      entry.postId = root.id;
      await record(routine.id, { at: clock.now(), runId, state: 'working', postId: root.id });
      try {
        const made = await bots.createSession({ botId: bot.id, channel, threadId: root.id, kind: 'routine', routineId: routine.id, rootText: routine.name });
        entry.sessionId = made.sessionId;
        const mode = await modeFor(routine, bot);
        if (mode && mode !== made.mode) await host.store.setMode(made.sessionId, mode);
        bySession.set(made.sessionId, entry);
        // dispatch の sessionFor は、ThreadState.sessions に登録済みの会話をそのまま使う（kind: 'routine' のまま）
        await channels.threads.update(channel.id, root.id, { sessions: { [bot.id]: made.sessionId } });
        await dispatch.wake({ botId: bot.id, channel, threadId: root.id, post: root });
        if (!entry.ended) {
          entry.startTimer = clock.setTimer(() => { entry.startTimer = null; started(entry).catch((e) => log('start check failed:', errText(e))); }, START_GRACE_MS);
        }
      } catch (e) {
        log(`could not start ${routine.name}:`, errText(e));
        await systemPost(channel.id, root.id, agentT(locale(), 'channel.turn.failed', { error: errText(e) }));
        await finish(entry, 'failed');
      }
      return { runId, postId: root.id, state: 'working' };
    } catch (e) {
      if (running.get(routine.id) === entry) running.delete(routine.id);
      throw e;
    }
  }

  /** bot を起こしたのにターンが走り始めなかった（始められなかった）なら、失敗で終える */
  async function started(entry) {
    if (entry.ended || closed) return;
    if (host.runtime?.turns?.has?.(entry.sessionId)) return;
    log(`the turn of ${entry.routineId} did not start`);
    await finish(entry, 'failed');
  }

  const clearTimers = (entry) => {
    for (const handle of entry.timers.values()) clock.clearTimer(handle);
    entry.timers.clear();
    if (entry.startTimer) { clock.clearTimer(entry.startTimer); entry.startTimer = null; }
  };

  async function hasChecking(entry) {
    try {
      const { posts } = await channels.read({ channelId: entry.channelId, threadId: entry.postId, limit: 100 });
      return posts.some((p) => !p.deletedAt && p.id !== entry.postId && p.state === 'checking');
    } catch { return false; }
  }

  /** 根の投稿の状態を決めて実行を終える。state が null のときは bot の返事から決める（ok = done か checking） */
  async function finish(entry, state) {
    if (entry.ended) return;
    entry.ended = true;
    clearTimers(entry);
    if (running.get(entry.routineId) === entry) running.delete(entry.routineId);
    if (entry.sessionId && bySession.get(entry.sessionId) === entry) bySession.delete(entry.sessionId);
    const final = state === 'done' && (await hasChecking(entry)) ? 'checking' : state;
    if (entry.postId) await channels.edit({ channelId: entry.channelId, postId: entry.postId, state: final }, { kind: 'routine', routineId: entry.routineId }).catch((e) => log('could not write the run state:', errText(e)));
    await record(entry.routineId, { runId: entry.runId, state: final });
  }

  async function onTurnEnd(turn, { outcome, interrupted } = {}) {
    const sessionId = turn?.info?.sessionId;
    if (!sessionId) return;
    const entry = bySession.get(sessionId);
    if (!entry || entry.ended) return;
    if (entry.dry) return;       // 試しの実行は dryRun が runTurn の返りで終える（根の投稿も last も無い）
    let state;
    // 承認の期限で止めたものは、バックエンドが拒否を受けて ok で終えても「終了」と見せない
    if (entry.timedOut || interrupted?.reason === 'timeout') state = 'failed';
    else if (outcome === 'ok') state = 'done';
    else if (interrupted && interrupted.reason !== 'limit') state = 'stopped';
    else state = 'failed';
    await finish(entry, state);
  }

  function onPermission(card, phase) {
    const entry = card?.sessionId ? bySession.get(card.sessionId) : null;
    if (!entry || entry.ended || closed) return;
    if (phase === 'settled') {
      const handle = entry.timers.get(card.id);
      if (handle !== undefined) { clock.clearTimer(handle); entry.timers.delete(card.id); }
      return;
    }
    if (entry.timers.has(card.id)) return;
    entry.timers.set(card.id, clock.setTimer(() => { entry.timers.delete(card.id); expire(entry).catch((e) => log('could not cancel an unanswered approval:', errText(e))); }, entry.timeoutMin * 60_000));
  }

  /** 承認が期限までに無かった: スレッドに報告して、ターンを止める（理由 timeout） */
  async function expire(entry) {
    if (entry.ended || closed || entry.timedOut) return;
    entry.timedOut = true;
    if (entry.postId) await systemPost(entry.channelId, entry.postId, agentT(locale(), 'routine.approvalTimeout'));
    await host.abortSessions?.({ sessionId: entry.sessionId, reason: 'timeout' });
  }

  async function dryRun(routine) {
    if (closed) throw new RunnerError('CLOSED', 'the routine runner is stopped');
    const bot = await bots.get({ botId: routine.botId }).catch(() => null);
    if (!bot) throw new RunnerError('BOT_NOT_FOUND', routine.botId);
    const modes = host.getBackend?.(bot.backend)?.modes?.() ?? {};
    const plan = modes.plan?.scope === 'readonly' ? 'plan' : Object.entries(modes).find(([, m]) => m?.scope === 'readonly' || m?.scope === 'none')?.[0];
    if (!plan) throw new RunnerError('NO_READONLY_MODE', `${bot.backend} has no read-only (plan) approval mode, so a dry run cannot be made safely`);
    const channel = await channels.get({ channelId: routine.channelId }).catch(() => null);
    const made = await bots.createSession({ botId: bot.id, channel, threadId: null, kind: 'routine', routineId: routine.id, rootText: agentT(locale(), 'routine.dryRunTitle', { name: routine.name }) });
    await host.store.setMode(made.sessionId, plan);
    const runId = newRunId(clock.now());
    // 本番の実行と同じ記録で承認待ちの期限を付ける（期限は本番より短い。running には入れない: 本番の実行を止めない）
    const entry = { routineId: routine.id, runId, postId: null, channelId: routine.channelId, botId: bot.id, sessionId: made.sessionId, startedAt: clock.now(),
      timeoutMin: Math.min(routine.approvalTimeoutMin, DRY_RUN_APPROVAL_MAX_MIN), timedOut: false, ended: false, skipNoted: false, timers: new Map(), startTimer: null, dry: true };
    bySession.set(made.sessionId, entry);
    const prompt = [agentT(locale(), 'routine.dryRunNote'), routine.prompt].join('\n\n');
    // 走り終えるまで待つ（画面の［試しに動かす］は結果を足に出す）。上限を過ぎたら working のまま返す
    const result = await new Promise((resolve) => {
      const cap = clock.setTimer(() => resolve({ capped: true }), DRY_RUN_WAIT_MS);
      Promise.resolve(host.runTurn({ sessionId: made.sessionId, prompt }, () => {}, { internal: true }))
        .then((outcome) => resolve({ outcome }), (error) => resolve({ error }))
        .finally(() => clock.clearTimer(cap));
    });
    if (result.capped) return { runId, sessionId: made.sessionId, mode: plan, state: 'working', summary: agentT(locale(), 'routine.dryRunStillRunning') };
    entry.ended = true;
    clearTimers(entry);
    if (bySession.get(made.sessionId) === entry) bySession.delete(made.sessionId);
    let state, summary;
    if (entry.timedOut) { state = 'failed'; summary = agentT(locale(), 'routine.approvalTimeout'); }
    else if (result.error) { state = 'failed'; summary = errText(result.error); }
    else if (result.outcome === 'ok') { state = 'done'; summary = await firstLine(made.sessionId); }
    else if (result.outcome === 'aborted') state = 'stopped';
    else state = 'failed';
    if (state === 'failed' && !summary && result.outcome && result.outcome !== 'error') summary = String(result.outcome);
    return { runId, sessionId: made.sessionId, mode: plan, state, ...(summary ? { summary } : {}) };
  }

  /** 返事の最初の（空でない）1 行。読めなければ null */
  async function firstLine(sessionId) {
    try {
      const reply = await host.lastReply?.(sessionId);
      const line = typeof reply === 'string' ? reply.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : null;
      return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : null;
    } catch { return null; }
  }

  async function settleLost(routine) {
    const last = routine.last;
    if (!last || last.state !== 'working' || running.has(routine.id)) return;
    if (last.postId) {
      const post = await channels.getPost({ channelId: routine.channelId, postId: last.postId }).catch(() => null);
      if (post && !post.deletedAt && (post.state === 'working' || post.state === 'waiting')) {
        await channels.edit({ channelId: routine.channelId, postId: post.id, state: 'stopped' }, routineAuthor(routine)).catch((e) => log('could not settle a lost run:', errText(e)));
      }
    }
    await record(routine.id, { runId: last.runId, state: 'stopped' });
  }

  return {
    run, dryRun, onTurnEnd, onPermission, settleLost,
    isRunning: (routineId) => running.has(routineId),
    open() { closed = false; },
    stop() {
      closed = true;
      for (const entry of running.values()) clearTimers(entry);
    },
  };
}
