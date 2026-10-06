// main が居ないまま長く走り続けるサーバーを終わらせる見張り（無停止の更新 段階 1 の 1-4。docs/zero-downtime-update/plan.md「孤児にしない」）。
// main の切断を main-leaving（更新のためなど）を伴わず見たとき（main が落ちた）は、作業が 0 件のまま 3 分たったら終わる。
// main-leaving { reason: 'update' } の後は、新しい main が立ち上がるまでの時間を見込んで 30 分。作業が続いている間は終わらない。
// 次に Pleiad を起動した main が付け直す（desktop/server-boot.cjs）。つながっている間は何もしない。
export const ORPHAN_IDLE_MS = 3 * 60 * 1000;
export const UPDATE_IDLE_MS = 30 * 60 * 1000;
export const ORPHAN_CHECK_MS = 5000;

/**
 * @param isBusy    () => Promise<boolean>|boolean  作業（ターン・承認待ち・委譲など）が 1 件でもあるか
 * @param onExpire  ({ reason }) => void  作業が無いまま上限を過ぎた。サーバーを終わらせる
 */
export function createOrphanGuard({ isBusy, onExpire, idleMs = ORPHAN_IDLE_MS, updateIdleMs = UPDATE_IDLE_MS, checkMs = ORPHAN_CHECK_MS,
  now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval, log = () => {} } = {}) {
  let away = false;
  let leavingReason = null;
  let idleSince = null;
  let timer = null;
  let checking = false;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  async function check() {
    if (!away || checking) return;
    checking = true;
    try {
      if (await isBusy()) { idleSince = null; return; }
      if (!away) return;
      idleSince ??= now();
      const limit = leavingReason === 'update' ? updateIdleMs : idleMs;
      if (now() - idleSince >= limit) {
        stop();
        away = false;
        log(`no main for ${Math.round((now() - idleSince) / 1000)}s with no work (${leavingReason ?? 'lost'}): shutting down`);
        onExpire({ reason: leavingReason ?? 'lost' });
      }
    } catch (error) {
      log(`orphan check failed: ${error?.message ?? error}`);
    } finally { checking = false; }
  }

  return {
    /** main から main-leaving が来た（切れる前に来る）。次の disconnected の上限が決まる */
    leaving(reason) { leavingReason = typeof reason === 'string' ? reason : 'leaving'; },
    /** main が切れた。見張りを始める */
    disconnected() {
      away = true;
      idleSince = null;
      stop();
      timer = setTimer(() => { void check(); }, checkMs);
      timer?.unref?.();
    },
    /** main が離れるのをやめた（更新を取りやめた。main-leaving-cancel）。つながったままなので見張りは動いていない。次の切断の上限は main-leaving の前に戻る */
    leavingCancelled() { leavingReason = null; },
    /** main がつながった（付け直した）。見張りをやめ、main-leaving も忘れる */
    connected() {
      away = false;
      leavingReason = null;
      idleSince = null;
      stop();
    },
    check,
    get away() { return away; },
  };
}
