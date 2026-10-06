// 通話モードの部品（DOM）。承認済みの形（docs/design-system.md「通話モード」）: 頭の通話ボタン・入力欄のマイクとスピーカー・失敗の一行・背景・止めるの一行・話している場所へ。
// 状態は持たない。index.mjs が engine の状態から paint を呼ぶ。字は辞書（ui:voice.*）から引く。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';

const NS = 'http://www.w3.org/2000/svg';
const svg = (inner, cls = 'i', box = 24) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('viewBox', `0 0 ${box} ${box}`);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
};
const PHONE = '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>';
const MIC = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>';
const MIC_OFF = '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.6-1.5"/><path d="M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>';
const SPK_ON = '<path d="M4 9v6h4l5 4V5L8 9z"/><path class="a1" d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path class="a2" d="M18.5 7a7 7 0 0 1 0 10"/><path class="a3" d="M21 4.5a10.5 10.5 0 0 1 0 15"/>';
const SPK_OFF = '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>';
const WARN = '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>';

/** 頭の通話ボタン（1 つの要素。通話中は塗りのピルに受話器を置くアイコンと経過時間） */
export function createCallButton() {
  const b = el('button', 'btn vc-call');
  b.type = 'button';
  b.hidden = true;
  const ci = el('span', 'vc-ci');
  ci.append(svg(PHONE));
  const tm = el('span', 'vc-tm');
  b.append(ci, tm);
  const set = (label) => { b.title = label; b.setAttribute('aria-label', label); };
  set(t('voice.call.start'));
  return {
    el: b,
    paint({ on, time }) {
      b.classList.toggle('on', on);
      tm.textContent = on ? time : '';
      set(on ? t('voice.call.endAt', { time }) : t('voice.call.start'));
    },
  };
}

/** 入力欄のマイクとスピーカー（通話中だけ。権限なしのときはマイクだけ） */
export function createComposerParts() {
  const spk = el('button', 'vc-btn vc-spk vc-callonly');
  spk.type = 'button';
  spk.setAttribute('aria-pressed', 'false');
  const wrap = el('span', 'vc-micwrap vc-callonly');
  wrap.dataset.ms = 'off';
  const mic = el('button', 'vc-btn vc-mic');
  mic.type = 'button';
  const fill = el('i', 'vc-mfill');
  const ring = document.createElementNS(NS, 'svg');
  ring.setAttribute('class', 'vc-mring');
  ring.setAttribute('viewBox', '0 0 32 32');
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = '<circle class="vc-rb" cx="16" cy="16" r="14"/><circle class="vc-rs" cx="16" cy="16" r="14"/>';
  const ico = el('span', 'vc-mico');
  const bang = el('span', 'vc-mbang', '!');
  bang.setAttribute('aria-hidden', 'true');
  mic.append(fill, ring, ico, bang);
  wrap.append(mic);
  const name = (btn, text) => { btn.title = text; btn.setAttribute('aria-label', text); };
  return {
    spk, wrap, mic,
    /** ms: off | starting | listening | hearing | thinking | speaking | muted | denied */
    paintMic(ms, label) {
      wrap.dataset.ms = ms;
      ico.replaceChildren(svg(ms === 'muted' || ms === 'denied' ? MIC_OFF : MIC));
      if (ms === 'muted') mic.setAttribute('aria-pressed', 'true');
      else if (ms === 'denied' || ms === 'off') mic.removeAttribute('aria-pressed');
      else mic.setAttribute('aria-pressed', 'false');
      name(mic, label);
    },
    paintSpeaker(muted, label) {
      spk.replaceChildren(svg(muted ? SPK_OFF : SPK_ON));
      spk.setAttribute('aria-pressed', String(muted));
      name(spk, label);
    },
  };
}

/** 通話の失敗の一行（入力欄の下。role=status）。権限なし・キーなし・上限・つながり。設定が関わるときだけ「設定を開く」 */
export function createNote({ onSettings }) {
  const root = el('div', 'vc-note');
  root.setAttribute('role', 'status');
  const text = el('span');
  const open = el('button', null, t('voice.openSettings'));
  open.type = 'button';
  open.onclick = onSettings;
  root.append(svg(WARN), text, open);
  return {
    el: root,
    show(message, { settings = true } = {}) { text.textContent = message; open.hidden = !settings; root.classList.add('show'); },
    hide() { root.classList.remove('show'); text.textContent = ''; },
    get visible() { return root.classList.contains('show'); },
  };
}

/** 背景（案 D: 話している間だけ）。通話中だけ 600ms でふわっと出入りする */
export function createGlow() {
  const root = el('div', 'vc-aurora');
  root.setAttribute('aria-hidden', 'true');
  const inner = el('div', 'vc-aurora-in');
  for (const n of ['b1', 'b2', 'b3']) inner.append(el('i', `vc-blob ${n}`));
  root.append(inner);
  return root;
}

/**
 * 返事の下の一行（承認済み 2026-10-07）。paint(mode, message) で出し分ける:
 *   reading  「読み上げ中 · 話すと止まります」［止める］（話して止めるが効かないときは、いまはマイクを閉じている理由）
 *   cut      「ここで読み上げを止めました」［続きを読む］（止めた場所。新しい発言を送るまで残る）
 */
export function createHint({ onStop, onResume }) {
  const root = el('div', 'vc-hint');
  root.hidden = true;
  const text = el('span');
  const stop = el('button', 'btn', t('voice.hint.stop'));
  stop.type = 'button';
  stop.onclick = onStop;
  const resume = el('button', 'btn', t('voice.hint.resume'));
  resume.type = 'button';
  resume.onclick = onResume;
  root.append(svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>', 'i s'), text, stop, resume);
  root.paint = (mode, message) => {
    root.dataset.mode = mode;
    text.textContent = message;
    stop.hidden = mode !== 'reading';
    resume.hidden = mode !== 'cut';
  };
  return root;
}

/** 話している場所が画面の外にあるときの「話している場所へ ↓」（自動では追いかけない） */
export function createJump({ onJump }) {
  const b = el('button', 'vc-jump');
  b.type = 'button';
  b.hidden = true;
  b.setAttribute('aria-label', t('voice.hint.jump'));
  const arrow = el('span', 'vc-ja', '↓');
  b.append(el('span', null, t('voice.hint.jump')), arrow);
  b.onclick = onJump;
  return { el: b, show(dir) { arrow.textContent = dir === 'above' ? '↑' : '↓'; b.hidden = false; }, hide() { b.hidden = true; } };
}
