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
//                 persistMarks = 行が描き直される場所（印を付け直す。rowKey = 行の識別子。画面を開いている間だけ覚える）
//   target()      見ている先 { kind: 'chat', sessionId } | { kind: 'thread', channelId, threadId } | null
//   send(text)    確定した発言を、いまの送信の経路（会話へは sendMessage、スレッドへは channels.post）へ。失敗したら投げる
//   follow()      足したあと、末尾にいるなら下へ追従させる
//
// 通話は 1 度に 1 本。別の slot で始めると前の通話は終わる。見ている会話・スレッドが別のものに変わったら通話は終わる（新しい会話の id が決まっただけなら続ける）。
import { createCallEngine } from './engine.mjs';
import { createCallButton, createComposerParts, createGlow, createHint, createJump, createNote } from './view.mjs';
import { createReadingMark } from './reading-mark.mjs';
import { createLiveBubble, micMark } from './live-bubble.mjs';
import { t } from '../i18n.mjs';

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const keyOf = (target) => (target ? (target.kind === 'thread' ? `thread:${target.channelId}:${target.threadId}` : `chat:${target.sessionId ?? ''}`) : '');

export function setupVoice({ token, invoke, openSettings, available = () => true, engine: injected = null, now = () => Date.now() }) {
  const engine = injected ?? createCallEngine({ token });
  const recs = new Set();
  let active = null;            // 通話中の rec
  let deniedRec = null;         // マイクを使えなかった rec（理由は deniedReason）
  let deniedReason = null;
  let startedKey = '';
  let settings = { echoCancellation: true };
  let loopOn = false, clock = null, watchTimer = null;
  let said = 'off';
  let lastRec = null;           // 直近に通話していた rec（終わったあとに届く知らせを出す先）
  const live = document.createElement('span');
  live.className = 'vc-sr';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);
  const say = (text) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };

  const loadSettings = () => invoke('voice.status', {}).then((s) => { settings = { ...settings, echoCancellation: s?.settings?.echoCancellation !== false }; }).catch(() => {});
  loadSettings();

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
    const ms = msOf(rec);
    const time = on ? fmtTime(Math.floor((now() - engine.startedAt) / 1000)) : '';
    rec.call.el.hidden = !usable();
    rec.call.paint({ on, time });
    const root = rec.slot.composer.root;
    const wasShown = root.classList.contains('vc-in-call') || root.classList.contains('vc-deny');
    root.classList.toggle('vc-in-call', on);
    root.classList.toggle('vc-deny', !on && deniedRec === rec);
    if (wasShown !== (on || (!on && deniedRec === rec))) rec.slot.composer.refit?.();
    const main = rec.slot.main;
    if (on) { main.setAttribute('data-vc-call', ''); main.dataset.vcCs = engine.state; main.dataset.vcMute = String(engine.muted); }
    else { main.removeAttribute('data-vc-call'); delete main.dataset.vcCs; delete main.dataset.vcMute; }
    // i18n-dynamic: voice.state.
    const stateWord = ms === 'off' || ms === 'denied' ? '' : t(`voice.state.${ms}`);
    // i18n-dynamic: voice.mic.
    const micLabel = ms === 'denied' ? t(`voice.mic.${deniedReason === 'no-device' ? 'noDevice' : deniedReason === 'busy' ? 'busy' : 'denied'}`)
      : ms === 'off' ? t('voice.call.start')
        : ms === 'muted' ? t('voice.mic.unmute', { state: stateWord }) : t('voice.mic.mute', { state: stateWord });
    rec.parts.paintMic(ms, micLabel);
    const spkLabel = (engine.speakerMuted && on ? t('voice.spk.unmute') : t('voice.spk.mute')) + (on && engine.state === 'speaking' ? t('voice.spk.speaking') : '');
    rec.parts.paintSpeaker(on && engine.speakerMuted, spkLabel);
    // 返事の下の「止める」は、読み上げている間だけ
    const speaking = on && engine.state === 'speaking';
    if (speaking && rec.hint.hidden) { rec.slot.tail.place(rec.hint); rec.hint.hidden = false; rec.slot.follow(); }
    else if (!speaking && !rec.hint.hidden) rec.hint.hidden = true;
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
    rec.note.hide();
    startedKey = keyOf(rec.slot.target());
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
    // i18n-dynamic: voice.note.
    rec.note.show(t(`voice.note.${reason === 'no-device' ? 'noDevice' : reason === 'busy' ? 'busy' : 'denied'}`), { settings: true });
  }

  /** 見ている会話が別のものに変わったら通話を終える。新しい会話の id が決まっただけなら、読み上げる会話の対象を更新する */
  function watchTarget() {
    if (!active || !engine.active) return;
    const key = keyOf(active.slot.target());
    if (key === startedKey) return;
    const was = startedKey;
    if (was === 'chat:' && key.startsWith('chat:') && key !== 'chat:') { startedKey = key; engine.setTarget(active.slot.target()); return; }
    engine.end('moved');
  }

  function cleanupRec(rec) {
    rec.live.remove();
    rec.mark.stop();
    rec.jump.hide();
    rec.hint.hidden = true;
  }

  // ---- engine のイベント
  engine.subscribe((ev) => {
    const rec = active;
    switch (ev.type) {
      case 'state': paintAll(); kick(); break;
      case 'started': paintAll(); break;
      case 'seg': rec?.mark.seg(ev); break;
      case 'segend': rec?.mark.finish(ev.id); break;
      case 'cancel': rec?.mark.stop(); break;
      case 'partial': rec?.live.partial(ev.text); break;
      case 'drop': rec?.live.discard(); break;
      case 'final': if (rec) onFinal(rec, ev); break;
      case 'turnEnd': rec?.mark.resetCursor(); break;
      case 'lat': showLatency(ev); break;
      case 'notice': if (rec ?? lastRec) onNotice(rec ?? lastRec, ev.code); break;
      case 'ended': {
        const was = active;
        if (was) { lastRec = was; cleanupRec(was); }
        active = null;
        clearInterval(clock); clearInterval(watchTimer);
        paintAll();
        announce('off');
        break;
      }
    }
  });

  async function onFinal(rec, ev) {
    const text = String(ev.text ?? '').trim();
    if (!text) { rec.live.discard(); return; }
    rec.live.settle(text);
    engine.noteSent(true);
    try { await rec.slot.send(text); }
    catch (e) {
      engine.noteSent(false);
      rec.live.remove();
      rec.note.show(t('voice.note.sendFailed', { error: e?.message ?? String(e) }), { settings: false });
      return;
    }
    // 本物の発言の行が現れなかったとき（別の経路で描かれた）のために、少し待って吹き出しを外す
    setTimeout(() => { if (rec.live.sending) rec.live.remove(true); }, 600);
  }

  const NOTICE = {
    'no-key': ['nokey', true], 'daily-limit': ['dailyLimit', true], 'limit-call': ['callLimit', true], 'limit-daily': ['dailyLimit', true], 'limit-idle': ['idle', false],
    link: ['link', false], 'stt-busy': ['sttBusy', false], stt: ['stt', false], tts: ['tts', false], start: ['start', true], 'start-timeout': ['startTimeout', false],
  };
  function onNotice(rec, code) {
    const [key, settings_] = NOTICE[code] ?? ['start', true];
    // i18n-dynamic: voice.note.
    rec.note.show(t(`voice.note.${key}`), { settings: settings_ });
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
      const note = createNote({ onSettings: () => openSettings() });
      const glow = createGlow();
      const hint = createHint({ onStop: () => engine.halt() });
      let rec = null;
      const jump = createJump({ onJump: () => { rec.mark.reveal(); jump.hide(); } });
      const mark = createReadingMark({ host: slot.log, scope: () => slot.replyScope(), reduced: reducedMotion,
        onOffscreen: (dir) => (dir ? jump.show(dir) : jump.hide()) });
      const liveBubble = createLiveBubble({ createRow: () => slot.tail.createRow(), place: (row) => slot.tail.place(row), label: t('voice.mark'), reduced: reducedMotion, follow: () => slot.follow() });
      rec = { slot, call, parts, note, glow, hint, jump, mark, live: liveBubble };
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
          for (const node of [call.el, parts.spk, parts.wrap, note.el, glow, jump.el]) node.remove();
          recs.delete(rec);
        },
      };
    },
    /** 設定（設定 › 通話）が変わった・ホストの対応が分かった */
    refresh() { loadSettings(); paintAll(); },
    /** 通話中か */
    get active() { return engine.active; },
  };
}
