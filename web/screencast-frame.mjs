// 映像のフレームを <img> に描き、描き終えたら ack を返す部品（docs/inapp-browser.md「リモートから見る」）。
// 内蔵ブラウザーを見る全面の表示（web/remote-browser.mjs）とエージェントの Chrome の窓の右パネル（web/chrome-panel.mjs）が共有する。
// フレームは WS の screencast メッセージ（{ seq, data（JPEG の base64）, metadata }）。ホストは ack を受けるまで次を出さないので、
// 描き終えた（load）ときに onAck(seq) を呼ぶ。

/** 直近の時刻の列から fps（3 秒の窓） */
export function framesPerSecond(times, now) {
  const recent = times.filter(time => now - time <= 3000);
  return recent.length < 2 ? recent.length : Math.round(recent.length / 3 * 10) / 10;
}

/**
 * @param img     フレームを描く <img>
 * @param onAck   描き終えた seq で呼ぶ
 * @param now     時刻（ms）。テストで差し替える
 */
export function createFrameSink({ img, onAck = () => {}, now = () => performance.now() }) {
  let frame = null, times = [];
  img.addEventListener('load', () => {
    const seq = img.dataset.seq;
    if (seq) onAck(Number(seq));
  });
  return {
    /** メッセージのフレームを描く */
    push(message) {
      frame = { seq: message.seq, metadata: message.metadata ?? {} };
      times.push(now()); if (times.length > 40) times.shift();
      img.dataset.seq = String(message.seq);
      img.src = `data:image/jpeg;base64,${message.data}`;
    },
    /** 絵を捨てる（別の会話・閉じた・窓が替わった） */
    reset() { frame = null; times = []; img.removeAttribute('src'); delete img.dataset.seq; },
    get frame() { return frame; },
    fps() { return framesPerSecond(times, now()); },
  };
}
