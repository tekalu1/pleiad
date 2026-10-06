// マイクの取り込み（通話モード）。getUserMedia → AudioWorklet → 16kHz s16le のフレーム。
// 出どころ: vtc-web web/src/lib/audio/web-audio-capture-source.ts と capture-source.ts（Worklet を Blob の文字列で登録する・128 サンプルを 4096 にまとめる・
// 元レートで RMS を測ってから箱平均で 16kHz に落とす・出力を gain 0 で destination へ繋ぐ・エラーの分類）。
import { downsample, floatTo16BitPcm, rms } from './pcm.mjs';

export const UPLINK_RATE = 16000;
const FRAME_SAMPLES = 4096;   // 48kHz で約 85ms。小さくするとフレームが増え、大きくするとゲートの分解能が落ちる

const WORKLET_SOURCE = `
class PlyVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSamples = options.processorOptions.frameSamples;
    this.buffer = new Float32Array(this.frameSamples);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;   // no input (the track is muted): do not fill with silence, or the send gate would think quiet audio is flowing
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.frameSamples) {
        const frame = this.buffer.slice(0);
        this.port.postMessage(frame, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('ply-voice-capture', PlyVoiceCapture);
`;

/** getUserMedia の失敗を分類する（未知を「権限あり」にしない）: denied（権限）・no-device・busy・unavailable */
export function captureErrorReason(error) {
  const name = error?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unavailable';
}

export class CaptureError extends Error {
  constructor(reason, cause) { super(reason); this.name = 'CaptureError'; this.reason = reason; this.cause = cause; }
}

/**
 * @param {{ context: AudioContext, echoCancellation?: boolean, onFrame: (frame: { pcm: ArrayBuffer, rms: number, ms: number }) => void }} o
 *   context は通話の開始（クリック）で作って resume 済みのもの。再生と共有する
 */
export function createCapture({ context, echoCancellation = true, onFrame }) {
  let stream = null, node = null, source = null, sink = null, moduleUrl = null;

  async function open() {
    const constraints = { audio: { echoCancellation, noiseSuppression: echoCancellation, autoGainControl: echoCancellation, channelCount: 1 } };
    // 使用中・不明は 1 回だけ 400ms 後に黙ってやり直す（負荷時に取り合いで落ちる）。権限拒否・機器なしは直し方が違うのでやり直さない
    for (let attempt = 0; ; attempt++) {
      try { return await navigator.mediaDevices.getUserMedia(constraints); }
      catch (e) {
        const reason = captureErrorReason(e);
        if (attempt === 0 && (reason === 'busy' || reason === 'unavailable')) { await new Promise((r) => setTimeout(r, 400)); continue; }
        throw new CaptureError(reason, e);
      }
    }
  }

  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError('unavailable');
      stream = await open();
      try {
        if (context.state === 'suspended') await context.resume();
        moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        await context.audioWorklet.addModule(moduleUrl);
        node = new AudioWorkletNode(context, 'ply-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, processorOptions: { frameSamples: FRAME_SAMPLES } });
        const rate = context.sampleRate;
        const ms = (FRAME_SAMPLES / rate) * 1000;
        node.port.onmessage = (event) => {
          const samples = event.data;
          const level = rms(samples);   // ダウンサンプルの前に測る
          onFrame({ pcm: floatTo16BitPcm(downsample(samples, rate, UPLINK_RATE)), rms: level, ms });
        };
        source = context.createMediaStreamSource(stream);
        // 出力を 0 にして destination へ繋ぐ（繋がないと、出力に経路の無いノードを処理しないブラウザーがある）。自分の声がスピーカーへ戻ることはない
        sink = context.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
      } catch (e) {
        await this.stop();
        throw e instanceof CaptureError ? e : new CaptureError('unavailable', e);
      }
    },
    /** 何度呼んでも安全。トラックを止めるまで、タブに録音中の表示が残る */
    async stop() {
      if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
      source?.disconnect(); source = null;
      sink?.disconnect(); sink = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      if (moduleUrl) { URL.revokeObjectURL(moduleUrl); moduleUrl = null; }
    },
  };
}
