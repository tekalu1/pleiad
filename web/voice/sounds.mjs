// 効果音（通話モード。承認済み 2026-10-07。docs/voice-call.md「効果音」）。画面を見ずに状態が分かる短い音。既定はオフ。
//
// 設定 › 通話の「効果音」: off（鳴らさない）・few（送ったと止めたの 2 つだけ）・all（全部）。
// 各音は 200ms 以内で小さく、形で区別する（上がる＝始まる、下がる＝終わる・戻る、同じ音 2 回＝待ち）。読み上げ中は鳴らさない（止めた音だけ例外）。
// 聞こえない人には画面の表示（吹き出し・配送の行・失敗の一行）が同じことを伝える。
// 通話の AudioContext は通話を終えると閉じるので、効果音は自分の AudioContext を持つ（通話の開始のクリックの後に初めて作る）。

/** name -> { level: 鳴らす最低の設定（few は few と all で鳴る）, seq: 音の列, type } */
export const SOUNDS = Object.freeze({
  start: { level: 'all', seq: [{ f: 660, d: 0.07 }, { f: 880, d: 0.09 }] },
  sent: { level: 'few', seq: [{ f: 520, d: 0.06, v: 0.8 }] },
  barge: { level: 'few', seq: [{ f: 760, to: 380, d: 0.09 }] },
  wait: { level: 'all', seq: [{ f: 400, d: 0.06 }, { f: 400, d: 0.06, gap: 0.04 }] },
  fail: { level: 'all', seq: [{ f: 330, d: 0.09 }, { f: 247, d: 0.12 }], type: 'triangle' },
  end: { level: 'all', seq: [{ f: 880, d: 0.07 }, { f: 660, d: 0.09 }] },
});

const GAIN = 0.09;

/** その設定で鳴らす音か（読み上げ中かどうかは見ない） */
export function shouldPlay(name, level) {
  const sound = SOUNDS[name];
  if (!sound || level === 'off' || !level) return false;
  return level === 'all' || sound.level === 'few';
}

/**
 * @param {object} o
 * @param {() => string} o.level  いまの設定（off・few・all）
 * @param {() => boolean} [o.speaking]  読み上げ中か（鳴らさない。止めた音だけ例外）
 * @param {typeof AudioContext} [o.AudioContextImpl]
 */
export function createSounds({ level, speaking = () => false, AudioContextImpl = globalThis.AudioContext }) {
  let ctx = null;
  const context = () => {
    if (ctx || !AudioContextImpl) return ctx;
    try { ctx = new AudioContextImpl({ latencyHint: 'interactive' }); } catch { ctx = null; }
    return ctx;
  };
  return {
    /** 鳴らす（設定・読み上げ中の判定を通ったときだけ）。鳴らしたら true */
    play(name) {
      if (!shouldPlay(name, level())) return false;
      if (name !== 'barge' && speaking()) return false;
      const c = context();
      if (!c) return false;
      if (c.state === 'suspended') c.resume?.().catch?.(() => {});
      let at = c.currentTime + 0.02;
      const { seq, type = 'sine' } = SOUNDS[name];
      for (const n of seq) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(n.f, at);
        if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, at + n.d);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(GAIN * (n.v ?? 1), at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + n.d);
        o.connect(g).connect(c.destination);
        o.start(at);
        o.stop(at + n.d + 0.02);
        at += n.d + (n.gap ?? 0.02);
      }
      return true;
    },
    close() { ctx?.close?.().catch?.(() => {}); ctx = null; },
  };
}
