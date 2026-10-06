// 通話の本体（状態機械）。録音・送信ゲート・接続・再生をつなぎ、画面の部品へイベントを出す。画面（DOM）は触らない。docs/voice-call.md「クライアント」。
//
// 状態（state）は次の優先順で決まる:
//   off → starting（マイクの許可・接続の準備。まだ「聞いています」と偽らない）
//   speaking   読み上げが鳴っている・順番待ち（話して止める（barge）が効くときは、マイクは聞いている。bargeActive）
//   hearing    自分の声を聞き取っている（クライアントの音量で。ミュート中は出ない）
//   hold       まとめ待ち: 話した言葉を溜めていて、最後の声から待ち時間が過ぎる（または確定が出そろう）まで。「考え中」にはしない（承認済み 2026-10-07）
//   thinking   発言を送ってから最初の音（またはターンの終わり）まで
//   listening  それ以外
// 読み上げ中の扱い（承認済み 2026-10-07）:
//   話して止める（設定 bargeIn が入っていて、エコー除去が効いている）: 読み上げ中もマイクを聞き、読み上げ用の高い閾値（通常の 3 倍）を約 250ms 超えたら読み上げを止める。
//     止める前の約 0.6 秒は先に持っておき、止めたら頭から送る（話し始めが欠けない）。
//   それ以外（半二重）: 読み上げ中とその後 300ms は、マイクの音声を送らない（スピーカーの音を自分の発言と取り違えて送らないため）。
// ミュートは音声フレームを送らないだけで、トラックは止めない（止めると録音中の表示が消えて再開が遅い）。通話を終えるとトラックを止める。
//
// 確定した言葉はここで 1 通にまとめる（web/voice/turn-hold.mjs）。送る時が来たら turn を出し、画面（index.mjs）が会話へ送る。
//
// events（subscribe）: { type: 'state' } / { type: 'partial' | 'final' | 'drop', utt, text? } / { type: 'hold', view }（まとめ待ちの組み立て中の文・残り時間）/
//   { type: 'turn', text }（まとめて 1 通を送る）/ { type: 'turn.discard' }（言いよどみだけだった）/ { type: 'barge', id }（話して読み上げを止めた）/ { type: 'halt', id }（止めるボタン）/
//   { type: 'seg', id, text, first, skip? } / { type: 'segstart' | 'segend' | 'segfail', id } /
//   { type: 'cancel' } / { type: 'turnEnd', spoke } / { type: 'notice', code } / { type: 'ended', reason } / { type: 'lat', ... }
import { createCapture } from './capture.mjs';
import { createLink } from './link.mjs';
import { createPlayer } from './player.mjs';
import { createSendGate } from './send-gate.mjs';
import { createTurnHold } from './turn-hold.mjs';

const ECHO_TAIL_MS = 300;          // 半二重のとき、読み上げが終わってから聞き始めるまで（スピーカーの残響）
const HEARING_HOLD_MS = 350;       // 最後の声のフレームから、聞き取り中の表示を続ける長さ
const HEARING_MIN_FRAMES = 2;      // 声のフレームがこれだけ続いたら聞き取り中（物音の一瞬で円を広げない）
const READY_TIMEOUT_MS = 12000;
const REPLY_WAIT_MAX_MS = 30 * 60_000;
const VOICE_THRESHOLD = 0.012;
export const BARGE_THRESHOLD = VOICE_THRESHOLD * 3;   // 読み上げ中の閾値。スピーカーの音が回り込んでも（エコー除去のあと）超えない高さ
export const BARGE_MS = 250;                           // この長さ（声の区間の積算）で割り込みとみなす。1 フレーム（約 85ms）の途切れは次の声で取り戻せる
const BARGE_RING_MS = 600;                             // 止める前に持っておく長さ（止めたら頭から送る）
const TURN_TICK_MS = 100;

/** parts: テストが録音・接続・再生を偽物に替える口（既定は本物） */
export function createCallEngine({ token, now = () => performance.now(), AudioContextImpl = globalThis.AudioContext, WebSocketImpl, parts = {} }) {
  const make = { createCapture, createLink, createPlayer, ...parts };
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) { try { fn(event); } catch (e) { console.error(e); } } };

  let ctx = null, capture = null, link = null, player = null, tick = null;
  let starting = false, active = false;
  let muted = false, speakerMuted = false, denied = null;
  let startedAt = 0, seq = 0;
  let awaitingReply = false, replySince = 0;
  let hearingUntil = 0, voicedRun = 0, halfUntil = 0, micLevel = 0, lastFinalAt = 0, latSent = true;
  let bargeConfigured = false, echoOn = true, bargeMs = 0, bargeRing = [], lastSegId = null;
  const gate = createSendGate();
  const hold = createTurnHold();
  let holdSig = '';
  let shown = 'off';

  /** 話して止める: 設定が入っていて、エコー除去が効いていて、スピーカーが生きている */
  const bargeArmed = () => bargeConfigured && echoOn && !speakerMuted && !muted;
  /** まとめ待ち: 溜めた言葉がある・ホストが文字を出している最中 */
  const holding = () => !muted && hold.active && (hold.busy || hold.view(now()).text !== '');

  const compute = () => {
    if (!active) return starting ? 'starting' : 'off';
    if (player?.busy()) return 'speaking';
    if (!muted && now() < hearingUntil) return 'hearing';
    if (holding()) return 'hold';
    if (awaitingReply) return 'thinking';
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
    if (player?.busy()) {
      if (bargeArmed()) { listenForBarge(frame, t); return; }
      halfUntil = t + ECHO_TAIL_MS;   // 半二重: 読み上げの間とその後は送らない
    } else { bargeMs = 0; bargeRing = []; }
    if (t < halfUntil) { gate.reset(); voicedRun = 0; return; }
    if (muted) return;
    if (frame.rms >= VOICE_THRESHOLD) { voicedRun++; hold.voice(t); if (voicedRun >= HEARING_MIN_FRAMES) hearingUntil = t + HEARING_HOLD_MS; } else voicedRun = 0;
    for (const pcm of gate.push(frame)) link.sendAudio(pcm);
    pumpHold();
  }

  /** 読み上げ中のフレーム。高い閾値を超えた声が BARGE_MS 続いたら、読み上げを止めて聞き取りへ移る */
  function listenForBarge(frame, t) {
    bargeRing.push(frame);
    let ringMs = bargeRing.reduce((sum, f) => sum + f.ms, 0);
    while (bargeRing.length > 1 && ringMs - bargeRing[0].ms >= BARGE_RING_MS) ringMs -= bargeRing.shift().ms;
    bargeMs = frame.rms >= BARGE_THRESHOLD ? bargeMs + frame.ms : Math.max(0, bargeMs - frame.ms);
    if (bargeMs >= BARGE_MS) fireBarge(t);
  }

  function fireBarge(t) {
    const id = player?.position?.()?.id ?? lastSegId;
    const lead = bargeRing;
    bargeRing = []; bargeMs = 0;
    player.cancel();
    link.send({ t: 'barge', ...(id !== null && id !== undefined ? { id } : {}) });
    halfUntil = 0; gate.reset(); voicedRun = HEARING_MIN_FRAMES; hearingUntil = t + HEARING_HOLD_MS;
    // 止める前に持っていた分を頭から通す（ゲートは最初の声のフレームで、直前の約 0.3 秒つきで開く）
    for (const f of lead) {
      if (f.rms >= VOICE_THRESHOLD) hold.voice(t);
      for (const pcm of gate.push(f)) link.sendAudio(pcm);
    }
    emit({ type: 'barge', id: id ?? null });
    refresh();
  }

  const onJson = (msg) => {
    switch (msg.t) {
      case 'ready':
        if (Number.isFinite(msg.turnHoldMs) && msg.turnHoldMs > 0) hold.setHold(msg.turnHoldMs);
        bargeConfigured = msg.bargeIn !== false;
        readyResolve?.(msg);
        break;
      case 'error':
        if (msg.fatal) { readyReject?.(Object.assign(new Error(msg.code), { code: msg.code })); if (active) finish(`error:${msg.code}`); }
        else { if (Number.isInteger(msg.utt)) { hold.drop(msg.utt); pumpHold(); } emit({ type: 'notice', code: msg.code }); }
        break;
      case 'limit': emit({ type: 'notice', code: `limit-${msg.reason}` }); finish(`limit-${msg.reason}`); break;
      case 'speaking': break;
      case 'busy': hold.setBusy(msg.on === true, now(), msg.last); pumpHold(); break;
      case 'partial': hold.partial(msg.utt, msg.text); emit({ type: 'partial', utt: msg.utt, text: msg.text }); pumpHold(); break;
      case 'final':
        lastFinalAt = now(); latSent = false;
        hold.final(msg.utt, msg.text);
        emit({ type: 'final', utt: msg.utt, text: msg.text, speechEndToFinalMs: msg.speechEndToFinalMs, degraded: msg.degraded });
        pumpHold();
        break;
      case 'drop': hold.drop(msg.utt); emit({ type: 'drop', utt: msg.utt }); pumpHold(); break;
      case 'seg': player.seg(msg.id, msg); emit({ type: 'seg', id: msg.id, text: msg.text, first: msg.first, skip: msg.skip }); break;
      case 'seg.end': player.end(msg.id); break;
      case 'seg.fail': player.fail(msg.id); break;
      case 'cancel': player.cancel(); lastSegId = null; break;
      case 'turn.end': awaitingReply = false; emit({ type: 'turnEnd', spoke: msg.spoke }); break;
      case 'lat': emit({ type: 'lat', ...msg }); break;
    }
    refresh();
  };

  /** まとめ待ちを進める: 時が来たら 1 通として出し、組み立て中の文・残り時間が変わったら hold を出す */
  function pumpHold() {
    if (!active) return;
    const t = now();
    const res = hold.tick(t);
    // 送る・捨てる合図を先に出す（画面が吹き出しを「送る」の姿に替えてから、空になった組み立て中の文を受ける）
    if (res?.send) emit({ type: 'turn', text: res.send });
    else if (res?.discard) emit({ type: 'turn.discard' });
    const view = hold.view(t);
    const sig = `${view.active}|${view.final}|${view.partial}|${view.voicing}|${view.waiting}|${Math.round(view.fraction * 50)}`;
    if (sig !== holdSig) { holdSig = sig; emit({ type: 'hold', view }); }
    refresh();
  }

  const onPlayer = (event) => {
    if (event.type === 'segstart') {
      lastSegId = event.id;
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
    awaitingReply = false;
    hearingUntil = voicedRun = halfUntil = 0;
    micLevel = 0;
    bargeConfigured = false; bargeMs = 0; bargeRing = []; lastSegId = null; holdSig = '';
    hold.reset();
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
      echoOn = echoCancellation !== false;
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
          pumpHold();
          refresh();
          if (awaitingReply && now() - replySince > REPLY_WAIT_MAX_MS) { awaitingReply = false; refresh(); }
        }, TURN_TICK_MS);
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
      gate.reset(); voicedRun = 0; hearingUntil = 0; bargeMs = 0; bargeRing = [];
      if (muted) hold.sendNow();   // ミュートはホストが今の発話を確定させる。溜めた言葉は、確定が出そろったらすぐ送る
      link.send({ t: 'mute', on: muted });
      pumpHold();
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
    /** 読み上げを止める（このターンの残りは、続きを読む（resume）まで読まない）。話して割り込むのは barge（同じ扱い） */
    halt() {
      if (!active) return;
      const id = player.position?.()?.id ?? lastSegId;
      player.cancel();
      link.send({ t: 'halt', ...(id !== null && id !== undefined ? { id } : {}) });
      emit({ type: 'halt', id: id ?? null });
      refresh();
    },
    /** 止めた場所から読み直す（ホストが止めた文と、止めている間に届いた文を読む） */
    resume() { if (active) link.send({ t: 'resume' }); },
    /** まとめ待ちを待たずに送る（確定が出そろうのは待つ） */
    sendNow() { if (!active) return; hold.sendNow(); pumpHold(); },
    /** まとめ待ちの言葉を捨てる（送らない） */
    cancelTurn() { if (!active) return; hold.cancel(); holdSig = ''; emit({ type: 'hold', view: hold.view(now()) }); refresh(); },
    /** 話して止める（barge）が、いま効いているか */
    get bargeActive() { return active && bargeArmed(); },
    /** まとめ待ちの区切りの長さ（ms） */
    get holdMs() { return hold.holdMs; },
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
