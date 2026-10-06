// 通話 1 本の状態（/voice-ws の 1 接続）。docs/voice-call.md「構成」「プロトコル」。
//
// 上り（クライアント → ホスト）
//   バイナリ        16kHz s16le モノラルの音声フレーム（クライアントの送信ゲートを通ったもの）
//   { t: 'hello', target }        通話を始める。target = { kind: 'chat', sessionId } か { kind: 'thread', channelId, threadId }。キー・上限を確かめて ready を返す
//   { t: 'target', target }       見ている会話・スレッドが変わった（新しい会話の最初のターンで会話の id が決まったとき）
//   { t: 'mute', on }             マイクのミュート（いま話している分は確定させる。音声フレームは送らない）
//   { t: 'spk', on }              スピーカーのミュート（読み上げを止め、合成も頼まない。解除すると次の文から）
//   { t: 'halt', id? }            読み上げを止める（このターンの残りは「続きを読む」まで読まない）。barge は話して割り込んだとき（同じ扱い）。id = 止めたとき鳴っていた文（resume の始まり）
//   { t: 'resume' }               止めた場所から読み直す（止めた文と、止めている間に届いた文）。新しい発言が来るまで使える
//   { t: 'lat', sinceFinalMs }    クライアントが測った「確定を受けてから最初の音が鳴るまで」（ログ・開発用の表示のため）
// 下り（ホスト → クライアント）
//   JSON  ready { sttModel, ttsModel, rate, limits, turnHoldMs, bargeIn } / error { code, fatal? } / limit { reason } / speaking { on } / busy { on, last }（文字がまだ出そろっていない。まとめ待ちが送るのを待つ。last = 振った発話の番号の最大）/
//         partial { utt, text } / final { utt, text, ... } / drop { utt }
//         seg { id, text, first, skip? }（読む文の始まり。音より先）/ seg.end { id, audioMs, partial? } / seg.fail { id } / cancel（再生中・順番待ちの音を捨てる）
//         turn.end { spoke }（返事のターンが終わった。読んだ文が無ければ spoke: false）/ lat { ... }（遅延の内訳）
//   バイナリ  [BINARY_AUDIO(1 バイト)][文の id(uint32 LE)][PCM 24kHz s16le]
//
// エージェントの出来事（text.delta・text.end・userMessage・turnEnd）は host.mjs が、この通話が見ている会話の分だけ onAgentEvent に渡す。
// 遅延の測り方（docs/voice-call.md）: 声の終わり → 確定（speechEndToFinalMs）、確定 → 最初の文が閉じる → 最初の音（finalToFirstAudioMs と内訳）をログ（voice.latency）と lat で出す。
import { createSttClient, createTranscriber } from './stt.mjs';
import { createReplyReader } from './reply-reader.mjs';
import { createSpeaker } from './speaker.mjs';
import { createTtsClient, TTS_SAMPLE_RATE } from './tts.mjs';
import { languageOf, turnHoldMsOf } from './settings.mjs';

export const BINARY_AUDIO = 1;
const IDLE_END_MS = 10 * 60_000;   // 聞き取った言葉も読み上げも無いまま、つけっぱなしで放っておかれた通話はこの時間で終える
const TICK_MS = 5000;
const MAX_JSON_BYTES = 64 * 1024;
const HELD_MAX = 40;       // 止めている間に届いた文を、続きを読むために覚えておく数（1 ターンの読み上げの上限 1500 字に対して十分）

const targetOf = (raw) => {
  if (raw?.kind === 'thread' && typeof raw.channelId === 'string' && typeof raw.threadId === 'string') return { kind: 'thread', channelId: raw.channelId, threadId: raw.threadId };
  if (raw?.kind === 'chat') return { kind: 'chat', sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null };
  return null;
};

/**
 * @param {object} d
 * @param {(o: object) => void} d.send  JSON を送る
 * @param {(b: Buffer) => void} d.sendBinary
 * @param {() => void} d.close  接続を閉じる
 * @param {() => Promise<{ settings: object, config: object|null, uiLang: string, phrases: object, usage: object, todayCallSeconds: number }>} d.hello  通話の開始のときに引く（キーが無ければ config は null）
 * @param {(line: string, fields?: object) => void} [d.log]
 * @param {{ stt?: object, tts?: object }} [d.clients]  テスト用の差し替え
 */
export function createVoiceSession({ send, sendBinary, close, hello, log = () => {}, now = Date.now, clients = {}, idleEndMs = IDLE_END_MS, tickMs = TICK_MS, onTarget = () => {} }) {
  let ctx = null;            // hello で引いたもの
  let stt = null, speaker = null, reader = null;
  let target = null;
  let started = false, closed = false;
  let muted = false, spkMuted = false, halted = false;
  let spoken = [];           // このターンに読みに出した文 { id, text, info }（止めたあと「続きを読む」で読み直す）
  let held = [];             // 止めている間に届いた、まだ読んでいない文 { text, info }
  let cutId = null;          // 止めたとき鳴っていた文の id（読み直しの始まり）。分からなければ null（最後に出した文から）
  let turnSpoke = false;
  let lat = null;            // いまのターンの遅延の内訳
  let callMs = 0, lastTick = 0, lastActivityAt = 0, timer = null;

  const speak = (text, info) => {
    if (spkMuted || closed) return;
    if (halted) { if (held.length < HELD_MAX) held.push({ text, info }); return; }
    turnSpoke = true;
    lastActivityAt = now();
    if (lat && !lat.firstSentenceAt) lat.firstSentenceAt = now();
    const id = speaker.speak(text, { first: info.first, ...(info.skip ? { skip: info.skip } : {}) });
    if (id !== null && spoken.length < HELD_MAX * 2) spoken.push({ id, text, info });
  };

  /** 止める（ボタン・話して割り込む）。止めた文と、まだ読んでいない文は覚えておき、resume で読み直せる */
  const halt = (id) => {
    halted = true;
    cutId = Number.isInteger(id) ? id : null;
    speaker.cancel();
    send({ t: 'cancel' });
  };

  /** 止めた場所から読み直す。止めた文（分からなければ最後に出した文）から、止めている間に届いた文まで */
  const resume = () => {
    if (!halted) return;
    const from = cutId ?? spoken.at(-1)?.id ?? 0;
    const again = [...spoken.filter((s) => s.id >= from), ...held];
    spoken = spoken.filter((s) => s.id < from);
    held = [];
    halted = false;
    cutId = null;
    again.forEach((s, i) => speak(s.text, { ...s.info, first: i === 0 && s.info.first }));
  };

  const markAudioSent = () => {
    if (!lat || lat.firstAudioAt) return;
    lat.firstAudioAt = now();
    const out = {
      speechEndToFinalMs: lat.speechEndToFinalMs ?? null,
      finalToFirstTextMs: lat.firstTextAt ? lat.firstTextAt - lat.finalAt : null,
      firstTextToSentenceMs: lat.firstTextAt && lat.firstSentenceAt ? lat.firstSentenceAt - lat.firstTextAt : null,
      sentenceToFirstAudioMs: lat.firstSentenceAt ? lat.firstAudioAt - lat.firstSentenceAt : null,
      finalToFirstAudioMs: lat.firstAudioAt - lat.finalAt,
      sttModel: lat.sttModel ?? null, sttRoute: lat.route ?? null, speculative: Boolean(lat.speculative),
    };
    log('voice.latency', out);
    send({ t: 'lat', ...out });
  };

  const setup = async (msg) => {
    ctx = await hello();
    if (closed) return;
    if (!ctx.config && !(clients.stt && clients.tts)) { send({ t: 'error', code: 'no-key', fatal: true }); close(); return; }
    const { settings, uiLang, phrases, usage } = ctx;
    const limit = settings.dailyLimitMinutes * 60;
    if (ctx.todayCallSeconds >= limit) { send({ t: 'error', code: 'daily-limit', fatal: true }); close(); return; }
    const language = languageOf(settings, uiLang);
    const sttClient = clients.stt ?? createSttClient({ config: ctx.config, model: settings.sttModel, fallbackModel: settings.sttFallbackModel, language, now, log,
      onSeconds: (sttSeconds) => { usage.add({ sttSeconds }).catch(() => {}); } });
    const ttsClient = clients.tts ?? createTtsClient({ config: ctx.config, model: settings.ttsModel, voice: settings.ttsVoice, now, log });
    stt = createTranscriber({ client: sttClient, language, now, log, emit: onStt });
    speaker = createSpeaker({
      tts: ttsClient, log,
      send: {
        seg: (id, text, meta) => send({ t: 'seg', id, text, ...meta }),
        chunk: (id, bytes) => {
          const frame = Buffer.allocUnsafe(5 + bytes.length);
          frame[0] = BINARY_AUDIO;
          frame.writeUInt32LE(id, 1);
          frame.set(bytes, 5);
          markAudioSent();
          sendBinary(frame);
        },
        end: (id, info) => send({ t: 'seg.end', id, ...info }),
        fail: (id, reason) => send({ t: 'seg.fail', id, reason }),
      },
      onMetric: (m) => { usage.add({ ttsChars: m.chars }).catch(() => {}); },
    });
    reader = createReplyReader({ say: speak, phrases });
    target = targetOf(msg.target);
    started = true;
    lastTick = lastActivityAt = now();
    timer = setInterval(tick, tickMs);
    timer.unref?.();
    onTarget(target);
    send({ t: 'ready', sttModel: settings.sttModel, ttsModel: settings.ttsModel, rate: ttsClient.sampleRate ?? TTS_SAMPLE_RATE,
      turnHoldMs: turnHoldMsOf(settings), bargeIn: settings.bargeIn !== false,
      limits: { callMinutes: settings.maxCallMinutes, dailyMinutes: settings.dailyLimitMinutes, usedTodaySeconds: Math.round(ctx.todayCallSeconds) } });
    log('voice.start', { target: target?.kind ?? null, sttModel: settings.sttModel, ttsModel: settings.ttsModel });
  };

  const onStt = (ev) => {
    if (closed) return;
    switch (ev.type) {
      case 'speaking': send({ t: 'speaking', on: ev.on }); break;
      case 'busy': send({ t: 'busy', on: ev.on, last: ev.last }); break;
      case 'partial': send({ t: 'partial', utt: ev.utt, text: ev.text }); break;
      case 'drop': send({ t: 'drop', utt: ev.utt }); break;
      case 'final':
        lastActivityAt = now();
        lat = { finalAt: now(), speechEndToFinalMs: ev.speechEndToFinalMs, sttModel: ev.model, route: ev.route, speculative: ev.speculative };
        log('voice.final', { utt: ev.utt, chars: ev.text.length, reason: ev.reason, audioMs: ev.audioMs ?? null, sttTookMs: ev.tookMs ?? null, speechEndToFinalMs: ev.speechEndToFinalMs, model: ev.model, route: ev.route, speculative: ev.speculative, degraded: ev.degraded ?? false });
        send({ t: 'final', utt: ev.utt, text: ev.text, speechEndToFinalMs: ev.speechEndToFinalMs, ...(ev.degraded ? { degraded: true } : {}) });
        break;
      case 'error': send({ t: 'error', code: ev.rateLimited ? 'stt-busy' : 'stt', utt: ev.utt }); break;
    }
  };

  function tick() {
    if (closed || !started) return;
    const t = now();
    const delta = t - lastTick;
    lastTick = t;
    callMs += delta;
    ctx.usage.add({ callSeconds: delta / 1000 }).catch(() => {});
    const reason = callMs >= ctx.settings.maxCallMinutes * 60_000 ? 'call'
      : ctx.todayCallSeconds + callMs / 1000 >= ctx.settings.dailyLimitMinutes * 60 ? 'daily'
      : t - lastActivityAt >= idleEndMs ? 'idle' : null;
    if (reason) { send({ t: 'limit', reason }); log('voice.limit', { reason }); end(); close(); }
  }

  function end() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (started) {
      // 最後の tick から終わりまでの端数を台帳へ
      ctx.usage.add({ callSeconds: Math.max(0, (now() - lastTick) / 1000) }).catch(() => {});
      ctx.usage.flush?.().catch(() => {});
    }
    stt?.close();
    speaker?.close();
  }

  return {
    get target() { return target; },
    get active() { return started && !closed; },
    /** 受け取ったメッセージ（ws の message）。バイナリは音声、文字は JSON */
    async onMessage(data, isBinary) {
      if (closed) return;
      if (isBinary) {
        if (!started || muted) return;
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.length);
        stt.push(bytes);
        return;
      }
      if (data.length > MAX_JSON_BYTES) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg?.t) {
        case 'hello': if (!started && !ctx) await setup(msg).catch((e) => { log('voice.start_failed', { error: String(e?.message ?? e).slice(0, 200) }); if (!closed) { send({ t: 'error', code: 'start', fatal: true }); close(); } }); break;
        case 'target': if (started) { target = targetOf(msg.target) ?? target; onTarget(target); } break;
        case 'mute': if (started) { muted = msg.on === true; if (muted) stt.finish(); } break;
        case 'spk': if (started) { spkMuted = msg.on === true; if (spkMuted) { speaker.cancel(); send({ t: 'cancel' }); } } break;
        case 'halt': case 'barge': if (started) halt(msg.id); break;
        case 'resume': if (started) resume(); break;
        case 'lat': if (lat && Number.isFinite(msg.sinceFinalMs)) log('voice.latency_client', { finalToSoundMs: Math.round(msg.sinceFinalMs), speechEndToFinalMs: lat.speechEndToFinalMs ?? null }); break;
      }
    },
    /** この通話が見ている会話の出来事（host.mjs が選んで渡す） */
    onAgentEvent(ev) {
      if (!started || closed) return;
      switch (ev.type) {
        case 'userMessage':
          reader.reset(); speaker.cancel(); halted = false; turnSpoke = false; spoken = []; held = []; cutId = null;
          send({ t: 'cancel' });
          break;
        case 'text.delta':
          if (lat && !lat.firstTextAt) lat.firstTextAt = now();
          reader.push(ev.text);
          break;
        case 'text.end': reader.end(); break;
        case 'turnEnd': reader.end(); send({ t: 'turn.end', spoke: turnSpoke }); break;
      }
    },
    /** この見ている先に、あとから加わった会話（新しい会話の id）の分を受けるため、見ている先を更新する */
    setTarget(next) { target = targetOf(next) ?? target; onTarget(target); },
    close() { end(); },
    /** テスト・診断用 */
    get state() { return { muted, spkMuted, halted, callMs }; },
  };
}
