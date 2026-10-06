// bot・Channels・ルーティンを束ねて、core/server.mjs に「つなぎ目（seam）」を出す工場（ADR 0106〜0114、docs/channels.md）。
// server.mjs が触るのはここの返り（BotHost）だけ。各パッケージは自分のモジュールを埋め、server.mjs・client.mjs には触らない。
//
//   createBotHost(deps) → BotHost
//   deps（server.mjs が渡す。足りない口が見つかったらここと docs/channels.md に足す）:
//     store, dataDir, usageStore, sessionSearch, runtime（走っているターンの表）, outbox（人の送信待ち）,
//     createConversation, runTurn(args, onStarted, hooks), noticeTarget, noticeBlocked, abortSessions, emitGlobal,
//     getBackend(id), listBackends(), resolveModel, resolveEffort, agentLocaleFor(sessionId), agentT, currentLocale(),
//     readQuota(backendId)（使用枠。チャンネルの予算が使う。ADR 0119）、
//     deleteHidden(sessionId)（隠れた会話をネイティブの会話ごと消す。消せなければ false。心拍・夜の整理の片付けが使う。ADR 0127）
//   各モジュールには deps をまとめた HostTools（下の host）を渡す。emit(event) は sessionId: null で全接続へ、emitSession(sessionId, event) は会話の出来事
//
//   BotHost（server.mjs のつなぎ目。どれも例外を外へ出さない。bot の会話でなければ何もしない）:
//     opsDeps(): { channels, bots, memory, memoryLearner, brain, pulse, wakes, routines, botOfSession, wake, threadBudget }   … opsDeps() に足す。ops の handler が ctx.channels などで呼ぶ。
//                       brain は bot の頭の中の保存（思考の流れ・気がかり。core/brain/store.mjs）、pulse は心拍（core/brain/pulse.mjs。ADR 0126）、
//                       wakes は bot が自分で決めた時刻に起きる予約（core/brain/wakes.mjs。ADR 0140）
//                       memoryLearner は夜の整理（core/memory/learn.mjs）。memory.learnStatus が status() を呼ぶ
//                       wake({ channelId, postId, botId }) は channels.wake の本体（dispatch.wakePost。起こせたかを { woken, reason? } で返す）
//     turnExtras(turn): Promise<{ botInstructions: string|null, notes: string[], folders: object|null }>   … runArgs に足す（notes は既存の notes の後ろ。
//                       folders は触れてよいフォルダーの渡し方 { all, additionalDirectories, writableRoots }。runArgs の botFolders になる）
//     onTurnEvent(turn, event): void                 … makeEmit の中。bot の会話の分
//     onTurnEnd(turn, { outcome, interrupted, requeued }): Promise<void>    … endTurn の最後（ターンを手放した後。最終の返答は lastReply、提示は onTurnEvent の present）
//                       dispatch がターンの投稿を確定した後に、ルーティンの実行なら routines.onTurnEnd が根の投稿の状態（終了・要確認・失敗・止めた）を決める
//     onPermission(card, phase): void                … askPermission（phase: 'open' | 'settled'）。dispatch（作業中の印）と routines（承認待ちの期限・イベントのトリガ「あなた待ち」）の両方へ
//     onSessionDone(sessionId, outcome): void        … 完了通知が落ち着いたとき（イベントのトリガ）
//     onCompacted(sessionId): void                   … 圧縮の完了
//     handleHttp(req, res): Promise<boolean>         … 認証の前。自分の要求（/hooks/）なら応答して true
//     start(): Promise<void>・stop(): void・close(): Promise<void>（stop と DB の接続の解放）
//
// 区画ごとの持ち主（区画の外は触らない）: channels = S1、bots = S2、memory = S3、dispatch = S4、routines = R1（P2）、webhook = H1（P3）。
import path from 'node:path';
import { createChannelService } from './channels/service.mjs';
import { createBotService } from './bots/service.mjs';
import { createMemoryService } from './memory/service.mjs';
import { createMemoryLearner } from './memory/learn.mjs';
import { createEpisodes } from './memory/episodes.mjs';
import { createDispatcher } from './bots/dispatch.mjs';
import { createRoutineService } from './routines/service.mjs';
import { clock as routinesClock } from './routines/clock.mjs';
import { createWebhookReceiver } from './routines/webhook.mjs';
import { createBrainStore } from './brain/store.mjs';
import { createPulse } from './brain/pulse.mjs';
import { createWakes } from './brain/wakes.mjs';

export function createBotHost(deps) {
  const { store, dataDir, emitGlobal } = deps;
  const emit = (event) => emitGlobal({ ...event, sessionId: null });
  const emitSession = (sessionId, event) => emitGlobal({ ...event, sessionId });
  const host = { ...deps, emit, emitSession };
  const lazy = (get) => (...args) => get()(...args);

  /** sidecar の `bot`（SessionBot）。bot の会話でなければ null */
  const botOfSession = async (sessionId) => {
    if (!sessionId) return null;
    return (await store.get(sessionId).catch(() => null))?.bot ?? null;
  };

  // ---- channels（S1）
  // 気がかりの「起こしてほしい条件」に当たる投稿は、心拍を早める（pulse は下で作る。投稿が来る頃には出来ている）
  const noteBrain = (post, channel) => { try { pulse?.onPosted(post, channel); } catch (e) { console.error('  pulse:', String(e?.message ?? e)); } };
  const noteEpisode = (post) => { try { episodes.onPosted(post); } catch (e) { console.error('  memory episode:', String(e?.message ?? e)); } };
  const channels = createChannelService({
    dir: path.join(dataDir, 'channels'), emit, listBots: () => bots.list(),
    hooks: { posted: async (...args) => { noteEpisode(args[0]); noteBrain(args[0], args[1]); await bots.noteShown(...args); return dispatch.onPosted(...args); },
      edited: async (...args) => { noteEpisode(args[0]); return bots.noteShown(...args); },
      removed: noteEpisode, reacted: lazy(() => dispatch.onReacted), stopThread: lazy(() => dispatch.stopThread), botPost: lazy(() => dispatch.claimPost) },
  });
  // ---- 頭の中（思考の流れ・気がかり。ADR 0126）
  const brain = createBrainStore({ dataDir, emit });
  let pulse, wakes;
  // bot を消したら、その bot の思考の流れ・気がかり・予約も消す
  host.botRemoved = (botId) => { brain.clear(botId); wakes?.clear(botId); };
  // ---- bots（S2）
  const bots = createBotService({ dataDir, channels, host, emit });
  // ---- memory（S3）
  const memory = createMemoryService({ dataDir, channels, emit, localeOf: () => deps.currentLocale?.() ?? 'ja' });
  let learner;
  const episodes = createEpisodes({ channels, bots, summarize: (args) => learner.summarizeEpisode(args), localeOf: () => deps.currentLocale?.() ?? 'ja' });
  // ---- dispatch（S4）
  const dispatch = createDispatcher({ channels, bots, memory, episodes, brain, host, emit });
  // bots.overview の restingUntil（使用量の上限で休憩中。ADR 0119）は dispatch が持つ
  host.restingUntil = (bot) => dispatch.restingUntil(bot);
  // ---- routines（R1）
  const routines = createRoutineService({ dataDir, channels, bots, dispatch, host, emit, clock: routinesClock });
  // ---- memory learner（L1。利用者のルーティン一覧には置かない）
  learner = createMemoryLearner({ dataDir, channels, bots, memory, host, clock: routinesClock });
  // ---- 心拍（bot ごとの設定で既定は OFF。AGENT_HOST_PULSE_FLOOR_MS・AGENT_HOST_PULSE_TICK_MS・AGENT_HOST_PULSE_EVERY_MS は開発中の確かめ用で、間隔の下限・確かめる間隔・既定の間隔を縮める。docs/dev-verification.md）
  pulse = createPulse({ dataDir, brain, channels, bots, host, budget: dispatch.budget, dispatch, memory, clock: routinesClock,
    ...(Number(process.env.AGENT_HOST_PULSE_FLOOR_MS) > 0 ? { floorMs: Number(process.env.AGENT_HOST_PULSE_FLOOR_MS) } : {}),
    ...(Number(process.env.AGENT_HOST_PULSE_TICK_MS) > 0 ? { tickMs: Number(process.env.AGENT_HOST_PULSE_TICK_MS) } : {}),
    ...(Number(process.env.AGENT_HOST_PULSE_EVERY_MS) > 0 ? { everyMs: Number(process.env.AGENT_HOST_PULSE_EVERY_MS) } : {}) });
  // ---- 予約（bot が自分で決めた時刻に、その会話で起きる。心拍の ON・OFF に依らない。ADR 0140）
  wakes = createWakes({ dataDir, channels, bots, dispatch, budget: dispatch.budget, clock: routinesClock, emit, localeOf: () => deps.currentLocale?.() ?? 'ja' });
  // ---- webhook（H1）
  const webhook = createWebhookReceiver({ dataDir, routines, host });

  const services = [channels, bots, memory, dispatch, routines, webhook, learner, episodes, pulse, wakes];
  // つなぎ目は、bot の側の失敗でターン・承認・起動を巻き込まない
  const guard = (name, fn, fallback) => (...args) => {
    const fail = (err) => { console.error(`  bot host: ${name} に失敗:`, String(err?.message ?? err)); return fallback; };
    try {
      const result = fn(...args);
      return result && typeof result.then === 'function' ? result.catch(fail) : result;
    } catch (err) { return fail(err); }
  };

  return {
    opsDeps: () => ({ channels, bots, memory, memoryLearner: learner, brain, pulse, wakes, routines, botOfSession, wake: guard('wake', (args) => dispatch.wakePost(args), { woken: false, reason: 'failed' }), threadBudget: guard('threadBudget', (args) => dispatch.threadBudget(args), null),
      // スレッドの bot の会話の設定（channels.threadSettings）。失敗は呼び出し側へ返す（画面が理由を出す）
      threadSettings: (args) => dispatch.threadSettings(args) }),
    // 人格とフォルダーは bots（S2）、末尾の notes は dispatch（S4。記憶の差分など）。bot の会話でなければどちらも空
    turnExtras: guard('turnExtras', async (turn) => {
      const setup = await bots.turnSetup(turn);
      const extra = await dispatch.turnExtras(turn);
      return { botInstructions: extra?.botInstructions ?? setup?.botInstructions ?? null, notes: extra?.notes ?? [], folders: setup?.folders ?? null };
    }, { botInstructions: null, notes: [], folders: null }),
    onTurnEvent: guard('onTurnEvent', (turn, event) => dispatch.onTurnEvent(turn, event)),
    // ターンの投稿を確定した後で、ルーティンの実行なら根の投稿の状態（終了・要確認・失敗・止めた）を決める
    onTurnEnd: guard('onTurnEnd', async (turn, end) => {
      try { await dispatch.onTurnEnd(turn, end); } finally { await routines.onTurnEnd(turn, end); }
    }),
    onPermission: guard('onPermission', (card, phase) => { dispatch.onPermission(card, phase); routines.onPermission(card, phase); }),
    onSessionDone: guard('onSessionDone', (sessionId, outcome) => routines.onSessionDone(sessionId, outcome)),
    onCompacted: guard('onCompacted', (sessionId) => dispatch.onCompacted(sessionId)),
    handleHttp: guard('handleHttp', (req, res) => webhook.handle(req, res), false),
    async start() { for (const s of services) await guard('start', () => s.start())(); },
    stop() { for (const s of [...services].reverse()) guard('stop', () => s.stop())(); },
    /** stop に加えて、DB の接続を離す（スレッドの状態・夜の整理の進み。データ置き場を消す前。テストの後片付け用） */
    async close() { this.stop(); await guard('close', () => channels.close())(); learner.close(); brain.close(); wakes.close(); },
  };
}
