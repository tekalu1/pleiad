// イベントのトリガ（会話の完了・失敗・あなた待ち）に当たるルーティンを選ぶ（R1。ADR 0111）。純粋な部品。
//
//   eventOfOutcome(outcome) → 'done' | 'failed' | null    … onSessionDone の outcome（'ok' | 'error'）→ トリガの on
//   fromBotSide(sidecarBot) → boolean                      … bot・ルーティン・学習の会話から来た出来事か（対象にしない。自分の実行の失敗で自分が動く輪を作らない）。
//                                                            委譲の子の会話は server.mjs が onSessionDone に渡さない
//   matchingRoutines(routines, { on, sessionId }) → Routine[]  … 有効（paused でない）なイベントのルーティンで、on と対象（scope）が当たるもの
export const eventOfOutcome = (outcome) => (outcome === 'ok' ? 'done' : outcome === 'error' ? 'failed' : null);

/** sidecar の `bot`（SessionBot）があれば bot の側の会話。kind を問わない（thread・dm・routine・learner のどれも対象にしない） */
export const fromBotSide = (sidecarBot) => Boolean(sidecarBot?.botId);

export function matchingRoutines(routines, { on, sessionId }) {
  return routines.filter((r) => {
    if (r.paused || r.trigger?.kind !== 'event' || r.trigger.on !== on) return false;
    const { scope } = r.trigger;
    return scope === 'all' || (Array.isArray(scope?.sessionIds) && scope.sessionIds.includes(sessionId));
  });
}
