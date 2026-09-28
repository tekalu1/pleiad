// 入力欄の `!`（シェルの行。docs/design-system.md「入力欄のシェルの形」、ADR 0054）。
//
// - 空の欄の先頭で `!` を**打った**ときだけ入る（beforeinput の insertText）。貼り付け・下書きの復元・字の差し込みでは入らない
// - 入ると `!` は欄に残さず、箱の頭に「シェル · 作業ディレクトリ」（遠隔の画面ではホスト名も）を出す。欄は等幅、送信は ▶（実行）
// - 空の欄で Backspace を押すと元の欄に戻る
// - 使えない会話（Antigravity・スレッドの無い Codex）では `!` を欄に残し、頭に「この会話ではシェルを実行できません」を出して送信を止める
// - どちらの形でも頭の行に「文として送る」（`!` で始まる文としてふつうに送る）
// DOM は受け取った要素だけを触る。走らせる・送るのは client.mjs（submit と onAsText）。
import { el, icon } from './dom.mjs';

const PROMPT_ICON = 'M4 17l6-5-6-5M12 19h8';
const WARN_ICON = 'M12 4l9 16H3zM12 10v4M12 17v.5';

/**
 * @param box 入力の箱（.cbox）。シェルの形の間は .shell
 * @param prompt 字の欄
 * @param head 箱の頭の行（欄の上）。使わない間は hidden
 * @param send 送信のボタン
 * @param t 訳
 * @param availability () => ({ ok: true } | { ok: false, text })。いまの会話で走らせられるか
 * @param where () => ({ cwd, host })。host は遠隔の画面のときだけ
 * @param touch () => boolean。タッチの画面か（プレースホルダーの Ctrl+Enter を省く）
 * @param onAsText (text) => void。「文として送る」
 * @param onChange () => void。形が変わった（送信の押せる・押せないを見直す）
 */
export function createShellComposer({ box, prompt, head, send, t, availability, where = () => ({}), touch = () => false, onAsText = () => {}, onChange = () => {} }) {
  let mode = null;            // null | 'shell' | 'blocked'
  let blockedText = '';
  let savedPlaceholder = null;
  const sendTitle = { title: null, label: null };

  function paintHead() {
    head.replaceChildren();
    // 光らせた印は残さない（隠した頭の行をまた出したときに、もう一度光ってしまう）
    head.classList.remove('flash');
    head.classList.toggle('unavail', mode === 'blocked');
    if (!mode) { head.hidden = true; return; }
    head.hidden = false;
    const asText = el('button', 'btn as-text', t('chat.shell.asText'));
    asText.type = 'button';
    asText.title = t('chat.shell.asTextTitle');
    // 欄のフォーカスを奪わない（押した後も書き続けられる）
    asText.addEventListener('mousedown', e => e.preventDefault());
    asText.onclick = () => sendAsText();
    if (mode === 'blocked') {
      head.append(icon(WARN_ICON), el('span', 'msg', blockedText), asText);
      return;
    }
    const { cwd = '', host = '' } = where() ?? {};
    const place = el('span', 'where');
    const name = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
    if (host) place.append(el('span', 'host', host), el('span', null, ' · '));
    place.append(el('span', null, name));
    if (cwd) place.title = t('chat.shell.where', { cwd });
    head.append(icon(PROMPT_ICON), el('span', 'label', t('chat.shell.label')), place, asText);
  }

  function paint() {
    box.classList.toggle('shell', mode === 'shell');
    paintHead();
    if (mode === 'shell') {
      if (savedPlaceholder === null) savedPlaceholder = prompt.placeholder;
      prompt.placeholder = touch() ? t('chat.shell.placeholderTouch') : t('chat.shell.placeholder');
      prompt.setAttribute('spellcheck', 'false');
      if (sendTitle.title === null) { sendTitle.title = send.getAttribute('title'); sendTitle.label = send.getAttribute('aria-label'); }
      send.setAttribute('title', t('chat.shell.run'));
      send.setAttribute('aria-label', t('chat.shell.run'));
    } else {
      if (savedPlaceholder !== null) { prompt.placeholder = savedPlaceholder; savedPlaceholder = null; }
      prompt.removeAttribute('spellcheck');
      if (sendTitle.title !== null) {
        send.setAttribute('title', sendTitle.title ?? '');
        send.setAttribute('aria-label', sendTitle.label ?? '');
        sendTitle.title = sendTitle.label = null;
      }
    }
    send.classList.toggle('shell-blocked', mode === 'blocked');
    onChange();
  }

  function enter(next, text = '') {
    mode = next;
    blockedText = text;
    paint();
  }
  function exit() {
    if (!mode) return;
    mode = null;
    blockedText = '';
    paint();
  }

  /** 空の欄の先頭で `!` を打った。シェルの形にしたら true（`!` は欄に入れない） */
  function beforeinput(e) {
    if (mode || e.isComposing || e.inputType !== 'insertText' || e.data !== '!' || prompt.value !== '') return false;
    const a = availability();
    if (a?.ok) {
      e.preventDefault();
      enter('shell');
      return true;
    }
    // 使えない会話: `!` はそのまま欄に入れ、頭に理由を出す
    enter('blocked', a?.text ?? '');
    return false;
  }

  /** 空の欄で Backspace を押したら元の欄に戻る */
  function keydown(e) {
    if (mode !== 'shell' || e.key !== 'Backspace' || e.isComposing || prompt.value !== '' || e.ctrlKey || e.metaKey || e.altKey) return false;
    e.preventDefault();
    exit();
    return true;
  }

  /** 使えない会話で `!` を消したら頭の行を下げる */
  function input() {
    if (mode === 'blocked' && !prompt.value.startsWith('!')) exit();
  }

  /** 「文として送る」。シェルの形では頭に `!` を戻してから送る */
  function sendAsText() {
    const text = mode === 'shell' ? `!${prompt.value}` : prompt.value;
    if (mode === 'shell') prompt.value = text;
    exit();
    onAsText(text);
  }

  /**
   * 「入力欄に写す」（履歴の `!` の行）。空の欄で走らせられる会話なら、シェルの形でコマンドを入れる（走らせない）。
   * 入れたら true。入れなかったら false（呼び出し側が `! コマンド` を文として足す）
   */
  function copy(command) {
    if (prompt.value !== '' || mode || !availability()?.ok) return false;
    enter('shell');
    prompt.value = command;
    return true;
  }

  /** 下書きに残す字。シェルの形では `!` を頭に戻す（復元ではシェルの形に入らない） */
  const draftText = () => (mode === 'shell' ? `!${prompt.value}` : prompt.value);

  /** 別の会話を開いた・欄を差し替えた。形を解く */
  function reset() { exit(); }

  /** 会話の中身が変わった（エージェントの切り替え・送信済みになった）。いまの形のまま頭の行を描き直す */
  function sync() {
    if (!mode) return;
    const a = availability();
    if (mode === 'shell' && !a?.ok) { prompt.value = `!${prompt.value}`; enter('blocked', a?.text ?? ''); return; }
    if (mode === 'blocked' && a?.ok) { exit(); return; }
    if (mode === 'blocked') blockedText = a?.text ?? blockedText;
    paint();
  }

  /** 送れないときに頭の行を一度光らせる（Ctrl+Enter を押した） */
  function flash() {
    head.classList.remove('flash');
    void head.offsetWidth;
    head.classList.add('flash');
    head.addEventListener('animationend', () => head.classList.remove('flash'), { once: true });
  }

  return {
    get mode() { return mode; },
    get active() { return mode === 'shell'; },
    get blocked() { return mode === 'blocked'; },
    beforeinput, keydown, input, copy, draftText, reset, sync, flash, exit, sendAsText,
    enter: () => enter('shell'),
  };
}
