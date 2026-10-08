// デスクトップのピル（desktop/chrome-pill.cjs）の「戻す」を受ける。ピルは返事を待つので、戻せなかったときは必ず chrome-pill-resume-failed を返す
// （黙って捨てると、ピルは返事が来るまで押せないままになる）。成功は引き継ぎが解けた状態の便りでピルへ伝わる。

/**
 * @param deps.control   core/chrome/control.mjs（state・resume）
 * @param deps.reply     (message) => void（main へ返す。失敗しても投げない）
 * @param data           { sessionId, since? }。since は押したピルが見ていた引き継ぎの始まりの時刻。今の引き継ぎと違えば戻さない
 */
export function resumeFromPill({ control, reply, log = () => {} }, data) {
  const sessionId = data.sessionId;
  const failed = () => { try { reply({ type: 'chrome-pill-resume-failed', sessionId }); } catch { /* main が離れた */ } };
  const current = control?.state(sessionId);
  // PC への引き継ぎ中の会話だけ。ピルを押した後に引き継ぎが解けて別の引き継ぎが始まっていたら（since が違う）、前のピルでは戻さない
  if (!current || current.state !== 'paused' || current.by !== 'pc' || (data.since !== undefined && current.since !== data.since)) { failed(); return Promise.resolve(false); }
  return control.resume(sessionId).then(() => {
    // 窓を隠せず paused のまま（同じ失敗の繰り返しは状態の便りが出ない）
    if (control.state(sessionId).state === 'paused') { failed(); return false; }
    return true;
  }, error => { log(`chrome pill resume failed: ${error?.message ?? error}`); failed(); return false; });
}
