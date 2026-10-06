// 声で確定した発言を、話した順に 1 通ずつ送る直列のキュー（通話モード。承認済み 2026-10-07）。
// 前の送信が済む（受理される・失敗する）まで次を始めない。失敗しても後ろは続ける（失敗は呼んだ側の then で受ける）。
// 共有の入力欄を使うやり方は、送信中の 2 通目が黙って入力欄に残り、1 通目に混ざった（docs/voice-call.md「送信」）。
export function createSendQueue() {
  let tail = Promise.resolve();
  return {
    /** fn を順番に走らせる。fn の結果（または投げた失敗）で解決・拒否する Promise を返す */
    push(fn) {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    },
  };
}
