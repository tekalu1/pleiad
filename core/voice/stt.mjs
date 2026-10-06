// 通話の聞き取り（STT）。OpenRouter の同期の音声認識（POST /audio/transcriptions）に、区切り・片・投機・予備のモデルを足す。
// 設計の出どころ: vtc-web gateway/src/providers/stt/openrouter.ts（読んで書き直した。片と投機と予備だけを残した）。docs/voice-call.md「聞き取り」。
//
//   createSttClient     1 回の認識。主のモデルが 429 なら待たずに予備へ送る（MAI は混む時間帯に送信の 4〜5 割が 429 になる共有枠）。
//                       429 を受けたら主を「混んでいる」とみなし、Retry-After の間は片を主へ送らず予備へ直接送る（確定と投機は主を先に試す。精度の差が大きい）
//   createTranscriber   フレームを受け、区切って送り、イベントを出す:
//     { type: 'speaking', on }                          声が 200ms に届いた / 区切った
//     { type: 'busy', on, last }                        まだ文字が出そろっていない（話している・区切って認識を待っている）。まとめ待ちは、これが閉じるまで送らない。last = ここまでに振った発話の番号の最大
//                                                       （まとめ待ちを取り消したとき、認識を待っていた分の確定が後から届いても、last までの番号は捨てる）
//     { type: 'partial', utt, text }                    片をつないだ途中の文字（前の片と重なった頭を除いたもの）。確定で置き換わる
//     { type: 'final', utt, text, ... }                 発話全体を 1 回で認識した文字（投機の再利用を含む）。区切った順に出る
//     { type: 'drop', utt }                             声が短い・文字が空（雑音）。途中の文字があれば消す
//     { type: 'error', utt, code, kind, status }        全体の認識が失敗（途中の文字が無いとき）
// 片が失敗したら（予備も 429 など）、その発話の残りの途中経過はあきらめて確定を待つ。重なりが見つからなかったときも同じ（二重に読むより安全）。
import { createUtteranceCutter, DEFAULT_CUT, MIN_VOICED_MS } from './cutter.mjs';
import { cleanPieceText, joinPiece, removeOverlap } from './piece-text.mjs';
import { durationMsOfS16, rmsOfS16, VAD_THRESHOLD, wavFromS16 } from './pcm.mjs';
import { postOpenRouter, VoiceHttpError } from './openrouter.mjs';

export const STT_SAMPLE_RATE = 16000;
const HEADERS_TIMEOUT_MS = 8000;
const PIECES_IN_FLIGHT = 2;
const STALL_MS = 1500;                // 音が来なくなったら、壁時計でこれだけ待って区切る（回線詰まりの床）
const COOLDOWN_DEFAULT_MS = 3000;
const COOLDOWN_MIN_MS = 1000;
const COOLDOWN_MAX_MS = 10000;

/** 空・記号だけの文字は雑音とみなす */
const meaningful = (text) => /[\p{L}\p{N}]/u.test(String(text ?? ''));

export function createSttClient({ config, model, fallbackModel = '', language = '', now = Date.now, log = () => {}, onSeconds = () => {} }) {
  let coolUntil = 0;
  const hasFallback = Boolean(fallbackModel) && fallbackModel !== model;
  const cooling = () => now() < coolUntil;

  const startCooldown = (retryAfter) => {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : COOLDOWN_DEFAULT_MS;
    const wasCooling = cooling();
    coolUntil = now() + Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
    if (!wasCooling) log('voice.stt.cooldown', { model, cooldownMs: coolUntil - now() });
  };

  async function call(useModel, pcm, { signal, retry, retryRateLimited, kind }) {
    const startedAt = now();
    const wav = wavFromS16(pcm, STT_SAMPLE_RATE);
    const body = { model: useModel, input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' }, ...(language ? { language } : {}) };
    const { response, retried } = await postOpenRouter(config, '/audio/transcriptions', body, {
      headersTimeoutMs: HEADERS_TIMEOUT_MS, signal, retry, retryRateLimited,
      onRateLimited: (retryAfter) => { if (useModel === model && hasFallback) startCooldown(retryAfter); },
    });
    const json = await response.json().catch(() => null);
    const audioMs = durationMsOfS16(pcm, STT_SAMPLE_RATE);
    onSeconds(audioMs / 1000);
    log('voice.stt.request', { model: useModel, kind, audioMs: Math.round(audioMs), tookMs: now() - startedAt, retried, cost: json?.usage?.cost ?? null });
    return { text: String(json?.text ?? ''), model: useModel, tookMs: now() - startedAt, audioMs };
  }

  return {
    cooling,
    hasFallback,
    /**
     * @param {Uint8Array} pcm 16kHz s16le
     * @param {'final'|'speculative'|'piece'} kind
     * @param {{ signal?: AbortSignal, preferFallback?: boolean }} [opts] preferFallback: 片で、この発話の前の片が予備へ行った（モデルが変わると表記の違いで重なりが外れやすいので、揃える）
     * @returns {Promise<{ text: string, model: string, tookMs: number, audioMs: number, route: string, fallback: boolean }>}
     */
    async transcribe(pcm, kind, { signal, preferFallback = false } = {}) {
      const retry = kind === 'final';
      if (kind === 'piece' && hasFallback && (preferFallback || cooling())) {
        const route = preferFallback ? 'sticky' : 'cooldown';
        return { ...(await call(fallbackModel, pcm, { signal, retry: false, retryRateLimited: false, kind })), route, fallback: true };
      }
      try {
        return { ...(await call(model, pcm, { signal, retry, retryRateLimited: !hasFallback, kind })), route: 'primary', fallback: false };
      } catch (e) {
        if (!(hasFallback && e instanceof VoiceHttpError && e.rateLimited)) throw e;
        startCooldown(e.retryAfter);
        // 429 の往復は約 0.3 秒。待たずに予備へ送る（予備は確定だけ 1 回やり直す）
        return { ...(await call(fallbackModel, pcm, { signal, retry, retryRateLimited: true, kind })), route: 'after_429', fallback: true };
      }
    },
  };
}

/**
 * @param {{ client: { transcribe: Function }, emit: (event: object) => void, language?: string, cut?: object, now?: () => number, log?: Function }} deps
 */
export function createTranscriber({ client, emit: emitRaw, language = 'ja', cut = DEFAULT_CUT, now = Date.now, log = () => {} }) {
  let discardedUpTo = 0;           // discard() の時点までに振った発話の番号。この番号までの partial・final・drop・error は出さない
  const emit = (event) => { if (event.utt !== undefined && event.utt <= discardedUpTo) return; emitRaw(event); };
  const cutter = createUtteranceCutter(cut, STT_SAMPLE_RATE);
  let order = Promise.resolve();   // 結果を出す順番（区切った順）。前の結果を待たずに次を送るが、出すのは話した順
  let live = null;                 // いま話している発話 { id, text, jobs, inflight, gaveUp, fallback, final, abort, lastVoiceAt }
  let nextId = 0;
  let speakingOn = false;
  let busyOn = false, busyLast = 0;
  let inflight = 0;                // 区切って認識に出し、確定・捨て・失敗がまだ出ていない発話の数
  let spec = null;                 // 先に送った見本 { id, promise, abort }
  let closed = false;
  let stallTimer = null;

  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = null;
    if (closed || !cutter.speaking()) return;
    stallTimer = setTimeout(() => { stallTimer = null; if (!closed) handle(cutter.finish()); }, STALL_MS);
    stallTimer.unref?.();
  };

  // ---- 片
  function pump(l) {
    while (!l.final && !l.gaveUp && l.inflight < PIECES_IN_FLIGHT) {
      const job = l.jobs.find((j) => j.state === 'queued');
      if (!job) return;
      job.state = 'flying';
      l.inflight++;
      const preferFallback = l.fallback;
      if (preferFallback || client.cooling?.()) l.fallback = true;   // 予備へ送り始めた時点で立てる（返ってからではなく）
      client.transcribe(job.piece.pcm, 'piece', { signal: l.abort.signal, preferFallback }).then(
        (r) => { job.result = r; if (r.fallback) l.fallback = true; },
        (e) => { job.error = e; },
      ).finally(() => { job.state = 'done'; l.inflight--; applyPieces(l); pump(l); });
    }
  }

  function applyPieces(l) {
    while (!l.final && !l.gaveUp) {
      const job = l.jobs[l.applied];
      if (!job || job.state !== 'done') return;
      l.applied++;
      if (job.error || !job.result) { l.gaveUp = true; log('voice.stt.pieces_gave_up', { utt: l.id, why: 'request', status: job.error?.status ?? null }); return; }
      const text = cleanPieceText(job.result.text);
      const removed = removeOverlap(l.text, text, job.piece.contextMs, language);
      if (!removed.ok) { l.gaveUp = true; log('voice.stt.pieces_gave_up', { utt: l.id, why: 'overlap' }); return; }
      const added = removed.text.trim();
      if (!added) continue;
      l.text = l.text ? l.text + joinPiece(l.text, added, language) : added;
      emit({ type: 'partial', utt: l.id, text: l.text });
    }
  }

  function onPiece(piece) {
    if (!live || live.final || live.gaveUp) return;
    live.jobs.push({ piece, state: 'queued', result: null, error: null });
    pump(live);
  }

  // ---- 投機
  function abortSpec() {
    if (!spec) return;
    spec.abort.abort();
    log('voice.stt.speculation', { outcome: 'discarded' });
    spec = null;
  }
  function startSpec(sample) {
    const abort = new AbortController();
    const promise = client.transcribe(sample.pcm, 'speculative', { signal: abort.signal });
    promise.catch(() => {});
    spec = { id: sample.speculationId, promise, abort };
  }

  // ---- 区切った発話
  function onUtterance(utt) {
    const l = live ?? { id: ++nextId, text: '', jobs: [], inflight: 0, applied: 0, gaveUp: true, fallback: false, final: false, abort: new AbortController(), lastVoiceAt: now() };
    live = null;
    const used = spec && utt.speculationId === spec.id ? spec : null;
    if (used) spec = null; else abortSpec();
    l.final = true;
    const lastVoiceAt = l.lastVoiceAt;
    const startedAt = now();
    const first = used ? used.promise : client.transcribe(utt.pcm, 'final');
    if (used) log('voice.stt.speculation', { outcome: 'hit' });
    inflight++;
    updateBusy();
    order = order.then(async () => {
      try { await settle(); } finally { inflight--; updateBusy(); }
    });
    async function settle() {
      let result = null, error = null;
      try { result = await first; }
      catch (e) {
        error = e;
        // 投機の失敗は、429・5xx・つながらないだけ通常の送り方で送り直す（タイムアウト・400 系は通常の送信でも同じ失敗なので送り直さない）
        if (used && e instanceof VoiceHttpError && e.kind === 'transient' && !used.abort.signal.aborted) {
          try { result = await client.transcribe(utt.pcm, 'final'); error = null; } catch (e2) { error = e2; }
        }
      }
      // 全体の認識が揃ったので、返っていない片は待たずに捨てる
      l.abort.abort();
      if (closed) return;
      const text = result ? String(result.text ?? '').trim() : '';
      if (result && !meaningful(text)) { emit({ type: 'drop', utt: l.id }); return; }
      if (result) {
        emit({ type: 'final', utt: l.id, text, reason: utt.reason, audioMs: Math.round(utt.endMs - utt.startMs), voicedMs: Math.round(utt.voicedMs),
          model: result.model, route: result.route, speculative: Boolean(used), tookMs: now() - startedAt, speechEndToFinalMs: now() - lastVoiceAt });
        return;
      }
      // 失敗。出した途中経過があれば、それを確定させる（途中の行が確定せずに残らないように）
      if (l.text) emit({ type: 'final', utt: l.id, text: l.text, reason: utt.reason, degraded: true, speechEndToFinalMs: now() - lastVoiceAt });
      else emit({ type: 'error', utt: l.id, code: 'stt', kind: error?.kind ?? 'transient', status: error?.status ?? null, rateLimited: Boolean(error?.rateLimited) });
    }
  }

  function onDropped() {
    const l = live;
    live = null;
    abortSpec();
    if (l) { l.final = true; l.abort.abort(); emit({ type: 'drop', utt: l.id }); }
  }

  function handle(res) {
    if (!res) return;
    if (res.kind === 'piece') onPiece(res.piece);
    else if (res.kind === 'utterance') onUtterance(res.utterance);
    else if (res.kind === 'dropped') onDropped();
    updateSpeaking();
  }

  function updateSpeaking() {
    const on = cutter.speaking() && cutter.voicedMs() >= MIN_VOICED_MS;
    if (on !== speakingOn) { speakingOn = on; emit({ type: 'speaking', on }); }
    updateBusy();
  }

  /** 話している間・区切った発話の確定を待っている間は busy。終わったあと、確定の emit より後に閉じる（確定を受けてから「まだ」を解く） */
  function updateBusy() {
    const on = !closed && (cutter.speaking() || inflight > 0);
    if (on !== busyOn || (on && nextId !== busyLast)) { busyOn = on; busyLast = nextId; emit({ type: 'busy', on, last: nextId }); }
  }

  return {
    /** 16kHz s16le のフレームを入れる */
    push(frame) {
      if (closed) return;
      const voiced = rmsOfS16(frame) >= VAD_THRESHOLD;
      const res = cutter.push(frame);
      if (!live && cutter.speaking()) live = { id: ++nextId, text: '', jobs: [], inflight: 0, applied: 0, gaveUp: false, fallback: false, final: false, abort: new AbortController(), lastVoiceAt: now() };
      if (voiced && live) live.lastVoiceAt = now();
      if (res) handle(res); else updateSpeaking();
      // 見本は、区切った直後（res が utterance）には作らない。声が戻った見本は捨てる
      if (spec && cutter.speculationId() !== spec.id) abortSpec();
      const sample = cutter.speculate();
      if (sample) startSpec(sample);
      armStall();
    },
    /** 今の発話を終わらせる（ミュート・通話の終わり） */
    finish() { handle(cutter.finish()); clearTimeout(stallTimer); },
    /**
     * ここまでの発話を、結果を出さずに捨てる（まとめ待ちの［取り消す］）。話している最中の発話・区切って認識を待っている発話は、返ってきても出さない
     * （番号が discard() の時点までのものは emit しない）。話している途中の音声と先読みの無音も捨て、取り消したあとの声は新しい発話として始まる
     */
    discard() {
      discardedUpTo = nextId;
      clearTimeout(stallTimer); stallTimer = null;
      abortSpec();
      if (live) { live.final = true; live.abort.abort(); live = null; }
      cutter.reset();
      updateSpeaking();
    },
    /** 閉じる。送っている途中のものは捨てる（先に区切った発話の確定は finish() してから order を待つ） */
    async drain() { await order; },
    close() {
      closed = true;
      clearTimeout(stallTimer);
      abortSpec();
      live?.abort.abort();
    },
    speaking: () => cutter.speaking(),
  };
}
