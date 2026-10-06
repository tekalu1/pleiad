// 通話の読み上げ（TTS）。OpenRouter の POST /audio/speech に response_format: "pcm" を付けると、PCM（24kHz mono s16le）が逐次で返る。
// 出どころ: vtc-web gateway/src/providers/tts/openrouter.ts を .mjs へ移した（検査・奇数バイトの持ち越し・先頭の無音を詰める・アイドルの中断）。docs/voice-call.md「読み上げ」。
//
// レートは先に決める（既定 24000。クライアントが再生のレートに使う）。応答のヘッダが違うレート・PCM でない形式（mp3 など）を示したら、1 バイトも流さずに失敗させる
// （違うレートで鳴らすと声の高さと速さが変わったまま最後まで流れる）。最初のバイトは 0.25〜0.45 秒（Aura-2・Grok・Qwen の実測）。
import { postOpenRouter, VoiceHttpError } from './openrouter.mjs';
import { createEvenChunker, createLeadingSilenceTrimmer } from './pcm.mjs';

export const TTS_SAMPLE_RATE = 24000;
const HEADERS_TIMEOUT_MS = 6000;   // 最初の音を待つ上限。逐次で返らないモデル（Gemini）は 2.6 秒かかる
const IDLE_TIMEOUT_MS = 10000;     // 流れている途中で次のチャンクがこれだけ来なければ止める

/** content-type が PCM でない・レートが違うなら理由の文を返す。問題なければ null（ヘッダが無いときは通す） */
export function rejectContentType(contentType, sampleRate) {
  if (!contentType) return null;
  const type = contentType.toLowerCase();
  if (type.startsWith('audio/mpeg') || type.startsWith('audio/mp3') || type.startsWith('audio/ogg') || type.startsWith('audio/wav') || type.startsWith('audio/x-wav')
    || type.startsWith('audio/webm') || type.startsWith('audio/aac') || type.startsWith('audio/flac')) return `not pcm: ${type}`;
  const rate = /rate=(\d+)/.exec(type)?.[1];
  if (rate && Number(rate) !== sampleRate) return `sample rate ${rate} != ${sampleRate}`;
  return null;
}

/**
 * @param {{ config: { baseUrl: string, apiKey: string, fetch?: typeof fetch }, model: string, voice: string, sampleRate?: number, now?: () => number, log?: Function }} o
 */
export function createTtsClient({ config, model, voice, sampleRate = TTS_SAMPLE_RATE, now = Date.now, log = () => {} }) {
  return {
    sampleRate,
    /**
     * 1 文を合成して、届いた順に onChunk（偶数バイトの PCM）へ渡す。
     * @returns {Promise<{ firstChunkMs: number|null, tookMs: number, audioMs: number, bytes: number, chars: number }>}
     * @throws {VoiceHttpError} 1 バイトも流す前の失敗は kind が transient / permanent / timeout。途中で切れたら partial: true
     */
    async synthesize(text, { signal, onChunk }) {
      const startedAt = now();
      const idle = new AbortController();
      let idleTimer = null;
      const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS); idleTimer.unref?.(); };
      const joined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
      let bytes = 0, firstChunkMs = null;
      try {
        const { response, retried } = await postOpenRouter(config, '/audio/speech', { model, input: text, voice, response_format: 'pcm' }, { headersTimeoutMs: HEADERS_TIMEOUT_MS, signal: joined });
        const rejected = rejectContentType(response.headers.get('content-type'), sampleRate);
        if (rejected) { await response.body?.cancel().catch(() => {}); throw new VoiceHttpError(rejected, 'permanent'); }
        if (!response.body) throw new VoiceHttpError('no body', 'permanent');
        const reader = response.body.getReader();
        const even = createEvenChunker();
        const trimmer = createLeadingSilenceTrimmer(sampleRate);
        armIdle();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          if (!value || value.length === 0) continue;
          const chunk = even(value);
          if (chunk.length === 0) continue;
          const audio = trimmer.push(chunk);
          if (audio.length === 0) continue;
          firstChunkMs ??= now() - startedAt;
          bytes += audio.length;
          onChunk(audio);
        }
        const tail = trimmer.finish();
        if (tail.length > 0) { firstChunkMs ??= now() - startedAt; bytes += tail.length; onChunk(tail); }
        if (bytes === 0) throw new VoiceHttpError('no audio returned', 'permanent');
        const result = { firstChunkMs, tookMs: now() - startedAt, audioMs: Math.round((bytes / 2 / sampleRate) * 1000), bytes, chars: text.length };
        log('voice.tts.request', { model, chars: text.length, firstChunkMs, tookMs: result.tookMs, audioMs: result.audioMs, trimmedLeadMs: trimmer.trimmedMs(), retried });
        return result;
      } catch (cause) {
        if (cause instanceof VoiceHttpError) { if (bytes > 0) cause.partial = true; throw cause; }
        const aborted = signal?.aborted;
        const error = new VoiceHttpError(aborted ? 'aborted' : 'synthesis interrupted', 'transient', { cause });
        if (bytes > 0) error.partial = true;
        throw error;
      } finally {
        clearTimeout(idleTimer);
      }
    },
  };
}
