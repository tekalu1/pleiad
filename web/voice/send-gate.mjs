// 送信ゲート（通話モード。純粋）。静かな間の音声をホストへ送らない（費用と帯域）。声で開き、最後の声のあと一定時間は流して閉じる。
// 出どころ: vtc-web web/src/lib/audio/send-gate.ts の考え方（プリロール・開始窓・ハングオーバー）。区切りはホストが決める（core/voice/cutter.mjs）ので、
// ゲートはホストの区切りが「声のあとの無音 600ms」を見られるだけ流し続ける（ハングオーバー 900ms。Soniox 向けの 3.5 秒は要らない）。
//
// 閾値はホストの区切りと同じ値（VAD_THRESHOLD = 0.012）。片方だけ変えると「話しているのに送られない声」ができる。
export const VAD_THRESHOLD = 0.012;
export const PREROLL_MS = 300;
export const HANGOVER_MS = 900;

/**
 * @param {{ threshold?: number, prerollMs?: number, hangoverMs?: number }} [o]
 * @returns {{ push(frame: { pcm: ArrayBuffer, rms: number, ms: number }): ArrayBuffer[], reset(): void, open: () => boolean }}
 *   push は、いま送ってよいフレーム（閉じていれば空。開いた瞬間はプリロールの分を先に付けて返す）
 */
export function createSendGate({ threshold = VAD_THRESHOLD, prerollMs = PREROLL_MS, hangoverMs = HANGOVER_MS } = {}) {
  let open = false;
  let silentMs = 0;
  let ring = [];
  let ringMs = 0;
  return {
    push(frame) {
      const voiced = frame.rms >= threshold;
      if (open) {
        silentMs = voiced ? 0 : silentMs + frame.ms;
        if (silentMs >= hangoverMs) { open = false; silentMs = 0; ring = []; ringMs = 0; return []; }
        return [frame.pcm];
      }
      if (voiced) {
        open = true;
        silentMs = 0;
        const out = [...ring.map((f) => f.pcm), frame.pcm];
        ring = [];
        ringMs = 0;
        return out;
      }
      ring.push(frame);
      ringMs += frame.ms;
      while (ring.length > 1 && ringMs - ring[0].ms >= prerollMs) ringMs -= ring.shift().ms;
      return [];
    },
    reset() { open = false; silentMs = 0; ring = []; ringMs = 0; },
    open: () => open,
  };
}
