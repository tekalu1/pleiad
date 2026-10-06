// 通話の本体（状態機械）。録音・送信ゲート・接続・再生をつなぎ、画面の部品へイベントを出す。画面（DOM）は触らない。docs/voice-call.md「クライアント」。
//
// 状態（state）は次の優先順で決まる:
//   off → starting（マイクの許可・接続の準備。まだ「聞いています」と偽らない）
//   speaking   読み上げが鳴っている・順番待ち
//   hearing    自分の声を聞き取っている（クライアントの音量で。ミュート中は出ない）
//   thinking   声を区切ってから確定まで、または発言を送ってから最初の音（またはターンの終わり）まで
//   listening  それ以外
// 読み上げ中とその後 700ms は、マイクの音声を送らない（半二重。スピーカーの音を自分の発言と取り違えて送らないため。話して割り込むのは 2 段目）。
// ミュートは音声フレームを送らないだけで、トラックは止めない（止めると録音中の表示が消えて再開が遅い）。通話を終えるとトラックを止める。
//
// events（subscribe）: { type: 'state' } / { type: 'partial' | 'final' | 'drop', utt, text? } / { type: 'seg', id, text, first, skip? } / { type: 'segstart' | 'segend' | 'segfail', id } /
//   { type: 'cancel' } / { type: 'turnEnd', spoke } / { type: 'notice', code } / { type: 'ended', reason } / { type: 'lat', ... }
import { createCapture } from './capture.mjs';
import { createLink } from './link.mjs';
import { createPlayer } from './player.mjs';
import { createSendGate } from './send-gate.mjs';

const ECHO_TAIL_MS = 700;
const HEARING_HOLD_MS = 350;       // 最後の声のフレームから、聞き取り中の表示を続ける長さ
const HEARING_MIN_FRAMES = 2;      // 声のフレームがこれだけ続いたら聞き取り中（物音の一瞬で円を広げない）
const READY_TIMEOUT_MS = 12000;
const REPLY_WAIT_MAX_MS = 30 * 60_000;
const VOICE_THRESHOLD = 0.012;

/** parts: テストが録音・接続・再生を偽物に替える口（既定は本物） */
export function createCallEngine({ token, now = () => performance.now(), AudioContextImpl = globalThis.AudioContext, WebSocketImpl, parts = {} }) {
  const make = { createCapture, createLink, createPlayer, ...parts };
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) { try { fn(event); } catch (e) { console.error(e); } } };

  let ctx = null, capture = null, link = null, player = null, tick = null;
  let starting = false, active = false;
  let muted = false, speakerMuted = false, denied = null;
  let startedAt = 0, seq = 0;
  let serverSpeaking = false, awaitingFinal = false, awaitingReply = false, replySince = 0;
  let hearingUntil = 0, voicedRun = 0, halfUntil = 0, micLevel = 0, lastFinalAt = 0, latSent = true;
  const gate = createSendGate();
  let shown = 'off';

  const compute = () => {
    if (!active) return starting ? 'starting' : 'off';
    if (player?.busy()) return 'speaking';
    if (!muted && now() < hearingUntil) return 'hearing';
    if (awaitingFinal || awaitingReply) return 'thinking';
    return 'listening';
  };
  const refresh = () => {
    const next = compute();
    if (next !== shown) { shown = next; emit({ type: 'state' }); }
  };

  function onFrame(frame) {
    if (!active) return;
    const t = now();
    micLevel = Math.max(frame.rms * 8 > 1 ? 1 : frame.rms * 8, micLevel * 0.72);
    if (player?.busy()) halfUntil = t + ECHO_TAIL_MS;
    if (t < halfUntil) { gate.reset(); voicedRun = 0; return; }   // 半二重: 読み上げの間とその後は送らない
    if (muted) return;
    if (frame.rms >= VOICE_THRESHOLD) { voicedRun++; if (voicedRun >= HEARING_MIN_FRAMES) hearingUntil = t + HEARING_HOLD_MS; } else voicedRun = 0;
    for (const pcm of gate.push(frame)) link.sendAudio(pcm);
    refresh();
  }

  const onJson = (msg) => {
    switch (msg.t) {
      case 'ready': readyResolve?.(msg); break;
      case 'error':
        if (msg.fatal) { readyReject?.(Object.assign(new Error(msg.code), { code: msg.code })); if (active) finish(`error:${msg.code}`); }
        else emit({ type: 'notice', code: msg.code });
        break;
      case 'limit': emit({ type: 'notice', code: `limit-${msg.reason}` }); finish(`limit-${msg.reason}`); break;
      case 'speaking': serverSpeaking = msg.on === true; if (serverSpeaking) awaitingFinal = true; break;
      case 'partial': emit({ type: 'partial', utt: msg.utt, text: msg.text }); break;
      case 'final':
        awaitingFinal = false; lastFinalAt = now(); latSent = false;
        emit({ type: 'final', utt: msg.utt, text: msg.text, speechEndToFinalMs: msg.speechEndToFinalMs, degraded: msg.degraded });
        break;
      case 'drop': awaitingFinal = false; emit({ type: 'drop', utt: msg.utt }); break;
      case 'seg': player.seg(msg.id, msg); emit({ type: 'seg', id: msg.id, text: msg.text, first: msg.first, skip: msg.skip }); break;
      case 'seg.end': player.end(msg.id); break;
      case 'seg.fail': player.fail(msg.id); break;
      case 'cancel': player.cancel(); break;
      case 'turn.end': awaitingReply = false; emit({ type: 'turnEnd', spoke: msg.spoke }); break;
      case 'lat': emit({ type: 'lat', ...msg }); break;
    }
    refresh();
  };

  const onPlayer = (event) => {
    if (event.type === 'segstart') {
      awaitingReply = false;
      if (!latSent && lastFinalAt) { latSent = true; const sinceFinalMs = now() - lastFinalAt; link?.send({ t: 'lat', sinceFinalMs }); emit({ type: 'lat', soundMs: Math.round(sinceFinalMs) }); }
    }
    if (event.type === 'segfail') emit({ type: 'notice', code: 'tts' });
    emit(event);
    refresh();
  };

  let readyResolve = null, readyReject = null;

  function cleanup() {
    clearInterval(tick); tick = null;
    capture?.stop().catch(() => {});
    player?.close();
    link?.close();
    ctx?.close().catch(() => {});
    capture = player = link = ctx = null;
    active = starting = false;
    muted = speakerMuted = false;
    serverSpeaking = awaitingFinal = awaitingReply = false;
    hearingUntil = voicedRun = halfUntil = 0;
    micLevel = 0;
    gate.reset();
  }

  function finish(reason) {
    if (!active && !starting) return;
    cleanup();
    refresh();
    emit({ type: 'ended', reason });
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get state() { return shown; },
    get muted() { return muted; },
    get speakerMuted() { return speakerMuted; },
    /** マイクが使えなかった理由（denied・no-device・busy・unavailable）。通話が始まれば null に戻る */
    get denied() { return denied; },
    get startedAt() { return startedAt; },
    get active() { return active || starting; },

    /**
     * 通話を始める。ユーザーの操作（クリック）の中で呼ぶ（AudioContext の解錠）。
     * @param {object} target { kind: 'chat', sessionId } | { kind: 'thread', channelId, threadId }
     * @param {{ echoCancellation?: boolean }} [opts]
     * @returns {Promise<boolean>} 始まったら true。マイクが許可されない・キーが無いなどは false（理由は denied と notice）
     */
    async start(target, { echoCancellation = true } = {}) {
      if (active || starting) finish('restart');
      const mine = ++seq;
      denied = null;
      starting = true;
      refresh();
      try {
        // AudioContext は通話の開始時に作って resume しておく（最初の音で作ると遅れる・ブロックされる）
        ctx = new AudioContextImpl({ latencyHint: 'interactive' });
        if (ctx.state === 'suspended') await ctx.resume();
        player = make.createPlayer({ context: ctx, onEvent: onPlayer });
        capture = make.createCapture({ context: ctx, echoCancellation, onFrame });
        link = make.createLink({ token, WebSocketImpl, onJson, onAudio: (id, bytes) => player?.chunk(id, bytes),
          onClose: () => { if (active || starting) { emit({ type: 'notice', code: 'link' }); finish('link'); } } });
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve; readyReject = reject;
          setTimeout(() => reject(Object.assign(new Error('ready timeout'), { code: 'timeout' })), READY_TIMEOUT_MS);
        });
        ready.catch(() => {});
        // マイクの許可の確認（人が答えるまで待つ）と接続は並行して進める
        await Promise.all([capture.start(), link.connect()]);
        if (mine !== seq) return false;
        link.send({ t: 'hello', target });
        await ready;
        if (mine !== seq) return false;
        active = true;
        starting = false;
        startedAt = Date.now();
        shown = 'starting';
        tick = setInterval(() => {
          refresh();
          if (awaitingReply && now() - replySince > REPLY_WAIT_MAX_MS) { awaitingReply = false; refresh(); }
        }, 100);
        refresh();
        emit({ type: 'started' });
        return true;
      } catch (e) {
        if (mine !== seq) return false;
        const code = e?.reason ?? e?.code ?? 'unavailable';
        if (['denied', 'no-device', 'busy'].includes(code)) denied = code;
        else emit({ type: 'notice', code: code === 'timeout' ? 'start-timeout' : code === 'no-key' || code === 'daily-limit' ? code : 'start' });
        cleanup();
        shown = 'off';
        emit({ type: 'state' });
        return false;
      }
    },
    end(reason = 'user') { seq++; finish(reason); },
    setMuted(on) {
      if (!active || muted === Boolean(on)) return;
      muted = Boolean(on);
      gate.reset(); voicedRun = 0; hearingUntil = 0;
      link.send({ t: 'mute', on: muted });
      refresh();
      emit({ type: 'state' });
    },
    setSpeakerMuted(on) {
      if (!active || speakerMuted === Boolean(on)) return;
      speakerMuted = Boolean(on);
      if (speakerMuted) player.cancel();
      link.send({ t: 'spk', on: speakerMuted });
      refresh();
      emit({ type: 'state' });
    },
    /** 読み上げを止める（このターンの残りは読まない）。話して割り込む 2 段目は、ここと同じ口（halt / barge）を使う */
    halt() { if (!active) return; player.cancel(); link.send({ t: 'halt' }); refresh(); },
    /** 見ている会話・スレッドが変わった（新しい会話の id が決まった）。通話の宛先は変えず、読み上げる会話の対象だけを更新する */
    setTarget(target) { if (active) link.send({ t: 'target', target }); },
    /** 確定した発言を、画面が会話へ送った（送れなかったら ok: false）。送れたら、最初の音かターンの終わりまで「考え中」 */
    noteSent(ok) {
      if (!active) return;
      awaitingReply = Boolean(ok);
      replySince = now();
      refresh();
    },
    levels() { return { mic: muted ? 0 : micLevel, out: player ? player.level() : 0 }; },
    position() { return player?.position() ?? null; },
    /** テスト・診断用 */
    get audioContext() { return ctx; },
  };
}
