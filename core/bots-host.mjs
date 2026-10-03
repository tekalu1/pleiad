// bot・Channels・ルーティンを束ねて、core/server.mjs に「つなぎ目（seam）」を出す工場（ADR 0093〜0101、docs/channels.md）。
// server.mjs が触るのはここの返り（BotHost）だけ。各パッケージは自分のモジュールを埋め、server.mjs・client.mjs には触らない。
//
//   createBotHost(deps) → BotHost
//   deps（server.mjs が渡す。足りない口が見つかったらここと docs/channels.md に足す）:
//     store, dataDir, usageStore, sessionSearch, runtime（走っているターンの表）, outbox（人の送信待ち）,
//     createConversation, runTurn(args, onStarted, hooks), noticeTarget, noticeBlocked, abortSessions, emitGlobal,
//     getBackend(id), listBackends(), resolveModel, resolveEffort, agentLocaleFor(sessionId), agentT, currentLocale()
//   各モジュールには deps をまとめた HostTools（下の host）を渡す。emit(event) は sessionId: null で全接続へ、emitSession(sessionId, event) は会話の出来事
//
//   BotHost（server.mjs のつなぎ目。どれも例外を外へ出さない。bot の会話でなければ何もしない）:
//     opsDeps(): { channels, bots, memory, routines, botOfSession }   … opsDeps() に足す。ops の handler が ctx.channels などで呼ぶ
//     turnExtras(turn): Promise<{ botInstructions: string|null, notes: string[], folders: object|null }>   … runArgs に足す（notes は既存の notes の後ろ。
//                       folders は触れてよいフォルダーの渡し方 { all, additionalDirectories, writableRoots }。runArgs の botFolders になる）
//     onTurnEvent(turn, event): void                 … makeEmit の中。bot の会話の分
//     onTurnEnd(turn, { outcome, text, presents }): Promise<void>    … endTurn の usage 記録の後
//     onPermission(card, phase): void                … askPermission（phase: 'open' | 'settled'）
//     onSessionDone(sessionId, outcome): void        … 完了通知が落ち着いたとき（イベントのトリガ）
//     onCompacted(sessionId): void                   … 圧縮の完了
//     handleHttp(req, res): Promise<boolean>         … 認証の前。自分の要求（/hooks/）なら応答して true
//     start(): Promise<void>・stop(): void
//
// 区画ごとの持ち主（区画の外は触らない）: channels = S1、bots = S2、memory = S3、dispatch = S4、routines = R1（P2）、webhook = H1（P3）。
import path from 'node:path';
import { createChannelService } from './channels/service.mjs';
import { createBotService } from './bots/service.mjs';
import { createMemoryService } from './memory/service.mjs';
import { createDispatcher } from './bots/dispatch.mjs';
import { createRoutineService } from './routines/service.mjs';
import { createWebhookReceiver } from './routines/webhook.mjs';

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
  const channels = createChannelService({
    dir: path.join(dataDir, 'channels'), emit, listBots: () => bots.list(),
    hooks: { posted: lazy(() => dispatch.onPosted), stopThread: lazy(() => dispatch.stopThread) },
  });
  // ---- bots（S2）
  const bots = createBotService({ dataDir, channels, host, emit });
  // ---- memory（S3）
  const memory = createMemoryService({ dataDir, emit });
  // ---- dispatch（S4）
  const dispatch = createDispatcher({ channels, bots, memory, host, emit });
  // ---- routines（R1）
  const routines = createRoutineService({ dataDir, channels, bots, dispatch, host, emit });
  // ---- webhook（H1）
  const webhook = createWebhookReceiver({ dataDir, routines, host });

  const services = [channels, bots, memory, dispatch, routines];
  // つなぎ目は、bot の側の失敗でターン・承認・起動を巻き込まない
  const guard = (name, fn, fallback) => (...args) => {
    const fail = (err) => { console.error(`  bot host: ${name} に失敗:`, String(err?.message ?? err)); return fallback; };
    try {
      const result = fn(...args);
      return result && typeof result.then === 'function' ? result.catch(fail) : result;
    } catch (err) { return fail(err); }
  };

  return {
    opsDeps: () => ({ channels, bots, memory, routines, botOfSession }),
    // 人格とフォルダーは bots（S2）、末尾の notes は dispatch（S4。記憶の差分など）。bot の会話でなければどちらも空
    turnExtras: guard('turnExtras', async (turn) => {
      const setup = await bots.turnSetup(turn);
      const extra = await dispatch.turnExtras(turn);
      return { botInstructions: extra?.botInstructions ?? setup?.botInstructions ?? null, notes: extra?.notes ?? [], folders: setup?.folders ?? null };
    }, { botInstructions: null, notes: [], folders: null }),
    onTurnEvent: guard('onTurnEvent', (turn, event) => dispatch.onTurnEvent(turn, event)),
    onTurnEnd: guard('onTurnEnd', (turn, end) => dispatch.onTurnEnd(turn, end)),
    onPermission: guard('onPermission', (card, phase) => { dispatch.onPermission(card, phase); routines.onPermission(card, phase); }),
    onSessionDone: guard('onSessionDone', (sessionId, outcome) => routines.onSessionDone(sessionId, outcome)),
    onCompacted: guard('onCompacted', (sessionId) => dispatch.onCompacted(sessionId)),
    handleHttp: guard('handleHttp', (req, res) => webhook.handle(req, res), false),
    async start() { for (const s of services) await guard('start', () => s.start())(); },
    stop() { for (const s of [...services].reverse()) guard('stop', () => s.stop())(); },
  };
}
