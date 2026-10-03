// ルーティンの時計の身代わり（core/routines/clock.mjs と同じ形）。今の時刻は TEST_ROUTINES_CLOCK のファイルに書かれた数（ms）で、テストが進める。
// タイマーは 10ms ごとにファイルの時刻を見て、予定の時刻に達したら 1 回だけ呼ぶ（tests/lib/compaction-test-clock.mjs と同じ作り）。
// 書き込みの途中を読んでも時計が戻らないよう、読めない・読んだ値が前より小さいときは前の値を返す。
import fs from 'node:fs';

let last = 0;
const now = () => {
  try {
    const value = Number(fs.readFileSync(process.env.TEST_ROUTINES_CLOCK, 'utf8'));
    if (Number.isFinite(value) && value >= last) last = value;
  } catch { /* 差し替えの途中は読めないことがある */ }
  return last;
};
export const clock = {
  now,
  setTimer(fn, delayMs) {
    const at = now() + delayMs;
    const timer = setInterval(() => {
      if (now() < at) return;
      clearInterval(timer);
      fn();
    }, 10);
    timer.unref();
    return timer;
  },
  clearTimer: (handle) => clearInterval(handle),
};
