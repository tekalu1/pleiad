// ルーティンの時計（R1）。今の時刻と、あとで 1 回だけ呼ぶタイマー。core/bots-host.mjs が createRoutineService に渡す。
// テストは tests/lib/routines-clock-loader.mjs でこのモジュールを差し替え、ファイルの時刻で進む時計にする（tests/lib/compaction-test-clock.mjs と同じ作り）。
//   now() → ms・setTimer(fn, delayMs) → handle（unref。プロセスを生かさない）・clearTimer(handle)
export const clock = {
  now: () => Date.now(),
  setTimer(fn, delayMs) {
    const handle = setTimeout(fn, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle),
};
