// i18n-dynamic: agent:brain.loop.
// i18n-dynamic: agent:brain.reason.
// 心拍（ADR 0126）。bot ごとのタイマーで小さく起き続け、ほとんどは「静か」の 1 行だけ残す。大事なときだけ安いモデルを呼び、賢いモデルへ引き継ぐ。
// 3 段の頭: ① コードのふるい（core/brain/gate.mjs。0 円）→ ② 安いモデル（ぼんやり。隠れた会話・読み取りのモード・JSON だけ）→ ③ 賢いモデル（bot の本物の会話。投稿・作業はここだけ）。
// ここは 1 回の流れとタイマー・安いモデルの呼び方。欲求は drives.mjs、ふるいは gate.mjs、文は inner.mjs、返事の読み取りは answer.mjs、保存は store.mjs。
//
// 守っていること（安全の制限。型は決めない: 何を考えるか・いつ話すかは bot が決める）:
//   - 心拍は bot ごとの設定（Bot.pulse.on。既定 OFF）。ON にした bot だけ動く。止めた bot（paused）は動かない
//   - 間隔は既定 10 分、bot が決めても 5〜60 分（floorMs 未満にはしない）。PC が止まっていた間の取りこぼしは最新の 1 回だけ
//   - 予算（core/bots/budget.mjs の allowsBrain）が 0 なら、安いモデルも賢いモデルも呼ばない。未読のカーソルは進めず残す
//   - 安いモデルは道具なし（読み取りのモード・投稿の種類に入れない・channels.* の書き込みは ops が断る）。投稿は賢いモデルへの引き継ぎ経由だけ
//   - 外から来た文（taint）は思考の行・気がかりに引き継ぐ。それだけを理由にした引き継ぎは「確かめる」まで（投稿するかは賢いモデルが通常の規則で決める）
//   - 独り言を意味記憶には書かない（記憶の出どころ検査は緩めない。ここから memory.* は呼ばない）
//
//   createPulse({ dataDir, brain, channels, bots, host, budget, dispatch, memory, clock, ask, floorMs, tickMs }) → Pulse
//     host … store.getPrefs・getBackend・listBackends・resolveModel・resolveEffort・createConversation・runTurn・usageStore・currentLocale（learn.mjs と同じ）
//     budget … createBudget の返り（allowsBrain・leftBrain・chargeBrain）。dispatch … { handoff }（賢いモデルへの引き継ぎ）
//     ask(prompt, { bot, prefs }) → string | { text, sessionId?, usage? }   … 安いモデルの身代わり（テスト用）。無ければ隠れた会話で聞く
//     floorMs・tickMs・everyMs … 間隔の下限・タイマーの確かめる間隔・既定の間隔の上書き（テストと開発中の確かめ用。bots-host が環境変数から渡す）
//   Pulse:
//     start()・stop()・close()   … タイマー（tickMs ごとに、時刻の来た bot の心拍を 1 本ずつ流す）
//     beat(botId, { force }): Promise<Result>   … 1 回の心拍。Result = { botId, ran, gate?, did?, error?, skipped? }。force は人の［今すぐ］（ふるいは通すが、止めた bot・予算は越えない）
//     onPosted(post, channel): void   … 投稿の後。気がかりの「起こしてほしい条件」に当たれば、次の心拍を早める（間隔の下限は守る）
//     status(botId): Promise<{ on, paused, running, nextAt, lastBeatAt, drives, budget }>
//     pause(botId, paused): State   … ［眠らせる］・起こす
import os from 'node:os';
import { agentT } from '../i18n.mjs';
import { narrowestMode } from '../modes.mjs';
import { computeDrives } from './drives.mjs';
import { gate as runGate, wakeMatches } from './gate.mjs';
import { beatPrompt, handoffText, WORK_NOTES_VERSION, workNotesContext } from './inner.mjs';
import { parseBeat } from './answer.mjs';
import { BRAIN_DAILY_TOKENS } from '../bots/budget.mjs';

/** 心拍の間隔の下限・上限（ms）。bot が「次に起きる時刻」を決めても、ここに収める */
export const PULSE_FLOOR_MS = 5 * 60_000;
export const PULSE_CEIL_MS = 60 * 60_000;
export const TICK_MS = 15_000;
const SCAN_LIMIT = 100;
const THREAD_LIMIT = 30;
const EVENTS_MAX = 30;
/** 失敗が続いたときの間隔の伸ばし方（間隔 × 2^失敗、上限は 60 分） */
const FAIL_BACKOFF_MAX = 4;
/** bot ごとの、残しておく隠れた会話（心拍 1 回 = 1 会話）の数 */
const KEEP_SESSIONS = 60;
const PRUNE_SESSIONS_EVERY = 20;
const log = (...a) => console.error('  pulse:', ...a);
const errText = (e) => String(e?.message ?? e);
const clip = (s, n) => [...String(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, n).join('');

/** 予算を引く「家」のチャンネル: Bot.pulse.channelId（有効なチャンネルなら）、無ければ入っている最初のチャンネル。list は channels.list() の返り。予約（wakes.mjs）も使う */
export function pickHome(bot, list) {
  const usable = (c) => c.kind === 'channel' && !c.archivedAt;
  const chosen = bot.pulse?.channelId ? list.find((c) => c.id === bot.pulse.channelId && usable(c)) : null;
  return chosen ?? list.filter((c) => usable(c) && c.members?.includes(bot.id)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0] ?? null;
}

export function createPulse({ dataDir, brain, channels, bots, host, budget, dispatch, memory = null, clock, now = () => clock.now(), ask = null, floorMs = PULSE_FLOOR_MS, tickMs = TICK_MS, everyMs = null } = {}) {
  let timer = null;
  let closed = true;
  let chain = Promise.resolve();
  const running = new Set();
  const beats = new Map();   // botId → 心拍の数（隠れた会話の掃除の間隔用）
  const locale = () => host?.currentLocale?.() ?? 'ja';
  /** 既定の間隔（ms）。Bot.pulse.everyMin（5〜60 分）。everyMs は開発中の確かめ用の上書き（AGENT_HOST_PULSE_EVERY_MS） */
  const everyOf = (bot) => everyMs ?? (bot.pulse?.everyMin ?? 10) * 60_000;
  const clampMs = (ms, base) => Math.min(PULSE_CEIL_MS, Math.max(floorMs, ms - base));

  // ------------------------------------------------------------ 材料

  /** 予算を引く「家」のチャンネル（pickHome） */
  const homeOf = async (bot) => pickHome(bot, await channels.list());

  /**
   * 前回の心拍から後の出来事（所属チャンネルの投稿だけ。Chats の会話・他の bot の DM は読まない）。system・消した投稿・書き途中の投稿は除く。
   * 自分の投稿は authorKind 'self' で入れる（ふるい・欲求には数えない）。返事が一度失敗して後で答え直したのを見落とし、答え済みの質問を気がかりにしたため。
   * 人・他の bot の投稿の後に、同じスレッドで自分が失敗せずに投稿していれば answeredAt を付ける。
   * toMe は自分への @（人・他の bot のどちらからでも。system はここまでに除いている）
   * 返りの cursorTo は次のカーソル（書き途中の投稿があれば、その手前まで。後で書き上がった分を取りこぼさない）
   */
  async function collect(bot, since) {
    const names = new Map((await bots.list()).map((b) => [b.id, `${b.icon} ${b.name}`.trim()]));
    const at = now();
    let cursorTo = at;
    let lastHumanAt = null;
    const events = [];
    const seen = new Set();
    const take = (channel, p) => {
      if (seen.has(p.id) || p.at <= since || p.deletedAt) return;
      seen.add(p.id);
      if (p.state === 'working') { cursorTo = Math.min(cursorTo, Math.max(since, p.at - 1)); return; }
      const kind = p.author?.kind;
      if (kind === 'system' || !p.text?.trim()) return;
      const self = kind === 'bot' && p.author.botId === bot.id;
      if (kind === 'human') lastHumanAt = Math.max(lastHumanAt ?? 0, p.at);
      events.push({
        at: p.at, channelId: channel.id, channelName: channel.name, threadId: p.threadId ?? p.id, postId: p.id,
        authorKind: self ? 'self' : kind === 'human' ? 'human' : kind === 'bot' ? 'bot' : 'other',
        author: self ? 'you' : kind === 'human' ? 'human' : kind === 'bot' ? names.get(p.author.botId) ?? p.author.botId : kind, toMe: !self && (p.mentions ?? []).includes(bot.id),
        taint: p.taint ?? null, text: p.text, ...(self && p.state === 'failed' ? { failed: true } : {}),
      });
    };
    const list = (await channels.list()).filter((c) => !c.archivedAt && ((c.kind === 'channel' && c.members?.includes(bot.id)) || (c.kind === 'dm' && c.botId === bot.id)));
    for (const channel of list) {
      const page = await channels.read({ channelId: channel.id, limit: SCAN_LIMIT }).catch(() => null);
      if (!page) continue;
      if (channel.kind === 'dm') {
        // DM は人が bot に直接話しかける場所（ふつうの道で賢いモデルが答える）。心拍の材料にはせず、人が最後に話した時刻だけ見る
        for (const p of page.posts) if (p.author?.kind === 'human' && !p.deletedAt && p.at > since) lastHumanAt = Math.max(lastHumanAt ?? 0, p.at);
        continue;
      }
      for (const p of page.posts) take(channel, p);
      // 返信のあったスレッド: 投稿から数えた最後の返信の時刻（summaries.lastAt）で選ぶ。スレッドの状態（ThreadState.updatedAt）は bot のターンでしか動かず、
      // 人どうしの返信や、bot が答え直した返信を取りこぼした
      const touched = new Set((page.threads ?? []).filter((th) => (th.updatedAt ?? 0) > since).map((th) => th.threadId));
      for (const [rootId, s] of Object.entries(page.summaries ?? {})) if ((s?.lastAt ?? 0) > since) touched.add(rootId);
      for (const threadId of touched) {
        const replies = await channels.read({ channelId: channel.id, threadId, limit: THREAD_LIMIT }).catch(() => null);
        for (const p of replies?.posts ?? []) take(channel, p);
      }
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.authorKind === 'self' || e.authorKind === 'other') continue;
      const reply = events.find((r) => r.authorKind === 'self' && !r.failed && r.channelId === e.channelId && r.threadId === e.threadId && r.at > e.at);
      if (reply) e.answeredAt = reply.at;
    }
    return { events: events.slice(-EVENTS_MAX), cursorTo, lastHumanAt };
  }

  // ------------------------------------------------------------ 安いモデル（隠れた会話。夜の整理 core/memory/learn.mjs の askBackend と同じ手順）

  async function askBackend(bot, prompt, prefs) {
    const backendId = bot.pulse?.backend || prefs.memoryLearnBackend || bot.backend || prefs.backend || host.listBackends()[0]?.id;
    const backend = host.getBackend(backendId);
    if (!backend) throw new Error(`pulse backend unavailable: ${backendId}`);
    const cwd = os.homedir();
    const own = backendId === bot.backend;
    const model = await host.resolveModel(null, bot.pulse?.model || prefs.backends?.[backendId]?.model || (!bot.pulse?.backend && !prefs.memoryLearnBackend && own ? bot.model : undefined) || undefined, backend, cwd, '');
    const effort = await host.resolveEffort(null, prefs.backends?.[backendId]?.effort || undefined, backend, model, cwd, null);
    // いちばん狭いモード（Claude は plan、Codex は readonly）。道具は使わせない（承認を求めても、隠れた会話では server が断る）
    const mode = narrowestMode(backend.modes());
    if (!mode) throw new Error(`pulse backend has no read-only mode: ${backendId}`);
    const title = agentT(locale(), 'brain.pulse.title', { icon: bot.icon, name: bot.name });
    const at = now();
    const sessionId = await host.createConversation(backend, { title, cwd, createdAt: at, lastModified: at });
    await host.store.setMeta(sessionId, { backend: backend.id, title, cwd, createdAt: at, lastModified: at, unsent: true });
    await host.store.setMode(sessionId, mode);
    await host.store.setModel(sessionId, model);
    await host.store.setSessionData(sessionId, 'effort', effort);
    await host.store.setSessionData(sessionId, 'agentLocale', locale());
    await host.store.setSessionData(sessionId, 'bot', { botId: bot.id, kind: 'pulse', channelId: null, threadId: null }, { durable: true });
    const outcome = await host.runTurn({ sessionId, prompt }, () => {}, { internal: true });
    if (outcome !== 'ok' && outcome !== 'done') throw new Error(`pulse turn: ${outcome}`);
    const messages = await backend.getMessages(sessionId, { fullResults: true });
    const text = [...messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text ?? '';
    const rows = await host.usageStore?.records?.({ sessionIds: [sessionId], since: at - 1000 }).catch(() => []) ?? [];
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    for (const r of rows) { usage.inputTokens += r.inputTokens ?? 0; usage.outputTokens += r.outputTokens ?? 0; usage.cachedTokens += r.cachedTokens ?? 0; }
    return { text, sessionId, usage, backend: backend.id, model };
  }

  /**
   * 古い心拍の隠れた会話を、新しい KEEP_SESSIONS 件を残して消す（1 回 1 会話なので、放っておくと夜ごとに積もる）。
   * ネイティブの会話ごと消せるときだけ消す（host.deleteHidden）。以前は sidecar だけを消していて、bot の印を失った会話が Chats の一覧に出た（ADR 0127）
   */
  async function pruneSessions(botId) {
    try {
      if (!host.deleteHidden) return;
      const all = await host.store.getAll();
      const mine = Object.entries(all).filter(([, v]) => v?.bot?.kind === 'pulse' && v.bot.botId === botId).sort(([, a], [, b]) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      for (const [id] of mine.slice(KEEP_SESSIONS)) await host.deleteHidden(id).catch((e) => log('could not delete a hidden conversation:', errText(e)));
    } catch (e) { log('could not prune the hidden conversations:', errText(e)); }
  }

  // ------------------------------------------------------------ 1 回の心拍

  async function beat(botId, { force = false } = {}) {
    if (running.has(botId)) return { botId, ran: false, skipped: 'running' };
    running.add(botId);
    try { return await runBeat(botId, { force }); }
    catch (e) { log(`beat of ${botId} failed:`, errText(e)); return { botId, ran: false, error: errText(e) }; }
    finally { running.delete(botId); }
  }

  async function runBeat(botId, { force }) {
    const bot = await bots.get({ botId });
    if (!bot) return { botId, ran: false, skipped: 'nobot' };
    if (!bot.pulse?.on && !force) return { botId, ran: false, skipped: 'off' };
    const at = now();
    const state = brain.state(bot.id);
    const every = everyOf(bot);
    const home = await homeOf(bot);
    const stamp = { lastBeatAt: at };
    // 家のチャンネルが無い: 予算を引く先が無いので自発はしない
    if (!home) {
      brain.append(bot.id, { kind: 'quiet', meta: { reason: 'noHome' } });
      brain.setState(bot.id, { ...stamp, nextAt: at + every });
      return { botId, ran: true, gate: { pass: false, reason: 'noHome' } };
    }
    const since = state.cursorAt ?? at - every;
    const { events: seen, cursorTo, lastHumanAt } = await collect(bot, since);
    // ふるい・欲求・外から来た文の判定は、自分以外の出来事だけ（自分の投稿は束で「答え済みか」を見るための材料）
    const events = seen.filter((e) => e.authorKind !== 'self');
    const recent = brain.tail(bot.id, 12);
    const loops = workNotesContext({ loops: brain.loops(bot.id, 'open') }).loops;
    const prefs = await host.store.getPrefs().catch(() => ({}));
    const cheapBackend = bot.pulse?.backend || prefs.memoryLearnBackend || bot.backend;
    const left = await budget.leftBrain({ channelId: home.id, botId: bot.id, backend: cheapBackend, model: bot.pulse?.model });
    const allowed = await budget.allowsBrain({ channelId: home.id, botId: bot.id });
    const dayUsed = left ? 1 - Math.max(0, left.tokensLeft) / BRAIN_DAILY_TOKENS : null;
    const budgetUsed = left?.daily ? Math.max(dayUsed ?? 0, 1 - (left.channel ?? left.daily) / left.daily) : dayUsed;
    const drives = computeDrives({
      now: at, unread: { human: events.filter((e) => e.authorKind === 'human').length, bot: events.filter((e) => e.authorKind === 'bot').length, toMe: events.filter((e) => e.toMe).length },
      loops, recent, lastHumanAt: Math.max(lastHumanAt ?? 0, state.lastHumanAt ?? 0) || null, failures: state.failures ?? 0, budgetUsed,
    });
    const verdict = runGate({ now: at, paused: state.paused, allowed, events, loops, reservedAt: state.reservedAt, drives, sinceMuse: state.sinceMuse ?? 0, force });
    const meta = { reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}), ...(verdict.loopId ? { loop: verdict.loopId } : {}), drives, unread: events.length,
      ...(left ? { budget: { channel: left.channel, tokensLeft: Math.round(left.tokensLeft) } } : {}) };
    const common = { ...stamp, drives, lastHumanAt: Math.max(lastHumanAt ?? 0, state.lastHumanAt ?? 0) || null };

    if (!verdict.pass) {
      brain.append(bot.id, { kind: 'quiet', meta });
      // 止めた bot・予算なしでは、未読のカーソルを進めず残す（予算が戻ったら読む）
      brain.setState(bot.id, { ...common, cursorAt: verdict.keepUnread || verdict.reason === 'paused' ? state.cursorAt ?? since : cursorTo,
        nextAt: at + every, sinceMuse: (state.sinceMuse ?? 0) + 1 });
      return { botId, ran: true, gate: verdict, did: 'quiet' };
    }

    // ② 安いモデル
    const taintedInput = events.some((e) => e.taint) || loops.some((l) => l.taint);
    // 起きた理由が、外から来た文だけか（きっかけの投稿・条件に当たった気がかりのどちらも、外から来た文でない場合だけ「確かめる」を越えてよい）。
    // 投稿は人・他の bot のどちらでもよい（bot が外から来た文を読んで書いた投稿には、その taint が載る）
    const cleanTrigger = events.some((e) => !e.taint && (e.authorKind === 'human' || e.authorKind === 'bot')) || Boolean(verdict.loopId && !loops.find((l) => l.id === verdict.loopId)?.taint);
    const taint = taintedInput ? (events.find((e) => e.taint)?.taint ?? loops.find((l) => l.taint)?.taint ?? 'web') : null;
    const prompt = beatPrompt({ bot, locale: locale(), now: at, gate: verdict, drives, events: seen, stream: brain.tail(bot.id, 40), loops,
      budget: left ? { channel: left.channel ?? left.daily ?? 0, known: left.known } : null, related: await relatedOf(bot, events), minMin: Math.round(floorMs / 60_000), maxMin: Math.round(PULSE_CEIL_MS / 60_000) });
    let answered;
    try {
      const response = ask ? await ask(prompt, { bot, prefs }) : await askBackend(bot, prompt, prefs);
      answered = typeof response === 'string' ? { text: response } : response;
    } catch (e) {
      return failed(bot, { state, at, every, cursor: state.cursorAt ?? since, common, meta, message: errText(e) });
    }
    const usage = answered.usage ?? null;
    const tokens = usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cached: usage.cachedTokens ?? 0 } : null;
    if (usage) await budget.chargeBrain({ channelId: home.id, botId: bot.id, backend: answered.backend ?? cheapBackend, model: answered.model, usage }).catch((e) => log('could not charge the budget:', errText(e)));
    let parsed;
    try { parsed = parseBeat(answered.text, { now: at }); }
    catch (e) { return failed(bot, { state, at, every, cursor: state.cursorAt ?? since, common, meta: { ...meta, ...(answered.sessionId ? { session: answered.sessionId } : {}) }, message: errText(e), tokens }); }
    const rowMeta = { ...meta, workNotesVersion: WORK_NOTES_VERSION, ...(answered.sessionId ? { session: answered.sessionId } : {}) };

    // ⑦ 返事を当てはめる: 流れ・気がかり・次に起きる時刻
    let seq = null;
    if (parsed.thought) seq = brain.append(bot.id, { kind: 'think', text: parsed.thought, refs: parsed.refs, taint, tokens, meta: rowMeta }).seq;
    else if (parsed.do === 'none' || !parsed.thought) seq = brain.append(bot.id, { kind: 'quiet', tokens, meta: { ...rowMeta, by: 'model' } }).seq;
    if (parsed.loops.length) {
      const { applied } = brain.applyLoops(bot.id, parsed.loops, { taint, workNotesVersion: WORK_NOTES_VERSION });
      for (const a of applied) brain.append(bot.id, { kind: 'loop', text: agentT(locale(), `brain.loop.${a.op}`, { text: a.text }), refs: [a.id], taint, meta: { workNotesVersion: WORK_NOTES_VERSION } });
    }
    const reservedAt = parsed.wakeAt ? at + clampMs(parsed.wakeAt, at) : null;
    const sleepAt = parsed.do === 'sleep' ? at + Math.min(PULSE_CEIL_MS, Math.max(every * 3, 30 * 60_000)) : null;
    const nextAt = reservedAt ?? sleepAt ?? at + every;
    brain.setState(bot.id, { ...common, cursorAt: cursorTo, nextAt, reservedAt: reservedAt ?? sleepAt, sinceMuse: 0, failures: 0 });

    // ⑧ 賢いモデルへの引き継ぎ（確かめる・話す）
    if (parsed.do === 'act' && parsed.handoff) await handOff(bot, home, parsed, { taint, taintOnly: taintedInput && !cleanTrigger, at });
    const n = (beats.get(bot.id) ?? 0) + 1;
    beats.set(bot.id, n);
    if (!ask && n % PRUNE_SESSIONS_EVERY === 0) pruneSessions(bot.id);
    return { botId, ran: true, gate: verdict, did: parsed.do, seq };
  }

  /** 失敗（安いモデルの失敗・読めない返事）。カーソルは進めず、間隔を伸ばして次へ（毎回の失敗でモデルを呼び続けない） */
  function failed(bot, { state, at, every, cursor, common, meta, message, tokens = null }) {
    const failures = (state.failures ?? 0) + 1;
    brain.append(bot.id, { kind: 'quiet', tokens, meta: { ...meta, reason: 'error', error: clip(message, 160) } });
    brain.setState(bot.id, { ...common, cursorAt: cursor, nextAt: at + Math.min(PULSE_CEIL_MS, every * 2 ** Math.min(failures, FAIL_BACKOFF_MAX)), failures });
    return { botId: bot.id, ran: true, did: 'error', error: message };
  }

  async function relatedOf(bot, events) {
    if (!memory?.search || !events.length) return [];
    try {
      const hits = await memory.search({ query: events.map((e) => e.text).join(' ').slice(0, 200), layers: ['user', bot.id], limit: 3 });
      return (hits ?? []).map((h) => h.text);
    } catch { return []; }
  }

  async function handOff(bot, home, parsed, { taint, taintOnly, at }) {
    const l = locale();
    const stream = brain.tail(bot.id, 20);
    const act = brain.append(bot.id, { kind: 'act', text: parsed.handoff.why, refs: parsed.refs, taint, meta: { workNotesVersion: WORK_NOTES_VERSION, where: parsed.handoff.where ?? null, ...(taintOnly ? { taintOnly: true } : {}) } });
    if (!(await budget.allowsBrain({ channelId: home.id, botId: bot.id }))) {
      brain.append(bot.id, { kind: 'result', text: agentT(l, 'brain.line.handoffFailed', { reason: agentT(l, 'brain.reason.budget') }), refs: [String(act.seq)], taint });
      return;
    }
    const text = handoffText({ locale: l, now: at, why: parsed.handoff.why, stream, loops: brain.loops(bot.id, 'open'), taintOnly });
    const result = await dispatch.handoff({ botId: bot.id, why: parsed.handoff.why, where: parsed.handoff.where ?? null, text, actSeq: act.seq, homeChannelId: home.id, taint })
      .catch((e) => ({ ok: false, reason: errText(e) }));
    if (!result?.ok) brain.append(bot.id, { kind: 'result', text: agentT(l, 'brain.line.handoffFailed', { reason: result?.reason ?? '' }), refs: [String(act.seq)], taint });
  }

  // ------------------------------------------------------------ タイマー・投稿の知らせ

  const enqueue = (fn) => { chain = chain.then(fn, fn).catch((e) => log('failed:', errText(e))); return chain; };

  async function tick() {
    if (closed) return;
    const at = now();
    for (const bot of await bots.list()) {
      if (closed) return;
      if (!bot.pulse?.on) continue;
      const state = brain.state(bot.id);
      if (state.paused) continue;
      if (state.nextAt == null) { brain.setState(bot.id, { nextAt: at + everyOf(bot), cursorAt: at }); continue; }
      // PC が止まっていた間に溜まった心拍は、最新の 1 回だけ（nextAt を 1 回進めるだけで、溜まった分は走らない）
      if (state.nextAt <= at && !running.has(bot.id)) await enqueue(() => beat(bot.id));
    }
  }

  function arm() {
    if (closed) return;
    timer = clock.setTimer(async () => {
      timer = null;
      try { await tick(); } catch (e) { log('tick failed:', errText(e)); }
      arm();
    }, tickMs);
    timer?.unref?.();
  }

  function onPosted(post, channel) {
    if (closed || !post || post.deletedAt || channel?.kind !== 'channel' || post.author?.kind === 'system') return;
    (async () => {
      for (const bot of await bots.list()) {
        if (!bot.pulse?.on || !channel.members?.includes(bot.id) || (post.author?.kind === 'bot' && post.author.botId === bot.id)) continue;
        const state = brain.state(bot.id);
        if (state.paused) continue;
        const event = { threadId: post.threadId ?? post.id, text: post.text };
        if (!workNotesContext({ loops: brain.loops(bot.id, 'open') }).loops.some((l) => wakeMatches(l.wakeOn, event))) continue;
        // 起こしてほしい条件に当たった: 次の心拍を早める。間隔の下限は守る（前の心拍から floorMs 後より早くはしない）
        const soonest = Math.max(now(), (state.lastBeatAt ?? 0) + floorMs);
        if (state.nextAt == null || state.nextAt > soonest) brain.setState(bot.id, { nextAt: soonest, reservedAt: soonest });
      }
    })().catch((e) => log('could not check the wake conditions:', errText(e)));
  }

  async function status(botId) {
    const bot = await bots.get({ botId });
    if (!bot) return null;
    const state = brain.state(botId);
    const home = await homeOf(bot).catch(() => null);
    const left = home ? await budget.leftBrain({ channelId: home.id, botId }).catch(() => null) : null;
    return { on: Boolean(bot.pulse?.on), paused: Boolean(state.paused), running: running.has(botId), nextAt: bot.pulse?.on && !state.paused ? state.nextAt : null,
      lastBeatAt: state.lastBeatAt, drives: state.drives, home: home ? { id: home.id, name: home.name } : null,
      budget: left ? { daily: left.daily, channel: left.channel, tokensLeft: Math.round(left.tokensLeft), tokensDaily: BRAIN_DAILY_TOKENS, known: left.known } : null };
  }

  return {
    beat, status, onPosted, tick,
    pause: (botId, paused) => brain.setState(botId, { paused: Boolean(paused), ...(paused ? {} : { nextAt: now() + 60_000 }) }),
    isRunning: (botId) => running.has(botId),
    async start() { closed = false; arm(); },
    stop() { closed = true; if (timer) clock.clearTimer(timer); timer = null; },
    close() { this.stop(); },
  };
}
