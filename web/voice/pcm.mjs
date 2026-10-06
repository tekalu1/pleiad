// 通話の PCM の変換（純粋関数。ブラウザーの API を持ち込まない）。
// 出どころ: vtc-web web/src/lib/audio/pcm.ts（rms・downsample・s16leToFloat32・floatTo16BitPcm）を .mjs へ移した。

/** 元レートで測った RMS（0..1）。ダウンサンプル前の信号に対して呼ぶ（送信ゲートの閾値 0.012 はこの信号で決めた） */
export function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** ダウンサンプル。箱平均（区間内サンプルの単純平均。間引きだと折り返しが乗って認識の精度に効く）。targetRate > sourceRate は呼び出し側の誤り */
export function downsample(samples, sourceRate, targetRate) {
  if (targetRate === sourceRate) return samples;
  if (targetRate > sourceRate) throw new Error(`cannot upsample ${sourceRate} -> ${targetRate}`);
  const ratio = sourceRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0, count = 0;
    for (let j = start; j < end; j++) { sum += samples[j]; count++; }
    out[i] = count === 0 ? samples[start] : sum / count;
  }
  return out;
}

/** Float32（-1..1）→ s16le。DataView の true がリトルエンディアン（落とすと雑音になる）。範囲外は丸める */
export function floatTo16BitPcm(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buffer;
}

/** s16le → Float32（-1..1）。チャンクの境で s16 が割れるので、戻りの carry を次の呼び出しに渡す（無いと全サンプルが 1 バイトずれて雑音になる） */
export function s16leToFloat32(bytes, carry = null) {
  let joined = bytes;
  if (carry !== null) {
    joined = new Uint8Array(bytes.length + 1);
    joined[0] = carry;
    joined.set(bytes, 1);
  }
  const usable = joined.length - (joined.length % 2);
  const nextCarry = usable < joined.length ? joined[joined.length - 1] : null;
  const samples = new Float32Array(usable / 2);
  const view = new DataView(joined.buffer, joined.byteOffset, usable);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, carry: nextCarry };
}
