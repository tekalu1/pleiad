// 決まった文（受け取りの一言・待ちの実況。core/voice/wait-voice.mjs）の音声を、通話の中で 1 回だけ作って使い回す。毎ターン TTS を呼ばない
// （遅延も費用も要らない）。読み上げのクライアント（tts.mjs の createTtsClient）を包み、決まった文のときだけ、最後まで合成できた PCM を覚えておく。
// 声・言語・モデルは通話ごとに決まる（hello で引いた設定）ので、キャッシュも通話ごとに持てば声ごと・言語ごとに 1 回になる。
// 使い回した音は費用の計上（chars）を 0 にする（読み上げの課金は初回の 1 回だけ）。

/**
 * @param {{ synthesize: Function, sampleRate?: number }} tts
 * @param {Iterable<string>} texts  キャッシュする決まった文
 */
export function createPhraseCache(tts, texts) {
  const fixed = new Set(texts);
  const store = new Map();   // 文 -> { chunks, audioMs, bytes }
  return {
    sampleRate: tts.sampleRate,
    async synthesize(text, opts) {
      if (!fixed.has(text)) return tts.synthesize(text, opts);
      const hit = store.get(text);
      if (hit) {
        for (const chunk of hit.chunks) opts.onChunk(chunk);
        return { firstChunkMs: 0, tookMs: 0, audioMs: hit.audioMs, bytes: hit.bytes, chars: 0 };
      }
      const chunks = [];
      const result = await tts.synthesize(text, { ...opts, onChunk: (bytes) => { chunks.push(bytes.slice()); opts.onChunk(bytes); } });
      store.set(text, { chunks, audioMs: result.audioMs, bytes: result.bytes });   // 投げたとき（中断・失敗・途中で切れた）は入れない
      return result;
    },
    /** テスト用 */
    get size() { return store.size; },
  };
}
