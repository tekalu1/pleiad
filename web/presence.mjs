// 「いま見ている会話」をホストへ知らせる（presence。core/server.mjs の 'presence'、ADR 0086）。
// 画面が可視で、その会話を開いているときだけ見ていることになる。ホストはこれで、スマホへの通知を送らない・消す。
//
// 変わるたび（会話を移した・窓が隠れた/現れた・つなぎ直した）と、見ている間は 1 分ごとに送る
// （ホストは一定時間更新が無い印を捨てるので、落ちた画面が見ている印を残し続けない）。
// state.current の書き換えは何か所もあるので、1 秒ごとに見比べる（送るのは変わったときだけ）。
export const REFRESH_MS = 60_000;
const TICK_MS = 1000;

/**
 * @param send     (visible, sessionId) => Promise|void   WS の 'presence'
 * @param current  () => 開いている会話の id（新規・未確定は null）
 * @param visible  () => 画面が見えているか
 */
export function createPresenceReporter({ send, current, visible, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  let lastKey = null, lastAt = 0, timer = null, stopped = false;
  const key = () => {
    const id = current();
    const real = typeof id === 'string' && id && !id.startsWith('pending-') ? id : null;
    return { visible: visible() && real !== null, sessionId: real };
  };
  const report = (force = false) => {
    const k = key();
    const same = lastKey && lastKey.visible === k.visible && lastKey.sessionId === k.sessionId;
    // 見ていない状態は、変わったときに 1 回送れば足りる（見ている間だけ更新し続ける）
    if (!force && same && (!k.visible || now() - lastAt < REFRESH_MS)) return false;
    lastKey = k; lastAt = now();
    try { Promise.resolve(send(k.visible, k.sessionId)).catch(() => { lastKey = null; }); } catch { lastKey = null; }
    return true;
  };
  return {
    /** 1 回見て、変わっていれば送る。つなぎ直したとき（ready）は force で送り直す */
    report,
    start() {
      if (timer || stopped) return;
      timer = setTimer(() => report(), TICK_MS);
      timer.unref?.();
    },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    /** つながっていなかった間に送れなかった分を送り直す */
    reset() { lastKey = null; },
  };
}
