// 発話の区切り（通話モード。docs/voice-call.md「区切りと片」）。
// 出どころ: vtc-web gateway/src/stt/utterance-cutter.ts を .mjs へ移した（型と長い経緯のコメントを外し、値の根拠だけ残した）。
//
// OpenRouter の音声認識（POST /audio/transcriptions）は同期で、送った音声の全文を返すだけ。ストリーミングも途中結果も無い。
// だから「どこまでを 1 回で送るか」をこちらで決める。純粋な状態機械で、動かすのは届いたフレームの長さの積算（音声の時計）だけ（壁時計は見ない）。
//
//   発話   声 + 無音 endSilenceMs（既定 600ms。縮めても確定は早くならず、行が割れる）か最長 30 秒で区切る。声が 200ms に届かなければ捨てる。
//          「話の区切り」（言いよどみを 1 通にまとめる待ち）はここではなくクライアント（web/voice/turn-hold.mjs）が持つ。発話はここで細かく区切って先に認識に回し、まとめ待ちの間に確定が揃うようにする
//   投機   最後の声のあと無音 300ms（フレーム単位で 341ms）で、区切ったときと同じ音声を先に送る見本を作る（speculate）。往復を無音の待ちに隠す。声が戻れば捨てる
//   片     話しながら文字を出すため、発話の途中で短く切って先に送る。声の頭から 1.0 秒を超えたあと無音 171ms（息継ぎ）か 2.5 秒（強制）で切る。
//          頭に直前の 2 秒を付けて送り、返った文字から前の片と重なる頭を除く（piece-text.mjs）。確定は発話全体を 1 回で認識した結果
//
// フレームは 16kHz s16le モノラル（クライアントが約 85ms ごとに送る）。
import { durationMsOfS16, rmsOfS16, VAD_THRESHOLD } from './pcm.mjs';

/** 声がこれより短い区間は送らない（ms）。咳・物音で幻の 1 語を作らない。ごく短い相づちは落ちうる */
export const MIN_VOICED_MS = 200;
/** 声の前に足す長さ（ms）。閾値を超えた時点では語の頭が過ぎているため */
export const PREROLL_MS = 300;
/** 発話の後ろに残す無音（ms）。残りは送らない（認識の費用は送った秒数で数えられ、往復も遅くなる） */
export const TAIL_KEEP_MS = 200;

const SOFT_LIMIT_RATIO = 2 / 3;   // 最長の何割を過ぎたら最初の息継ぎで切るか
const FRAME_EPSILON_MS = 0.01;    // フレームの長さを足し合わせた誤差を吸う幅

export const DEFAULT_CUT = Object.freeze({
  endSilenceMs: 600,
  maxUtteranceMs: 30000,
  speculativeSilenceMs: 300,
  pieces: Object.freeze({ minMs: 1000, silenceMs: 170, maxMs: 2500, contextMs: 2000 }),
});

/**
 * @param {{ endSilenceMs: number, maxUtteranceMs: number, speculativeSilenceMs: number, pieces?: { minMs: number, silenceMs: number, maxMs: number, contextMs: number } }} config
 * @param {number} sampleRate
 * @returns {{
 *   push(frame: Uint8Array): ({ kind: 'utterance', utterance: object } | { kind: 'piece', piece: object } | { kind: 'dropped', voicedMs: number, reason: string } | null),
 *   finish(): ({ kind: 'utterance', utterance: object } | { kind: 'dropped', voicedMs: number, reason: string } | null),
 *   speaking(): boolean, voicedMs(): number,
 *   speculate(): (object | null), speculationId(): (number | null) }}
 *   utterance: { pcm, startMs, endMs, voicedMs, reason: 'silence'|'max'|'finish'|'speculative', speculationId }
 *   piece: { pcm（頭に contextMs ぶんの直前の音声）, contextMs, startMs, endMs, voicedMs, end: 'breath'|'forced', index }
 */
export function createUtteranceCutter(config, sampleRate) {
  let streamMs = 0;
  let preroll = [];
  let prerollMs = 0;
  let speech = null;
  let lastSpeculationId = 0;

  const pushPreroll = (piece) => {
    preroll.push(piece);
    prerollMs += piece.ms;
    while (preroll.length > 1 && prerollMs - (preroll[0]?.ms ?? 0) >= PREROLL_MS) prerollMs -= preroll.shift().ms;
  };

  /** 後ろの無音を TAIL_KEEP_MS だけ残す。rest は残さない分（次の発話の頭になりえる） */
  const trimTail = (tail) => {
    const kept = [], rest = [];
    let keptMs = 0;
    for (const piece of tail) {
      if (keptMs >= TAIL_KEEP_MS) { rest.push(piece); continue; }
      kept.push(piece);
      keptMs += piece.ms;
    }
    return { kept, keptMs, rest };
  };

  const concat = (frames) => {
    const pcm = new Uint8Array(frames.reduce((sum, f) => sum + f.pcm.length, 0));
    let offset = 0;
    for (const f of frames) { pcm.set(f.pcm, offset); offset += f.pcm.length; }
    return pcm;
  };

  /** 区切る（cut）のと、先に送る見本を作る（speculate）のが同じ音声を作るための 1 本道 */
  const assemble = (current, kept, keptMs, reason) => ({
    pcm: concat([...current.pieces, ...kept]),
    startMs: current.startMs,
    endMs: current.startMs + current.ms + keptMs,
    voicedMs: current.voicedMs,
    reason,
    speculationId: current.speculationId,
  });

  const cut = (reason) => {
    const current = speech;
    speech = null;
    if (current === null) return null;
    const { kept, keptMs, rest } = trimTail(current.tail);
    for (const piece of rest) pushPreroll(piece);
    if (current.voicedMs < MIN_VOICED_MS) return { kind: 'dropped', voicedMs: current.voicedMs, reason };
    return { kind: 'utterance', utterance: assemble(current, kept, keptMs, reason) };
  };

  /** 片を切るか。切るなら頭に直前の音声を付けた片を返し、次の片へ進める。発話を区切る判定より後に呼ぶ（同じフレームで発話が切れるなら片は作らない） */
  const cutPiece = (current, voiced, frameMs) => {
    const rule = config.pieces;
    if (!rule || rule.minMs <= 0 || current.pieceVoiceFromMs === null || current.voicedMs < MIN_VOICED_MS) return null;
    const endMs = current.ms + current.tailMs;
    const elapsed = endMs - current.pieceVoiceFromMs;
    let end = null;
    if (elapsed >= rule.maxMs) {
      // 最長に届いたフレームが無音なら、そこは声の切れ目なので息継ぎ。強制切断（語の途中かもしれない）は声のフレームの途中で届いたときだけ
      end = voiced ? 'forced' : 'breath';
    } else if (elapsed >= rule.minMs && current.tailMs >= rule.silenceMs
      // 息継ぎの長さに届いたフレームでだけ切る。続く無音の途中で切ると、短い発話のたびに発話全体と同じ片を余分に送ることになる
      && current.tailMs - frameMs < rule.silenceMs) {
      end = 'breath';
    }
    if (end === null) return null;
    // 頭に付ける直前の音声。発話の頭（プリロールを含む）より前には戻らない。フレームの途中では切らない
    const from = Math.max(0, current.pieceFromMs - rule.contextMs);
    const frames = [...current.pieces, ...current.tail];
    const kept = [];
    let position = 0, keptFrom = null;
    for (const frame of frames) {
      if (position + frame.ms > from + FRAME_EPSILON_MS) { keptFrom ??= position; kept.push(frame); }
      position += frame.ms;
    }
    const piece = {
      pcm: concat(kept),
      contextMs: Math.max(0, current.pieceFromMs - (keptFrom ?? 0)),
      startMs: current.startMs + current.pieceFromMs,
      endMs: current.startMs + endMs,
      voicedMs: current.pieceVoicedMs,
      end,
      index: current.pieceIndex,
    };
    current.pieceFromMs = endMs;
    current.pieceVoiceFromMs = null;
    current.pieceVoicedMs = 0;
    current.pieceIndex += 1;
    return piece;
  };

  return {
    push(frame) {
      const ms = durationMsOfS16(frame, sampleRate);
      if (ms === 0) return null;
      streamMs += ms;
      const piece = { pcm: frame, ms };
      const voiced = rmsOfS16(frame) >= VAD_THRESHOLD;

      if (speech === null) {
        if (!voiced) { pushPreroll(piece); return null; }
        // 声の立ち上がり。溜めておいた無音を頭に付ける（語頭を切らない）
        speech = {
          pieces: preroll, ms: prerollMs, voicedMs: 0, startMs: streamMs - ms - prerollMs, tail: [], tailMs: 0, speculationId: null,
          pieceFromMs: 0, pieceVoiceFromMs: null, pieceVoicedMs: 0, pieceIndex: 0,
        };
        preroll = [];
        prerollMs = 0;
      }

      if (voiced) {
        speech.pieceVoiceFromMs ??= speech.ms + speech.tailMs;
        speech.pieceVoicedMs += ms;
        speech.pieces.push(...speech.tail, piece);   // 息継ぎから声が戻った。間の無音は発話の一部
        speech.ms += speech.tailMs + ms;
        speech.voicedMs += ms;
        speech.tail = [];
        speech.tailMs = 0;
        speech.speculationId = null;                 // 声が増えたので、先に送った見本とは音声が違う
      } else {
        speech.tail.push(piece);
        speech.tailMs += ms;
      }

      const total = speech.ms + speech.tailMs;
      if (!voiced && speech.tailMs >= config.endSilenceMs) return cut('silence');
      if (!voiced && total >= config.maxUtteranceMs * SOFT_LIMIT_RATIO) return cut('max');
      if (total >= config.maxUtteranceMs) return cut('max');
      const cutOff = cutPiece(speech, voiced, ms);
      return cutOff === null ? null : { kind: 'piece', piece: cutOff };
    },
    finish: () => cut('finish'),
    /** いま話している発話と、頭に付ける無音の溜めを、何も出さずに捨てる（まとめ待ちの取り消し）。音声の時計（streamMs）は進めたまま */
    reset() { speech = null; preroll = []; prerollMs = 0; },
    speaking: () => speech !== null,
    voicedMs: () => speech?.voicedMs ?? 0,
    /** 区切る前に先に送る見本。無音が speculativeSilenceMs に届いた最初の 1 回だけ返す（声が戻れば、次の無音でまた 1 回） */
    speculate() {
      if (speech === null || config.speculativeSilenceMs <= 0 || speech.speculationId !== null
        || speech.tailMs < config.speculativeSilenceMs
        // 区切るときは無音を TAIL_KEEP_MS ぶん残す。それに満たない無音で先に送ると、区切ったときと音声が違う
        || speech.tailMs < TAIL_KEEP_MS || speech.voicedMs < MIN_VOICED_MS) return null;
      lastSpeculationId += 1;
      speech.speculationId = lastSpeculationId;
      const { kept, keptMs } = trimTail(speech.tail);
      return assemble(speech, kept, keptMs, 'speculative');
    },
    speculationId: () => speech?.speculationId ?? null,
  };
}

export { VAD_THRESHOLD };
