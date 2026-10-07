// 通話モードの画面側の入口（承認済み 2026-10-06。docs/design-system.md「通話モード」、docs/voice-call.md）。
//
// 通話の機能はこのディレクトリ（web/voice/）と core/voice/ に閉じている。入力欄・会話（スレッド）の頭・メインの面へは、
// 「部品を差し込む口」1 か所ずつの小さな配線だけで繋ぐ。口の契約は mount(slot) の slot（下）。入力欄や頭を作り直したら、この slot を作る所だけを付け替える。
//
//   const voice = setupVoice({ token, invoke, openSettings, available })   … 1 つだけ作る（client.mjs）
//   const handle = voice.mount(slot)                                      … Chats の会話・チャンネルのスレッドのそれぞれで 1 回
//
// slot（差し込む口。Chats の会話は client.mjs、スレッドは web/channels/thread.mjs が作って渡す）:
//   id            'chat' | 'thread'（通話はどちらか 1 つの slot の中でだけ動く。別の slot の部品は通話していない姿のまま）
//   header        通話ボタンを足す入口の行（目次・git・内蔵ブラウザーの並び）。headerBefore があればその前、無ければ先頭に足す
//   composer      { root, row, before, below, refit? }  root = 入力欄の form（通話中に vc-in-call を付ける）、row = マイクとスピーカーを足す行、
//                 before = その行の中で、足す位置の直後の要素（送信ボタン）、below = 失敗の一行をその直後に置く要素（入力の箱）、
//                 refit = 行の幅の配分を取り直す（足したあとに呼ぶ。無ければ何もしない）
//   main          背景と data-vc-* を持つメインの面（position: relative。背景は中の最初の子に置く）
//   log           会話の列のスクロール要素（読んでいる場所の下線の層を中に置く）
//   overlay       「話している場所へ」を置く、位置決めされた親（log を囲む枠）
//   replyScope()  返事の本文が入っている範囲（探す範囲。log でよい）
//   tail          { place(el), rows, isRow(node), markHost(row), createRow(), persistMarks?, rowKey?(row) }  会話の列の末尾の吹き出し:
//                 place = 末尾へ置く、rows = 発言の行が足される親（本物の発言の行が現れたら声の吹き出しを外す。childList を見る）、
//                 isRow = rows の子が発言の行か、markHost = その行のマイクの印を足す所、createRow = 声の吹き出しの行 { el, body }、
//                 persistMarks = 行が描き直される場所（印を付け直す。rowKey = 行の識別子。画面を開いている間だけ覚える）。
//                 createRow・place・markHost は、聞き取れなかった行（view.mjs の createListenFail。吹き出しではなく面を塗らない 1 行）も使う（見た目は voice.css の .vc-ghost）
//   target()      見ている先 { kind: 'chat', sessionId } | { kind: 'thread', channelId, threadId } | null
//   send(text)    まとめ待ちを終えた 1 通を、いまの送信の経路（会話へは sendMessage で会話の行に置く、スレッドへは channels.post）へ。失敗したら投げる。
//                 index.mjs が直列に呼ぶ（前の送信が済むまで次を呼ばない）。入力欄は通さない。会話の id を返す口（{ sessionId, messageId }）なら、
//                 messageId が「AI に渡しました」になったとき（delivery.mjs の ply:voice-delivered）に受け取りの一言の時計を始める。何も返さない口（スレッド）は、送れた時点で渡ったとする
//   sendTo?(target, text)  通話を終えたとき、話していた会話から別の会話へ移っていた場合の送り先指定の送信（まとめ待ちの残りを、話していた会話へ）。
//                 無ければ、スレッドは channels.post、会話は送れない扱い
//   follow()      足したあと、末尾にいるなら下へ追従させる
//
// 通話は 1 度に 1 本。別の slot で始めると前の通話は終わる。見ている会話・スレッドが別のものに変わったら通話は終わる（新しい会話の id が決まっただけなら続ける）。
import { createCallEngine } from './engine.mjs';
import { createCallButton, createComposerParts, createGlow, createHint, createJump, createListenFail, createNote } from './view.mjs';
import { createNotices } from './notices.mjs';
import { createReadingMark } from './reading-mark.mjs';
import { createLiveBubble, micMark } from './live-bubble.mjs';
import { createSounds } from './sounds.mjs';
import { createSendQueue } from './send-queue.mjs';
import { t } from '../i18n.mjs';

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** 聞き取れなかった行の字（続けて 2 回目から回数と手がかり。キーが拒否されたときは 1 回目から別の文） */
function listenText({ kind, count }) {
  if (kind === 'key') return { text: t('voice.note.sttKey'), sub: t('voice.note.sttKeyHint'), settings: true };
  if (kind === 'busy') return count >= 2 ? { text: t('voice.note.sttBusyRepeat', { n: count }), sub: t('voice.note.sttBusyHint'), settings: true } : { text: t('voice.note.sttBusy') };
  return count >= 2 ? { text: t('voice.note.sttRepeat', { n: count }), sub: t('voice.note.sttRepeatHint'), settings: true } : { text: t('voice.note.stt') };
}
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const keyOf = (target) => (target ? (target.kind === 'thread' ? `thread:${target.channelId}:${target.threadId}` : `chat:${target.sessionId ?? ''}`) : '');

export function setupVoice({ token, invoke, openSettings, available = () => true, engine: injected = null, now = () => Date.now() }) {
  const engine = injected ?? createCallEngine({ token });
  const recs = new Set();
  let active = null;            // 通話中の rec
  let deniedRec = null;         // マイクを使えなかった rec（理由は deniedReason）
  let deniedReason = null;
  let startedKey = '';
  let startedTarget = null;     // 通話が見ている先（始めたとき・新しい会話の id が決まったときに更新）。終えたとき、まとめ待ちの残りをここへ送る
  let settings = { echoCancellation: true, sounds: 'off', bargeIn: true };
  const sendQueue = createSendQueue();   // 声で確定した発言を、話した順に 1 通ずつ送る直列のキュー
  // 声で送った発言が「AI に渡しました」になった（web/voice/delivery.mjs）。送る側の応答（messageId）より先に届くことがあるので、どちらが先でも突き合わせる
  const deliveredIds = new Set();
  const awaitingDelivered = new Set();
  window.addEventListener('ply:voice-delivered', (e) => {
    const id = e.detail?.messageId;
    if (!id) return;
    if (awaitingDelivered.delete(id)) engine.noteHanded();
    else { deliveredIds.add(id); if (deliveredIds.size > 200) deliveredIds.delete(deliveredIds.values().next().value); }
  });
  /** 送れた。渡ったことを知らせる（ホストの受け取りの一言の起点）。渡っていない（送信待ち・差し込み待ち）なら、渡るまで待つ */
  function noteHanded(result) {
    const id = result?.messageId;
    if (!id || deliveredIds.delete(id)) { engine.noteHanded(); return; }
    awaitingDelivered.add(id);
    if (awaitingDelivered.size > 200) awaitingDelivered.delete(awaitingDelivered.values().next().value);
  }
  let loopOn = false, clock = null, watchTimer = null;
  let said = 'off';
  let lastRec = null;           // 直近に通話していた rec（終わったあとに届く知らせを出す先）
  let noteWatch = null, micWatched = false;
  const live = document.createElement('span');
  live.className = 'vc-sr';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);
  const say = (text) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };

  const loadSettings = () => invoke('voice.status', {}).then((s) => {
    settings = { ...settings, echoCancellation: s?.settings?.echoCancellation !== false, bargeIn: s?.settings?.bargeIn !== false, sounds: s?.settings?.sounds ?? 'off' };
  }).catch(() => {});
  loadSettings();
  const sounds = createSounds({ level: () => settings.sounds, speaking: () => engine.state === 'speaking' });
  // 声で送った発言が送信待ちに入った（web/voice/delivery.mjs が会話の行に時計の一行を出したとき）: 「待ち」の音（効果音「すべて」のとき）
  window.addEventListener('ply:voice-queued', () => { if (engine.active) sounds.play('wait'); });

  const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && globalThis.AudioWorkletNode && globalThis.AudioContext);
  const usable = () => available() && supported();

  // ---- 状態の表示
  const msOf = (rec) => {
    if (active === rec && engine.active) {
      const s = engine.state;
      return engine.muted && (s === 'listening' || s === 'hearing') ? 'muted' : s;
    }
    return deniedRec === rec ? 'denied' : 'off';
  };

  function paint(rec) {
    const on = active === rec && engine.active;
    const base = msOf(rec);
    const ms = base === 'speaking' && engine.bargeActive ? 'speaking-live' : base;   // 読み上げ中でも聞いている（話すと止まる）
    const time = on ? fmtTime(Math.floor((now() - engine.startedAt) / 1000)) : '';
    rec.call.el.hidden = !usable();
    rec.call.paint({ on, time });
    const root = rec.slot.composer.root;
    const wasShown = root.classList.contains('vc-in-call') || root.classList.contains('vc-deny');
    root.classList.toggle('vc-in-call', on);
    root.classList.toggle('vc-deny', !on && deniedRec === rec);
    if (wasShown !== (on || (!on && deniedRec === rec))) rec.slot.composer.refit?.();
    const main = rec.slot.main;
    if (on) { main.setAttribute('data-vc-call', ''); main.dataset.vcCs = engine.state === 'hold' ? 'hearing' : engine.state; main.dataset.vcMute = String(engine.muted); }
    else { main.removeAttribute('data-vc-call'); delete main.dataset.vcCs; delete main.dataset.vcMute; }
    // i18n-dynamic: voice.state.
    const stateWord = ms === 'off' || ms === 'denied' ? '' : t(`voice.state.${ms === 'speaking-live' ? 'speakingLive' : ms}`);
    // i18n-dynamic: voice.mic.
    const micLabel = ms === 'denied' ? t(`voice.mic.${deniedReason === 'no-device' ? 'noDevice' : deniedReason === 'busy' ? 'busy' : 'denied'}`)
      : ms === 'off' ? t('voice.call.start')
        : ms === 'muted' ? t('voice.mic.unmute', { state: stateWord }) : t('voice.mic.mute', { state: stateWord });
    rec.parts.paintMic(ms, micLabel);
    const spkLabel = (engine.speakerMuted && on ? t('voice.spk.unmute') : t('voice.spk.mute')) + (on && engine.state === 'speaking' ? t('voice.spk.speaking') : '');
    rec.parts.paintSpeaker(on && engine.speakerMuted, spkLabel);
    // 返事の下の一行: 読み上げている間は「止める」、止めたあとは「ここで止めました · 続きを読む」（新しい発言を送るまで）
    const speaking = on && engine.state === 'speaking';
    let hintMode = null, hintText = '';
    if (speaking) {
      rec.cut = false;
      hintMode = 'reading';
      if (engine.bargeActive) hintText = t('voice.hint.readingBarge');
      else if (engine.bargeEnabled && !engine.echoCancellation) hintText = t('voice.hint.readingClosedEcho');   // 話して止めるは入っているが、この通話はエコー除去なしで始めたので聞けない（通話中に設定を替えても変わらない）
      else hintText = t('voice.hint.readingClosed');
    } else if (on && rec.cut) { hintMode = 'cut'; hintText = t('voice.hint.cut'); }
    else if (on && rec.board.ttsFailed) { hintMode = 'fail'; hintText = t('voice.hint.fail'); }   // 読み上げられなかった返事の下。次の発言を送るまで残る
    if (hintMode) {
      if (rec.hint.hidden) { rec.slot.tail.place(rec.hint); rec.hint.hidden = false; rec.slot.follow(); }
      if (rec.hintSig !== `${hintMode}|${hintText}`) { rec.hintSig = `${hintMode}|${hintText}`; rec.hint.paint(hintMode, hintText); }
    } else if (!rec.hint.hidden) { rec.hint.hidden = true; rec.hintSig = ''; }
    if (rec === active || rec === deniedRec) announce(ms);
  }
  const paintAll = () => { for (const rec of recs) paint(rec); };

  /** 状態の変化は静かに知らせる（聞いています ↔ 聞き取っています・考え中・話しています は知らせない。頻繁なため） */
  function announce(ms) {
    if (ms === said) return;
    const prev = said;
    said = ms;
    if (ms === 'starting') say(t('voice.live.starting'));
    else if (ms === 'listening' && prev === 'starting') say(t('voice.live.listening'));
    else if (ms === 'muted') say(t('voice.live.muted'));
    else if (prev === 'muted' && ms !== 'off') say(t('voice.live.unmuted'));
    else if (ms === 'denied') say(t('voice.live.denied'));
    else if (ms === 'off' && prev !== 'denied') say(t('voice.live.ended'));
  }

  // ---- 位置・レベルのループ（購読で CSS 変数へ。state は使わない）
  const setVar = (node, name, value) => { if (node._vc?.[name] === value) return; (node._vc ??= {})[name] = value; node.style.setProperty(name, value); };
  function loop(ts) {
    if (!engine.active || !active) { loopOn = false; return; }
    const lv = engine.levels();
    const main = active.slot.main;
    const reduced = reducedMotion();
    setVar(main, '--vc-lvl', (reduced ? 0.3 : Math.min(1, Math.max(0, lv.mic))).toFixed(2));
    setVar(main, '--vc-olv', (reduced ? 0.4 : Math.min(1, lv.out * 2.2)).toFixed(2));
    active.mark.frame(engine.position(), ts);
    requestAnimationFrame(loop);
  }
  const kick = () => { if (!loopOn && engine.active) { loopOn = true; requestAnimationFrame(loop); } };

  // ---- 通話の開始・終了
  async function start(rec) {
    if (!usable()) return;
    if (active && active !== rec) engine.end('switch');
    active = rec;
    deniedRec = null; deniedReason = null;
    for (const r of recs) { r.board.callStarted(); r.note.hide(); }   // 次の通話を始めたら、通話の状態の一行・聞き取れなかった行は消える
    startedTarget = rec.slot.target();
    startedKey = keyOf(startedTarget);
    paintAll();
    const ok = await engine.start(rec.slot.target(), { echoCancellation: settings.echoCancellation });
    if (!ok) {
      if (active === rec) active = null;
      if (engine.denied) { deniedRec = rec; deniedReason = engine.denied; showDeniedNote(rec); }
      paintAll();
      return;
    }
    kick();
    clearInterval(clock);
    clock = setInterval(() => { if (active) paint(active); }, 1000);
    clearInterval(watchTimer);
    watchTimer = setInterval(watchTarget, 500);
    paintAll();
  }

  function showDeniedNote(rec) {
    const reason = deniedReason;
    rec.board.showStatus(reason === 'no-device' ? 'no-device' : reason === 'busy' ? 'busy' : 'denied', keyOf(rec.slot.target()));
    watchMic();
  }

  /** 状態の一行が解けたとき（許可が下りた・マイクが繋がった・設定が変わった）。解けたマイクの印（!）も戻す */
  function fixed(event) {
    let any = false;
    for (const rec of recs) {
      if (!rec.board.clear(event)) continue;
      any = true;
      if (event !== 'fixed-settings' && deniedRec === rec) { deniedRec = null; deniedReason = null; }
    }
    if (any) paintAll();
  }
  /** マイクの許可・機器の変化を見張る（権限なし・マイクが見つからないの一行が、直ったら消える）。使えない環境では何もしない */
  function watchMic() {
    if (micWatched) return;
    micWatched = true;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => fixed('fixed-device'));
    navigator.permissions?.query?.({ name: 'microphone' }).then((status) => {
      micWatched = status;   // 参照を持っておく（変化の通知を受けている間、捨てられない）
      status.addEventListener('change', () => { if (status.state === 'granted') fixed('fixed-permission'); });
    }).catch(() => {});
  }
  /** 終わった理由（上限・声が聞こえず終了・つながりの切れ）が出ているあいだ、別の会話へ移ったかを見る（通話が終わったあとも） */
  function syncWatch() {
    const need = [...recs].some((rec) => rec.board.anchor !== null);
    if (need && !noteWatch) noteWatch = setInterval(() => { for (const rec of recs) if (rec.board.anchor !== null) rec.board.watch(keyOf(rec.slot.target())); }, 500);
    else if (!need && noteWatch) { clearInterval(noteWatch); noteWatch = null; }
  }

  /** 見ている会話が別のものに変わったら通話を終える。新しい会話の id が決まっただけなら、読み上げる会話の対象を更新する */
  function watchTarget() {
    if (!active || !engine.active) return;
    const key = keyOf(active.slot.target());
    if (key === startedKey) return;
    const was = startedKey;
    if (was === 'chat:' && key.startsWith('chat:') && key !== 'chat:') { startedKey = key; startedTarget = active.slot.target(); engine.setTarget(startedTarget); return; }
    engine.end('moved');
  }

  function cleanupRec(rec) {
    rec.live.remove();
    rec.mark.stop();
    rec.jump.hide();
    rec.hint.hidden = true;
    rec.hintSig = ''; rec.cut = false;
  }

  // ---- engine のイベント
  engine.subscribe((ev) => {
    const rec = active;
    switch (ev.type) {
      case 'state':
        if (rec && (engine.state === 'hearing' || engine.state === 'hold')) rec.board.speaking();   // 次に話し始めた: 聞き取れなかった行を畳む
        paintAll(); kick(); break;
      case 'started': paintAll(); sounds.play('start'); break;
      case 'seg': rec?.mark.seg(ev); break;
      case 'segend': rec?.mark.finish(ev.id); break;
      case 'cancel': rec?.mark.stop(); break;
      // まとめ待ち: 組み立て中の文を 1 つの吹き出しへ、残り時間はマイクの縁の弧へ（同じ長さで減る）
      case 'final': rec?.board.heard(); break;   // 何か 1 つ聞き取れた: 続けて失敗した回数を戻す
      case 'hold': if (rec) { if (ev.view?.text) rec.board.speaking(); rec.live.update(ev.view); rec.parts.wrap.style.setProperty('--hold-p', (ev.view.active ? ev.view.fraction : 1).toFixed(3)); } break;
      case 'turn': if (rec) onTurn(rec, ev.text, ev.ended === true); break;
      case 'turn.discard': rec?.live.discard(); break;
      case 'barge': case 'halt':
        if (rec) { rec.cut = true; say(t('voice.live.stopped')); paint(rec); }
        if (ev.type === 'barge') sounds.play('barge');
        break;
      case 'turnEnd': rec?.mark.resetCursor(); break;
      case 'lat': showLatency(ev); break;
      case 'notice': if (rec ?? lastRec) onNotice(rec ?? lastRec, ev); break;
      case 'ended': {
        const was = active;
        if (was) { lastRec = was; cleanupRec(was); }
        active = null;
        for (const r of recs) r.board.callEnded();   // 通話を終えたら、聞き取れなかった行・読み上げの失敗の一行は消える
        clearInterval(clock); clearInterval(watchTimer);
        paintAll();
        announce('off');
        sounds.play('end');
        break;
      }
    }
  });

  /** まとめ待ちを終えた 1 通。吹き出しは確定の字にして、会話へは直列のキューで送る（本物の行が現れたら吹き出しは消える） */
  function onTurn(rec, text, ended = false) {
    if (ended) { onLeaveTurn(rec, text); return; }
    rec.cut = false;
    rec.board.turnSent();   // 次の発言を送った: 読み上げの失敗の一行は消える
    rec.live.commit(text);
    const bubble = rec.live.row;
    engine.noteSent(true);
    say(t('voice.live.sent'));
    sendQueue.push(() => rec.slot.send(text)).then(
      (result) => {
        noteHanded(result);
        sounds.play('sent');
        // 本物の発言の行が現れなかったとき（別の経路で描かれた）のために、少し待って吹き出しを外す
        setTimeout(() => { if (rec.live.sending && rec.live.row === bubble) rec.live.remove(true); }, 600);
      },
      (e) => {
        engine.noteSent(false);
        if (rec.live.row === bubble) rec.live.remove();
        rec.note.show(t('voice.note.sendFailed', { error: e?.message ?? String(e) }), { settings: false });
        sounds.play('fail');
      },
    );
  }

  /**
   * 通話を終えたとき、まとめ待ちに残っていた言葉（engine が ended: true で出す。言いよどみだけなら来ない）。話していた会話へ送る。
   * まだその会話を見ているなら普通の送り方（会話の行に配送の一行が出る）。別の会話へ移っていたら送り先を指定して送る（その会話には行を出せないので、読み上げの通知で知らせる）
   * 通話は終わっているので、吹き出し・考え中・受け取りの一言の起点（渡った合図）には触れない
   */
  function onLeaveTurn(rec, text) {
    const target = startedTarget;
    const here = !target || keyOf(target) === keyOf(rec.slot.target());
    say(t('voice.live.sent'));
    sendQueue.push(() => (here ? rec.slot.send(text) : sendTo(rec, target, text))).then(
      () => { sounds.play('sent'); if (!here) say(t('voice.note.sentOnLeave')); },
      (e) => {
        rec.note.show(t('voice.note.sendFailed', { error: e?.message ?? String(e) }), { settings: false });
        sounds.play('fail');
      },
    );
  }
  function sendTo(rec, target, text) {
    if (rec.slot.sendTo) return rec.slot.sendTo(target, text);
    if (target.kind === 'thread') return invoke('channels.post', { channelId: target.channelId, threadId: target.threadId, text });
    return Promise.reject(new Error(t('voice.note.notSent')));
  }

  /** engine の notice。聞き取り・読み上げの失敗は (a) その場の知らせ、ほかは (b) 通話の状態の一行（入力欄の下。notices.mjs） */
  function onNotice(rec, ev) {
    const code = ev.code;
    if (!engine.active && ['stt', 'stt-busy', 'tts'].includes(code)) return;   // 通話が終わったあとに、その場の失敗は出さない
    if (code === 'stt' || code === 'stt-busy') rec.board.listenFailed({ code, kind: ev.kind, status: ev.status });
    else if (code === 'tts') rec.board.ttsFail();
    else rec.board.showStatus(code, keyOf(rec.slot.target()));
    if (['stt', 'stt-busy', 'tts'].includes(code)) sounds.play('fail');
  }

  // ---- 開発用の遅延の表示（localStorage の ply-voice-debug = 1）。声の終わり → 確定、確定 → 最初の音
  let debugEl = null;
  const lat = {};
  function showLatency(ev) {
    let on = false;
    try { on = localStorage.getItem('ply-voice-debug') === '1'; } catch { /* 使えない */ }
    if (!on) return;
    Object.assign(lat, ev);
    if (!debugEl) { debugEl = document.createElement('div'); debugEl.className = 'vc-debug'; debugEl.dataset.vcDebug = ''; document.body.append(debugEl); }
    debugEl.textContent = `voice end→final ${lat.speechEndToFinalMs ?? '-'}ms · final→first sentence ${lat.finalToFirstTextMs ?? '-'}+${lat.firstTextToSentenceMs ?? '-'}ms · sentence→audio (host) ${lat.sentenceToFirstAudioMs ?? '-'}ms · final→sound ${lat.soundMs ?? lat.finalToFirstAudioMs ?? '-'}ms`;
  }

  return {
    engine,
    /** 部品を差し込む（契約は冒頭）。返す handle は取り外し */
    mount(slot) {
      const call = createCallButton();
      const parts = createComposerParts();
      const note = createNote({ onSettings: () => openSettings(), onClose: () => { note.hide(); rec.board.clear('close'); } });
      const glow = createGlow();
      const hint = createHint({ onStop: () => engine.halt(), onResume: () => { rec.cut = false; engine.resume(); paintAll(); } });
      let rec = null;
      const jump = createJump({ onJump: () => { rec.mark.reveal(); jump.hide(); } });
      const mark = createReadingMark({ host: slot.log, scope: () => slot.replyScope(), reduced: reducedMotion,
        onOffscreen: (dir) => (dir ? jump.show(dir) : jump.hide()) });
      const liveBubble = createLiveBubble({ createRow: () => slot.tail.createRow(), place: (row) => slot.tail.place(row), label: t('voice.mark'), reduced: reducedMotion, follow: () => slot.follow(),
        text: { group: t('voice.hold.group'), listening: t('voice.hold.listening'), waiting: (seconds) => t('voice.hold.waiting', { seconds }), finishing: t('voice.hold.finishing'), sendNow: t('voice.hold.sendNow'), cancel: t('voice.hold.cancel') },
        actions: { sendNow: () => engine.sendNow(), cancel: () => engine.cancelTurn() } });
      const listenFail = createListenFail({ createRow: () => slot.tail.createRow(), place: (row) => slot.tail.place(row), markHost: (row) => slot.tail.markHost(row),
        label: t('voice.markMissed'), reduced: reducedMotion, follow: () => slot.follow(), onSettings: () => openSettings() });
      const board = createNotices({
        bubbleActive: () => liveBubble.active,
        status: (view) => {
          // i18n-dynamic: voice.note.
          if (view) note.show(t(`voice.note.${view.key}`), { settings: view.settings }); else note.hide();
          syncWatch();
        },
        listen: (view) => {
          if (!view) { listenFail.hide(); liveBubble.setFail(null); return; }
          if (view.where === 'bubble') { listenFail.hide(); liveBubble.setFail(t('voice.note.sttMissing')); return; }
          liveBubble.setFail(null);
          listenFail.show(listenText(view));
        },
        ttsFail: (on) => { if (on) say(t('voice.note.tts')); paint(rec); },
      });
      rec = { slot, call, parts, note, glow, hint, jump, mark, live: liveBubble, board, listenFail };
      recs.add(rec);

      // 入口: 頭の通話ボタン・入力欄のマイクとスピーカー・失敗の一行・背景・止めるの一行・話している場所へ
      if (slot.headerBefore) slot.header.insertBefore(call.el, slot.headerBefore); else slot.header.prepend(call.el);
      slot.composer.row.insertBefore(parts.spk, slot.composer.before);
      slot.composer.row.insertBefore(parts.wrap, slot.composer.before);
      slot.composer.below.after(note.el);
      slot.main.setAttribute('data-vc-glow', '');
      slot.main.prepend(glow);
      slot.overlay.append(jump.el);
      hint.hidden = true;

      call.el.onclick = () => { if (active === rec && engine.active) engine.end('user'); else start(rec); };
      parts.mic.onclick = () => {
        if (active === rec && engine.active) engine.setMuted(!engine.muted);
        else start(rec);
      };
      parts.spk.onclick = () => { if (active === rec && engine.active) engine.setSpeakerMuted(!engine.speakerMuted); };

      // 本物の発言の行が現れたら声の吹き出しを外し、その行にマイクの印を付ける（吹き出しと行が重ならない）。
      // 行が描き直される場所（スレッドの投稿）は、印を付けた行の key を覚えておき、描き直されたら付け直す（画面を開いている間だけ）
      const marked = new Set();
      const addMark = (row) => {
        const host = slot.tail.markHost(row);
        if (host && !host.querySelector('.vmark')) host.append(micMark(t('voice.mark')));
      };
      const rows = new MutationObserver((records) => {
        if (slot.tail.persistMarks && marked.size) {
          for (const key of marked) { const row = slot.tail.rows.querySelector(`[data-post-id="${CSS.escape(key)}"]`); if (row) addMark(row); }
        }
        if (!liveBubble.sending) return;
        for (const r of records) for (const node of r.addedNodes) {
          if (node.nodeType !== 1 || node.dataset?.vcLive !== undefined || !slot.tail.isRow(node)) continue;
          liveBubble.remove();
          addMark(node);
          const key = slot.tail.rowKey?.(node);
          if (key) { marked.add(key); if (marked.size > 100) marked.delete(marked.values().next().value); }
          return;
        }
      });
      rows.observe(slot.tail.rows, { childList: true, subtree: slot.tail.persistMarks === true });

      paint(rec);
      return {
        /** 通話ボタンを出す・隠す（ホストの対応が分かったとき） */
        refresh: () => paint(rec),
        destroy() {
          if (active === rec) engine.end('destroy');
          rows.disconnect();
          mark.destroy();
          listenFail.hide();
          for (const node of [call.el, parts.spk, parts.wrap, note.el, glow, jump.el]) node.remove();
          recs.delete(rec);
        },
      };
    },
    /** 設定（設定 › 通話・キー）が変わった（changed: true。キー不足・上限の一行が消える）・ホストの対応が分かった */
    refresh({ changed = false } = {}) { loadSettings(); if (changed) fixed('fixed-settings'); paintAll(); },
    /** 通話中か */
    get active() { return engine.active; },
  };
}
