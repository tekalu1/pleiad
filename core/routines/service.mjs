// ルーティン（P2 の R1。ADR 0112）。core/ops/routines.mjs の handler は `ctx.routines` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の Routine。式・次の発火・イベントの選び方・1 回の実行は core/routines/{cron,schedule,events,runner}.mjs、保存は store.mjs（<data>/routines.json）。
//
// createRoutineService({ dataDir, channels, bots, dispatch, host, emit, now, clock }) → RoutineService
//   emit  … routinesChanged（{ routine? , removed? }）を出す
//   clock … { now, setTimer, clearTimer }（既定は core/routines/clock.mjs。テストは tests/lib/routines-clock-loader.mjs で差し替える）。now を渡すと時刻だけ差し替わる
//
// RoutineService（author は types.mjs の Author）:
//   start(): Promise<void>                … 保存を読み、Pleiad が止まって終わりを記録できなかった実行を stopped にし、有効なルーティンを予約する。
//                                           最後に動いた後で今より前の予定があれば、最新の 1 回だけ走らせる（根の投稿に routine.missed）
//   stop(): void
//   list(): Promise<(Routine & { nextAt: number|null })[]>・get({ routineId }): Promise<(Routine & { nextAt })|null>
//   create(input, author) / update({ routineId, ...patch }, author) / pause / resume / remove({ routineId }, author)
//   planUpdate(input): Promise<{ routine, next, loosens, reasons, rows }>   … update の検査と、承認カードに出す前後。riskOf・confirm・update が同じ結果を使う
//   planCreate(input): Promise<{ mode, label, loosens }>                    … create が作るルーティンのモードと、弱くないか（承認カードに出す）
//   run({ routineId, dryRun? }, author): Promise<{ postId: string|null, runId: string, ... }>   … 一時停止中でも手では走らせられる。dryRun は使い捨ての会話を計画のモードで走らせ、走り終えるまで待って
//                                         { postId: null, runId, sessionId, mode, state, summary?, dryRun: true } を返す（投稿しない）
//   fire(routineId, { source, note? }): Promise<...>                         … 外から起こす入口（webhook が使う）
//   rotateSecret({ routineId }): Promise<{ secret }>                         … 秘密を作り直して一度だけ返す（人の画面だけ）
//   onPermission(card, phase) / onSessionDone(sessionId, outcome) / onTurnEnd(turn, end)   … bots-host のつなぎ目から
//
// 予約: ルーティンごとにタイマー 1 本。発火の時刻は baselineOf（作った・再開した・トリガを変えた・前に動いた時刻のうち、いちばん後ろ）から nextFireAt で決める。
// 発火のたびに armedAt を今にして次を予約してから走らせる（走るのが遅くても次の予約が遅れない）。
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecretStore, defaultCipher } from '../secret-store.mjs';
import { agentT } from '../i18n.mjs';
import { newId } from '../channels/types.mjs';
import { strongerMode, looserThanDefault } from '../bots/approval.mjs';
import { clock as defaultClock } from './clock.mjs';
import { createRoutineStore, RoutineStoreError, nameProblem, promptProblem, timeoutProblem, APPROVAL_TIMEOUT_DEFAULT_MIN } from './store.mjs';
import { validateTrigger, TriggerError, isTimed, nextFireAt, firesPerWeek } from './schedule.mjs';
import { eventOfOutcome, fromBotSide, matchingRoutines } from './events.mjs';
import { createRunner, RunnerError } from './runner.mjs';

// i18n-dynamic: agent:routine.event.
const MAX_TIMER_MS = 2 ** 31 - 1;
const log = (...a) => console.error('  routines:', ...a);
const errText = (e) => String(e?.message ?? e);

/** code: INVALID（params.detail に理由）・ROUTINE_NOT_FOUND・BOT_NOT_FOUND・CHANNEL_NOT_FOUND・CHANNEL_ARCHIVED。ops が OpError にする（辞書 agent:ops.errors.<code>） */
export class RoutineError extends Error {
  constructor(code, params = {}, message) {
    super(message ?? `${code} ${JSON.stringify(params)}`);
    this.name = 'RoutineError';
    this.code = code;
    this.params = params;
  }
}
const invalid = (detail) => new RoutineError('INVALID', { detail }, `INVALID ${detail}`);

/** トリガの 1 行の言い方（承認カード・記録用。言語を持たない短い印） */
export function describeTrigger(trigger) {
  switch (trigger?.kind) {
    case 'daily': return `daily ${trigger.at}${trigger.weekdaysOnly ? ' weekdays' : ''}`;
    case 'weekly': return `weekly ${trigger.days.join(',')} ${trigger.at}`;
    case 'interval': return `every ${trigger.minutes} min${trigger.window ? ` ${trigger.window.from}-${trigger.window.to}` : ''}`;
    case 'cron': return `cron ${trigger.expr}`;
    case 'event': return `on ${trigger.on} (${trigger.scope === 'all' ? 'all conversations' : `${trigger.scope.sessionIds.length} conversation(s)`})`;
    case 'webhook': return 'webhook';
    default: return String(trigger?.kind ?? '');
  }
}

const clip = (s, n = 80) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };

export function createRoutineService({ dataDir, channels, bots, dispatch, host, emit = () => {}, now, clock } = {}) {
  const clk = clock ?? (now ? { ...defaultClock, now } : defaultClock);
  const store = createRoutineStore({ file: path.join(dataDir ?? '', 'routines.json') });
  const secrets = createSecretStore({ file: path.join(dataDir ?? '', 'webhook-secrets.json'), cipher: defaultCipher() });
  const timers = new Map();       // routineId → { handle, at }
  let closed = true;
  const locale = () => host?.currentLocale?.() ?? 'ja';

  const baselineOf = (r) => Math.max(r.armedAt ?? r.createdAt ?? 0, r.last?.at ?? 0);
  const withNext = (r) => ({ ...r, nextAt: r.paused || !isTimed(r.trigger) ? null : nextFireAt(r.trigger, baselineOf(r)) });
  const send = (event) => { try { emit(event); } catch (e) { log('emit failed:', errText(e)); } };
  const changed = (r) => send({ type: 'routinesChanged', routine: withNext(r) });

  /** ストアの失敗を ops が扱える RoutineError にする */
  const wrap = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof RoutineStoreError && e.code === 'ROUTINE_NOT_FOUND') throw new RoutineError('ROUTINE_NOT_FOUND', { id: e.id ?? '' });
      throw e;
    }
  };
  const need = (routineId) => {
    const r = typeof routineId === 'string' ? store.get(routineId) : null;
    if (!r) throw new RoutineError('ROUTINE_NOT_FOUND', { id: String(routineId) });
    return r;
  };

  async function needBot(botId) {
    const bot = typeof botId === 'string' && botId ? await bots.get({ botId }).catch(() => null) : null;
    if (!bot) throw new RoutineError('BOT_NOT_FOUND', { id: String(botId) });
    return bot;
  }
  async function needChannel(channelId) {
    const channel = typeof channelId === 'string' && channelId ? await channels.get({ channelId }).catch(() => null) : null;
    if (!channel) throw new RoutineError('CHANNEL_NOT_FOUND', { id: String(channelId) });
    if (channel.archivedAt) throw new RoutineError('CHANNEL_ARCHIVED', { id: channel.id });
    if (channel.kind !== 'channel') throw invalid('channelId: a routine posts to a channel, not to a DM');
    return channel;
  }
  /** bot の backend が持つ承認モードの表（modes() の宣言）。引けなければ null */
  const modesOf = (bot) => host?.getBackend?.(bot.backend)?.modes?.() ?? bots.modesOf?.(bot.backend) ?? null;

  async function resolveMode(bot, mode) {
    const modes = modesOf(bot);
    if (mode === undefined || mode === null || mode === '') {
      const approval = await bots.approvalOf?.({ botId: bot.id });
      return approval?.mode ?? bot.mode ?? '';
    }
    if (modes && !modes[mode]) throw invalid(`mode: unknown for ${bot.backend}: ${mode}`);
    return String(mode);
  }

  // ------------------------------------------------------------ 実行

  /** Routine.last への書き込み（runner が呼ぶ） */
  async function record(routineId, patch) {
    try {
      const updated = await store.update(routineId, (r) => {
        if (patch.at !== undefined) return { ...r, last: { at: patch.at, runId: patch.runId, state: patch.state, ...(patch.postId ? { postId: patch.postId } : {}) } };
        if (r.last?.runId !== patch.runId) return null;
        return { ...r, last: { ...r.last, state: patch.state } };
      });
      changed(updated);
    } catch (e) {
      if (!(e instanceof RoutineStoreError && e.code === 'ROUTINE_NOT_FOUND')) log('could not record a run:', errText(e));
    }
  }

  const runner = createRunner({ channels, bots, dispatch, host, clock: clk, record, agentT });

  const eventNote = (on, title) => agentT(locale(), `routine.event.${on}`, { title: clip(title || '', 60) || agentT(locale(), 'routine.event.untitled') });

  // ------------------------------------------------------------ 予約

  function disarm(routineId) {
    const slot = timers.get(routineId);
    if (slot) { clk.clearTimer(slot.handle); timers.delete(routineId); }
  }

  function arm(routineId) {
    disarm(routineId);
    if (closed) return;
    const r = store.get(routineId);
    if (!r || r.paused || !isTimed(r.trigger)) return;
    const at = nextFireAt(r.trigger, baselineOf(r));
    if (at === null) return;
    const delay = Math.max(0, at - clk.now());
    const handle = clk.setTimer(() => { timers.delete(routineId); onTimer(routineId, at); }, Math.min(delay, MAX_TIMER_MS));
    timers.set(routineId, { handle, at });
  }

  function onTimer(routineId, at) {
    if (closed) return;
    const r = store.get(routineId);
    if (!r || r.paused || !isTimed(r.trigger)) return;
    if (clk.now() < at) { arm(routineId); return; }    // 長い待ちの途中・時計のずれ。もう一度予約する
    store.update(routineId, (cur) => ({ ...cur, armedAt: clk.now() }))
      .then((cur) => { arm(routineId); changed(cur); return runner.run(cur, { source: 'schedule' }); })
      .catch((e) => log(`could not run ${r.name}:`, errText(e)));
  }

  // ------------------------------------------------------------ 検査

  function checkTrigger(trigger) {
    try { return validateTrigger(trigger); }
    catch (e) { if (e instanceof TriggerError) throw invalid(`trigger: ${e.detail}`); throw e; }
  }

  /** 頻度を上げる・対象を広げる向きか。from → to のトリガ */
  function triggerLoosens(from, to) {
    const reasons = [];
    const before = isTimed(from) ? firesPerWeek(from) : Infinity;   // 出来事・webhook は回数に上限が無い
    const after = isTimed(to) ? firesPerWeek(to) : Infinity;
    if (after > before) reasons.push('frequency');
    if (from.kind === 'event' && to.kind === 'event') {
      const fromAll = from.scope === 'all', toAll = to.scope === 'all';
      if (!fromAll && (toAll || to.scope.sessionIds.some((id) => !from.scope.sessionIds.includes(id)))) reasons.push('scope');
    }
    return reasons;
  }

  async function planCreate(input = {}) {
    const bot = await needBot(input.botId);
    const mode = await resolveMode(bot, input.mode);
    const entry = modesOf(bot)?.[mode];
    return { mode, label: entry?.label ?? mode, loosens: entry ? looserThanDefault(entry) : false };
  }

  async function planUpdate(input) {
    const cur = need(input?.routineId);
    const next = { ...cur };
    const rows = [];
    const reasons = [];
    const change = (path_, before, after) => rows.push({ path: path_, before, after });
    if (input.name !== undefined && input.name.trim() !== cur.name) {
      const p = nameProblem(input.name); if (p) throw invalid(p);
      next.name = input.name.trim(); change('name', cur.name, next.name);
    }
    let bot = await bots.get({ botId: cur.botId }).catch(() => null);   // 消えた bot のルーティンも、名前などは直せる
    if (input.botId !== undefined && input.botId !== cur.botId) {
      bot = await needBot(input.botId);
      next.botId = bot.id; change('bot', cur.botId, bot.id);
    }
    if (input.channelId !== undefined && input.channelId !== cur.channelId) {
      const channel = await needChannel(input.channelId);
      next.channelId = channel.id; change('channel', cur.channelId, channel.id);
    }
    if (input.prompt !== undefined && input.prompt !== cur.prompt) {
      const p = promptProblem(input.prompt); if (p) throw invalid(p);
      next.prompt = input.prompt; change('prompt', clip(cur.prompt), clip(input.prompt));
    }
    if (input.trigger !== undefined) {
      const trigger = checkTrigger(input.trigger?.kind === 'webhook' ? { kind: 'webhook', hookId: cur.trigger.kind === 'webhook' ? cur.trigger.hookId : newId('hook', clk.now()) } : input.trigger);
      if (describeTrigger(trigger) !== describeTrigger(cur.trigger)) {
        next.trigger = trigger; change('trigger', describeTrigger(cur.trigger), describeTrigger(trigger));
        reasons.push(...triggerLoosens(cur.trigger, trigger));
      }
    }
    if (input.approvalTimeoutMin !== undefined && input.approvalTimeoutMin !== cur.approvalTimeoutMin) {
      const p = timeoutProblem(input.approvalTimeoutMin); if (p) throw invalid(p);
      next.approvalTimeoutMin = input.approvalTimeoutMin; change('approvalTimeoutMin', String(cur.approvalTimeoutMin), String(input.approvalTimeoutMin));
    }
    // モード: 指定が無くても、bot を替えて今のモードがそのバックエンドに無ければ、新しい bot のモードにそろえる
    if (bot) {
      const modes = modesOf(bot);
      let mode = next.mode;
      if (input.mode !== undefined && input.mode !== '') mode = await resolveMode(bot, input.mode);
      else if (modes && !modes[mode]) mode = await resolveMode(bot, '');
      if (mode !== cur.mode) {
        const curBot = await bots.get({ botId: cur.botId }).catch(() => null);
        const was = (curBot ? modesOf(curBot) : null)?.[cur.mode];
        const now_ = modes?.[mode];
        next.mode = mode;
        change('mode', was?.label ?? cur.mode, now_?.label ?? mode);
        if (now_ && (!was || strongerMode(now_, was))) reasons.push('mode');
      }
    }
    return { routine: cur, next, loosens: reasons.length > 0, reasons, rows };
  }

  // ------------------------------------------------------------ イベント

  async function fireEvent(on, sessionId) {
    if (closed || !sessionId) return;
    const meta = await host?.store?.get?.(sessionId).catch(() => null);
    if (!meta || meta.delegation || fromBotSide(meta.bot)) return;
    for (const r of matchingRoutines(store.list(), { on, sessionId })) {
      runner.run(r, { source: 'event', note: eventNote(on, meta.title) }).catch((e) => log(`could not run ${r.name}:`, errText(e)));
    }
  }

  // ------------------------------------------------------------ サービス

  const service = {
    dataDir, channels, bots, dispatch, host, emit, runner,

    async start() {
      closed = false;
      runner.open();
      try { await store.load(); }
      catch (e) { log('routines.json could not be loaded; routines are off until it is fixed:', errText(e)); return; }
      const missed = [];
      for (const listed of store.list()) {
        await runner.settleLost(listed).catch((e) => log('could not settle a run that was cut off:', errText(e)));
        const r = store.get(listed.id);
        if (!r || r.paused || !isTimed(r.trigger)) continue;
        const at = nextFireAt(r.trigger, baselineOf(r));
        if (at !== null && at <= clk.now()) missed.push(r.id);
      }
      // 止まっていた間の分は最新の 1 回だけ（根の投稿に routine.missed）。起動を待たせないよう、走らせるのは待たない
      for (const id of missed) {
        try {
          const cur = await store.update(id, (r) => ({ ...r, armedAt: clk.now() }));
          arm(id);
          runner.run(cur, { source: 'missed', missed: true }).catch((e) => log(`could not run ${cur.name} (missed):`, errText(e)));
        } catch (e) { log('could not start a missed routine:', errText(e)); }
      }
      for (const r of store.list()) if (!timers.has(r.id)) arm(r.id);
    },

    stop() {
      closed = true;
      for (const id of [...timers.keys()]) disarm(id);
      runner.stop();
    },

    async list() { return store.list().map(withNext); },
    async get({ routineId }) { const r = store.get(routineId); return r ? withNext(r) : null; },

    planCreate,
    planUpdate,

    async create(input, author) {
      const name = String(input?.name ?? '');
      const problem = nameProblem(name) ?? promptProblem(input?.prompt) ?? (input?.approvalTimeoutMin === undefined ? null : timeoutProblem(input.approvalTimeoutMin));
      if (problem) throw invalid(problem);
      const trigger = checkTrigger(input?.trigger?.kind === 'webhook' ? { kind: 'webhook', hookId: newId('hook', clk.now()) } : input?.trigger);
      const bot = await needBot(input?.botId);
      const channel = await needChannel(input?.channelId);
      const mode = await resolveMode(bot, input?.mode);
      const t = clk.now();
      const routine = await store.put({
        id: newId('routine', t), name: name.trim(), botId: bot.id, channelId: channel.id, prompt: input.prompt, trigger, mode,
        approvalTimeoutMin: input.approvalTimeoutMin ?? APPROVAL_TIMEOUT_DEFAULT_MIN, paused: input.paused === true,
        createdBy: author ?? { kind: 'human' }, createdAt: t, armedAt: t,
      });
      arm(routine.id);
      changed(routine);
      return withNext(routine);
    },

    async update(input, _author) {
      const plan = await planUpdate(input);
      if (!plan.rows.length) return withNext(plan.routine);
      const triggerChanged = plan.rows.some((row) => row.path === 'trigger');
      const updated = await wrap(() => store.update(plan.routine.id, (r) => ({
        ...r, name: plan.next.name, botId: plan.next.botId, channelId: plan.next.channelId, prompt: plan.next.prompt,
        trigger: plan.next.trigger, mode: plan.next.mode, approvalTimeoutMin: plan.next.approvalTimeoutMin,
        // トリガを変えたら、変える前の予定で「取りこぼし」を数えないよう、今を基準にし直す
        ...(triggerChanged ? { armedAt: clk.now() } : {}),
      })));
      arm(updated.id);
      changed(updated);
      return withNext(updated);
    },

    async pause({ routineId }) {
      need(routineId);
      const updated = await wrap(() => store.update(routineId, (r) => (r.paused ? null : { ...r, paused: true })));
      disarm(routineId);
      changed(updated);
      return withNext(updated);
    },

    async resume({ routineId }) {
      need(routineId);
      // 止めていた間の予定は数えない（再開した時刻から数え直す）
      const updated = await wrap(() => store.update(routineId, (r) => ({ ...r, paused: false, armedAt: clk.now() })));
      arm(routineId);
      changed(updated);
      return withNext(updated);
    },

    async remove({ routineId }) {
      need(routineId);
      disarm(routineId);
      await store.remove(routineId);
      send({ type: 'routinesChanged', removed: routineId });
    },

    async run({ routineId, dryRun = false }, _author) {
      const r = need(routineId);
      if (dryRun) {
        try { return { postId: null, ...(await runner.dryRun(r)), dryRun: true }; }
        catch (e) {
          if (e instanceof RunnerError) throw e.code === 'BOT_NOT_FOUND' ? new RoutineError('BOT_NOT_FOUND', { id: r.botId }) : invalid(e.detail);
          throw e;
        }
      }
      const started = await runner.run(r, { source: 'manual' });
      return { postId: started.postId, runId: started.runId, state: started.state, ...(started.reason ? { reason: started.reason } : {}) };
    },

    /** 外から起こす入口（webhook など）。一時停止中は走らせない */
    async fire(routineId, { source = 'webhook', note = '' } = {}) {
      const r = need(routineId);
      if (r.paused) return { postId: null, runId: null, state: 'skipped', reason: 'paused' };
      return runner.run(r, { source, note });
    },

    async rotateSecret({ routineId }) {
      const r = need(routineId);
      if (r.trigger.kind !== 'webhook') throw invalid('trigger must be webhook');
      const secret = crypto.randomBytes(32).toString('hex');
      await secrets.set(r.trigger.hookId, secret);
      return { secret };
    },

    onPermission(card, phase) {
      runner.onPermission(card, phase);
      if (phase === 'open' && card?.sessionId) fireEvent('waiting', card.sessionId).catch((e) => log('event trigger failed:', errText(e)));
    },
    onSessionDone(sessionId, outcome) {
      const on = eventOfOutcome(outcome);
      if (on) fireEvent(on, sessionId).catch((e) => log('event trigger failed:', errText(e)));
    },
    async onTurnEnd(turn, end) { await runner.onTurnEnd(turn, end); },

    /** 画面・診断用: 今走っているか */
    isRunning: (routineId) => runner.isRunning(routineId),
  };
  return service;
}
