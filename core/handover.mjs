// 引き継ぎ（無停止の更新 段階 2 の 2d。docs/zero-downtime-update/plan.md 2d、design.md §5.1・§6）。
// 旧サーバー（S1）が、保持役に載ったターンを新しいサーバー（S2）へ渡して終わる順序と、S2 の起動の取り決め。
//
// 旧サーバーの順序（createHandover の run。副作用は deps で受ける。サーバーは core/server.mjs の handoverToNext が組む）:
//   1. 新しい作業の開始を送信待ちに回す（hold）。以後、送信待ちは始まらず、完了通知・追加指示は渡さない
//   2. 短い処理（切り替え・分岐・途中送信の受理待ち・完了通知の配送中・送信待ちの kick・予定を撃っている最中）が終わるのを、上限（drainMs）まで待つ。
//      終わらなければ取りやめる（rollback。サーバーは元のまま。呼び出し側が数秒後にやり直す）
//   3. 保持役に載っていないターン・承認待ちなど引き継げない作業が残っていれば取りやめる（blocked）
//   4. 処理中の HTTP の MCP・in-process の host MCP・hooks のコールバックを、上限（inflightMs。目安 5 秒）まで待つ。**上限を過ぎても取りやめない**
//      （保持役の子の側から見れば、その呼び出しが 1 回失敗するだけで、モデルが読んでやり直す）。待ち切れなかった数を結果に載せる
//   5. 予定のタイマー（送信予定・上限の解除後の再開・圧縮の予約）を止める
//   6. 保持役に載ったターンの札を取る（take）。1 つでも取れなければ戻して取りやめる
//   7. 札を置いて detach する（detach。保持役の `detach` の答えが来るまで。以後、この親の書き込みは子へ転送されない）。1 つのターンが detach できなければ、
//      そのターンだけ中断して（abortOne。理由は update）終わるのを待つ。ほかのターンは渡す
//   8. 預かり物（トークン・ポート）を保持役へ置き、DB を書き切ってデータ置き場のロックを放す（release）。ここから先は取りやめない
// 新サーバーは `--handover` で起動し、モジュールを読み込んだ後でデータ置き場のロックを待ち（acquireDataLockWait）、取れたら預かり物を読み、
// 同じトークン・ポートで待ち受けてから付け直す（restoreAdoptedTurns・adoptTurn）。
export const HANDOVER_FLAG = '--handover';
/** main との口の handover の形の版（core/handover-check.mjs が範囲を出し、running の handover.v に載せる）。形を変えるときは上げる */
export const HANDOVER_VERSION = 1;
export const HANDOVER_RANGE = [1, 1];
/** 短い処理が終わるのを待つ上限（これを過ぎたら取りやめる）・処理中の呼び出しを待つ上限（過ぎたら待ち切れた分を数えて進む）・新サーバーがロックを待つ上限 */
export const DRAIN_MS = 8_000;
export const INFLIGHT_MS = 5_000;
export const LOCK_WAIT_MS = 30_000;
/** 引き継げないターンが detach に失敗して中断した後、終わるのを待つ上限 */
export const ABORT_WAIT_MS = 10_000;
/** 預かり物の形の版・預かり物を使ってよい古さの上限（旧サーバーが置いてから新サーバーが読むまで数秒。前の引き継ぎの古い値を拾わない） */
export const STASH_VERSION = 1;
export const STASH_MAX_AGE_MS = 5 * 60_000;

/** 起動の引数に `--handover` があるか（新サーバー） */
export const handoverStart = (argv = process.argv) => argv.slice(2).includes(HANDOVER_FLAG);

/** 預かり物（保持役の stash）の形。トークンとポートは、旧サーバーと新サーバーで同じ値を使う（画面・CLI・MCP の口の URL が変わらない。design.md §8） */
export function stashOf({ token, cliToken, port, appVersion = null, at = Date.now() }) {
  return { v: STASH_VERSION, handover: { token, cliToken, port, appVersion, at } };
}

/** 預かり物から、新サーバーが使う値を取り出す。形が合わない・古すぎる（前の引き継ぎのもの）なら null（env の値で起動する） */
export function readStash(stash, { maxAgeMs = STASH_MAX_AGE_MS, now = Date.now() } = {}) {
  const h = stash?.v === STASH_VERSION ? stash.handover : null;
  if (!h || typeof h.token !== 'string' || !h.token) return null;
  if (!Number.isFinite(h.at) || now - h.at > maxAgeMs || h.at - now > maxAgeMs) return null;
  return {
    token: h.token,
    cliToken: typeof h.cliToken === 'string' && /^[0-9a-f]{64}$/.test(h.cliToken) ? h.cliToken : null,
    port: Number.isInteger(h.port) && h.port > 0 && h.port < 65536 ? h.port : null,
    at: Number.isFinite(h.at) ? h.at : null,
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 旧サーバーが閉じかけのファイルに当たって一時的に読めない（SQLite の disk I/O error・busy）間だけ、やり直す（新サーバーのデータ置き場の確認）。
 * 別の理由の失敗はそのまま投げる。上限を過ぎたら最後の失敗を投げる
 */
export async function retryTransient(fn, { timeoutMs = 3_000, pollMs = 50, now = Date.now, sleep = wait } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    try { return await fn(); }
    catch (error) {
      if (!/disk I\/O error|database is locked|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR/i.test(String(error?.message ?? error)) || now() >= until) throw error;
    }
    await sleep(pollMs);
  }
}

/** predicate が真になるまで、上限まで待つ。戻り値は { ok, waitedMs } */
export async function waitUntil(predicate, { timeoutMs, pollMs = 20, now = Date.now, sleep = wait } = {}) {
  const start = now();
  for (;;) {
    if (await predicate()) return { ok: true, waitedMs: now() - start };
    if (now() - start >= timeoutMs) return { ok: false, waitedMs: now() - start };
    await sleep(pollMs);
  }
}

class Declined extends Error {
  constructor(reason, detail = null) { super(detail ? `${reason}: ${detail}` : reason); this.reason = reason; this.detail = detail; }
}

/**
 * 旧サーバーの引き継ぎ。deps:
 *   hold() / unhold()              新しい作業の開始を送信待ちに回す・戻す（戻したら、送信待ちを kick し直す）
 *   settled()                      → { ok, detail? } 短い処理が終わったか（終わっていないものを detail に）
 *   blockers()                     → [{ kind, sessionId }] 引き継げない作業（保持役に載っていないターンなど）
 *   inflight()                     → 処理中の MCP・hooks の呼び出しの数
 *   turns()                        → 引き継ぐターン（{ key, sessionId }）
 *   stopTimers() / resumeTimers()  予定のタイマー
 *   take(turn) / untake(turn)      札を取る（{ card, secrets } か null）・取ったことを戻す
 *   detach(turn, taken)            札を子に置いて detach する（失敗は投げる）
 *   abortOne(turn, error)          そのターンだけ中断する（理由 update）。ended(turn) で終わったか見る
 *   stash()                        預かり物を置く
 *   release(result)                DB を書き切り、答え（result）を main へ返して、データ置き場のロックを放す（これ以後は取りやめない。サーバーはここで終わる）
 *   log(line) / now() / sleep(ms)
 * run() の戻り値: { ok: true, handed: [sessionId], aborted: [sessionId], droppedCalls, ms: { drain, inflight, detach, total } } か { ok: false, reason, detail }
 */
export function createHandover(deps) {
  const { log = () => {}, now = Date.now, sleep = wait } = deps;
  let running = false;
  const stamp = { now, sleep };
  return {
    get running() { return running; },
    async run({ drainMs = DRAIN_MS, inflightMs = INFLIGHT_MS, abortMs = ABORT_WAIT_MS } = {}) {
      if (running) return { ok: false, reason: 'busy', detail: 'a handover is already running' };
      running = true;
      const t0 = now();
      const ms = {};
      let timersStopped = false;
      let released = false;
      const taken = [];
      try {
        deps.hold();
        // 引き継げない作業が今あるなら、待たずに断る（新しい作業を送信待ちに回す時間を、続けて断られるときに無駄にしない）
        const early = deps.blockers();
        if (early.length) throw new Declined('blocked', early.map(b => `${b.kind}:${b.sessionId ?? '-'}`).join(', '));
        // 2. 短い処理
        const drained = await waitUntil(() => deps.settled().ok, { timeoutMs: drainMs, ...stamp });
        ms.drain = drained.waitedMs;
        if (!drained.ok) throw new Declined('busy', deps.settled().detail ?? null);
        // 3. 引き継げない作業
        const blockers = deps.blockers();
        if (blockers.length) throw new Declined('blocked', blockers.map(b => `${b.kind}:${b.sessionId ?? '-'}`).join(', '));
        // 4. 処理中の呼び出し（待ち切れなくても進む）
        const calls = await waitUntil(() => deps.inflight() === 0, { timeoutMs: inflightMs, ...stamp });
        ms.inflight = calls.waitedMs;
        const droppedCalls = calls.ok ? 0 : deps.inflight();
        if (droppedCalls) log(`handover: ${droppedCalls} call(s) were still running after ${inflightMs} ms; they will fail once and the model can retry`);
        // 待つ間に新しい短い処理・引き継げない作業が現れていないか、もう一度見る（hold の後なので増えないはずだが、始まっていた処理が終わるまで）
        if (!deps.settled().ok) throw new Declined('busy', deps.settled().detail ?? null);
        const late = deps.blockers();
        if (late.length) throw new Declined('blocked', late.map(b => `${b.kind}:${b.sessionId ?? '-'}`).join(', '));
        // 5. タイマー
        deps.stopTimers();
        timersStopped = true;
        // 6. 札
        for (const turn of deps.turns()) {
          const card = deps.take(turn);
          if (!card) { for (const done of taken) deps.untake(done.turn); throw new Declined('card', `${turn.sessionId ?? turn.key}`); }
          taken.push({ turn, card });
        }
        // 7. detach
        const t1 = now();
        const failed = [];
        await Promise.all(taken.map(async item => {
          try { await deps.detach(item.turn, item.card); }
          catch (error) { failed.push(item); log(`handover: could not hand off ${item.turn.sessionId ?? item.turn.key}: ${error?.message ?? error}`); deps.abortOne(item.turn, error); }
        }));
        ms.detach = now() - t1;
        if (failed.length) {
          const ended = await waitUntil(() => failed.every(item => deps.ended(item.turn)), { timeoutMs: abortMs, ...stamp });
          if (!ended.ok) log(`handover: ${failed.length} turn(s) that could not be handed off were still stopping after ${abortMs} ms`);
        }
        // 8. 預かり物・放す
        // 手を離した後は取りやめない（子はもう渡っている）。預かり物が置けなくても、新サーバーは main の渡したトークン・ポートで起動する
        try { await deps.stash(); } catch (error) { log(`handover: could not leave the stash: ${error?.message ?? error}`); }
        ms.total = now() - t0;
        const result = { ok: true, handed: taken.filter(item => !failed.includes(item)).map(item => item.turn.sessionId ?? item.turn.key), aborted: failed.map(item => item.turn.sessionId ?? item.turn.key), droppedCalls, ms };
        released = true;
        await deps.release(result);
        return result;
      } catch (error) {
        if (released) throw error;   // 放した後は戻せない（呼び出し側が理由つきで終わる）
        if (timersStopped) deps.resumeTimers();
        deps.unhold();
        const reason = error instanceof Declined ? error.reason : 'error';
        const detail = error instanceof Declined ? error.detail : String(error?.message ?? error);
        log(`handover: declined (${reason}${detail ? `: ${detail}` : ''})`);
        return { ok: false, reason, detail };
      } finally { running = false; }
    },
  };
}
