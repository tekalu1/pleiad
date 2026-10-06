// 通話モードの PCM の道具（依存なし）。s16le モノラルが前提。
// 出どころ: vtc-web gateway/src/audio.ts（rmsOfS16・durationMsOfS16・wavFromS16）と providers/tts/openrouter.ts（先頭の無音を詰める・奇数バイトの持ち越し）を .mjs へ移した。

/** 発話とみなす RMS（0..1）。クライアントの送信ゲートと区切りで同じ値を使う（片方だけ変えると「話しているのに送られない声」ができる） */
export const VAD_THRESHOLD = 0.012;

/** s16le バッファの RMS（0..1） */
export function rmsOfS16(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/** s16le バッファの実時間長（ms） */
export const durationMsOfS16 = (pcm, sampleRate) => (Math.floor(pcm.length / 2) / sampleRate) * 1000;

/**
 * s16le モノラルの PCM に WAV（RIFF）のヘッダを付ける。
 * OpenRouter の同期の音声認識に生の PCM（format: "pcm"）を送ると、MAI・Grok・GPT は 400、Gemini は 200 で空の文字を返す。WAV なら全モデルが通る。
 */
export function wavFromS16(pcm, sampleRate) {
  const dataLength = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // 整数の PCM
  view.setUint16(22, 1, true);            // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLength, true);
  out.set(pcm.subarray(0, dataLength), 44);
  return out;
}

/** 偶数バイトに揃える。チャンクの境で s16 を割らない（割ると以降の全サンプルが 1 バイトずれて雑音になる）。余りは次へ持ち越す */
export function createEvenChunker() {
  let carry = null;
  return (chunk) => {
    let data = chunk;
    if (carry) {
      const joined = new Uint8Array(carry.length + data.length);
      joined.set(carry);
      joined.set(data, carry.length);
      data = joined;
      carry = null;
    }
    const even = data.length - (data.length % 2);
    if (even < data.length) carry = data.slice(even);
    return data.subarray(0, even);
  };
}

const LEAD_THRESHOLD = 350;     // 声とみなす振幅（s16。約 −39 dBFS）
const LEAD_KEEP_MS = 80;        // 声の前に残す長さ（語頭の息・子音）
const LEAD_MAX_TRIM_MS = 600;   // 先頭で捨ててよい上限。これより長い無音は提供元が意図した間か、無音しか返らない応答なのでそのまま流す

/**
 * 応答の先頭の無音を詰める（モデルによっては 0〜320ms の無音を付けて返す）。チャンクを順に入れ、流してよい分を返す。
 * 入れるのは偶数バイトのチャンクだけ。声が一度も来なかった応答は finish() でそのまま流す。
 */
export function createLeadingSilenceTrimmer(sampleRate) {
  const keepBytes = Math.floor((sampleRate * LEAD_KEEP_MS) / 1000) * 2;
  const maxBytes = Math.floor((sampleRate * LEAD_MAX_TRIM_MS) / 1000) * 2;
  let leading = true;
  let held = new Uint8Array(0);
  let dropped = 0;
  return {
    push(chunk) {
      if (!leading) return chunk;
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
      let onset = -1;
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        if (Math.abs(view.getInt16(i, true)) >= LEAD_THRESHOLD) { onset = i; break; }
      }
      const joined = new Uint8Array(held.length + chunk.length);
      joined.set(held);
      joined.set(chunk, held.length);
      if (onset >= 0 || dropped + chunk.length > maxBytes) {
        leading = false;
        const start = onset >= 0 ? Math.max(0, held.length + onset - keepBytes) : 0;
        dropped += start;
        held = new Uint8Array(0);
        return joined.subarray(start);
      }
      const keep = Math.min(keepBytes, joined.length);
      dropped += joined.length - keep;
      held = joined.slice(joined.length - keep);
      return new Uint8Array(0);
    },
    finish() {
      const rest = held;
      held = new Uint8Array(0);
      leading = false;
      return rest;
    },
    trimmedMs: () => Math.round((dropped / 2 / sampleRate) * 1000),
  };
}
