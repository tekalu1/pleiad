// 入力欄の部品（docs/design-system.md「入力欄と上端」「入力欄の設定」「入力欄の待ち」）。Chats の会話の入力欄とスレッドの入力欄が同じものを使う。
// 持つもの: 字の欄（web/md-editor.mjs）・添付（web/composer/attachments.mjs）・書けない待ち（web/composer-wait.mjs）・高さ・キー
// （Ctrl/⌘+Enter で送信、Ctrl/⌘+Shift+Enter で送信の日時の面）・送信の口・外から部品を差し込む口（送信の左のスロット）。
// 設定のチップ・送信の日時・`/`・`!` は use〜 で後から差し込む（Chats は今までどおりの順で作るため。スレッドはまとめて差し込む）。
// 何を送るか（会話への送信・スレッドへの投稿・下書き・送信待ち）は呼び出し側が持ち、onSubmit などの口で受ける。
//
// 要素の id は欄ごとに頭を付ける（Chats は頭なしの今の id: prompt・send…、スレッドは th: thPrompt・thSend…）。
// スレッドの欄の骨組みは、起動時に写した Chats の欄（rememberComposerTemplate）から作る。CSS は :is(#prompt,#thPrompt) のように両方を指す。
import { createMarkdownEditor } from '../md-editor.mjs';
import { createComposerWait } from '../composer-wait.mjs';
import { createComposerAttachments } from './attachments.mjs';
import { promptMaxHeight } from '../composer-layout.mjs';
import { setupComposerControls } from '../composer-controls.mjs';
import { setupSendMenu } from '../send-menu.mjs';
import { setupSlashSkills } from '../slash-skills.mjs';
import { createShellComposer } from '../shell-composer.mjs';
import { isComposingKey } from '../keyboard.mjs';

/** 入力欄の中の要素の役割（id は頭 + 役割。頭が空なら役割そのもの） */
export const COMPOSER_PARTS = ['composer', 'contextStrip', 'contextMeterWrap', 'contextMeter', 'contextMeterPop', 'meterCompact', 'meterSettings', 'usageChip',
  'contextStripStatus', 'contextStripText', 'workEntry', 'workEntryButton', 'outbox', 'nextSettings', 'nextSettingsText', 'nextSettingsBehind',
  'nextHandoff', 'cancelSettings', 'settingsError', 'skillList', 'composerNote', 'connNote', 'cbox', 'attached', 'shellHead', 'prompt', 'composerBusy',
  'composerBusyText', 'slashHint', 'draftFail', 'draftFailText', 'draftFailRetry', 'attach', 'fileIn', 'cwdChip', 'draftSaved', 'armedChip', 'armedText',
  'armedRemove', 'modelChip', 'modeChip', 'abort', 'resume', 'resumeLabel', 'resumeShort', 'send', 'sendMore', 'resumeNote', 'armedNote', 'cwdPop',
  'modelPop', 'modePop', 'sendPop', 'sendVeil'];

/** 役割 → id（頭が空なら今の Chats の id） */
export const composerId = (prefix, part) => (prefix ? prefix + part[0].toUpperCase() + part.slice(1) : part);

let template = null;
/** Chats の入力欄の骨組みを写しておく（文言を埋めた後・中身を作る前に 1 回。スレッドの欄はこの写しから作る） */
export function rememberComposerTemplate(form) {
  template = form.cloneNode(true);
}

/**
 * 写した骨組みから新しい入力欄を作る。id に頭を付け、欄の中の参照（aria-controls・for など）も付け替える。
 * 返すのは form（.composer）。中身（字の欄・チップ）は createComposer と use〜 が作る
 */
export function buildComposer(prefix) {
  if (!template) throw new Error('composer template is not remembered');
  const form = template.cloneNode(true);
  const known = new Set(COMPOSER_PARTS);
  const rename = (v) => v.split(/\s+/).map((x) => (known.has(x) ? composerId(prefix, x) : x)).join(' ');
  for (const n of [form, ...form.querySelectorAll('[id]')]) if (n.id && known.has(n.id)) n.id = composerId(prefix, n.id);
  for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) {
    for (const n of form.querySelectorAll(`[${attr}]`)) n.setAttribute(attr, rename(n.getAttribute(attr)));
  }
  return form;
}

/** 頭 prefix の入力欄の要素を役割の名前で引く（root の中から。無ければ document） */
export function composerEls(prefix, root = document) {
  const els = {};
  for (const part of COMPOSER_PARTS) {
    const id = composerId(prefix, part);
    els[part] = (root.id === id ? root : root.querySelector?.(`#${CSS.escape(id)}`)) ?? document.getElementById(id);
  }
  return els;
}

/**
 * @param {object} o
 * @param {Record<string, HTMLElement>} o.els composerEls の結果
 * @param {string} [o.prefix] 頭（候補の id などに使う）
 * @param {Function} o.t
 * @param {object} o.attach createComposerAttachments の引数（strip は els.attached を使う）
 * @param {() => boolean} [o.isPlain] 平文の形（シェルの形の間）
 * @param {object} o.wait createComposerWait の残りの引数 { runMark, onChange, ... }
 * @param {Array<(e: KeyboardEvent) => boolean>} [o.keys] 送信より先にキーを取る部品（シェル・候補）。true を返したら取った
 * @param {() => void} o.onSubmit 送信（Ctrl/⌘+Enter・送信ボタン）
 * @param {() => void} [o.onSchedule] 送信の日時の面を開く（Ctrl/⌘+Shift+Enter）
 */
export function createComposer({ els, prefix = '', t, attach, isPlain = () => false, wait, keys = [], onSubmit, onSchedule = () => {} }) {
  const prompt = els.prompt;
  const parts = {};
  const att = createComposerAttachments({ ...attach, strip: els.attached });
  const editor = createMarkdownEditor(prompt, { ...att.editorOptions, isPlain });
  att.bind(editor, prompt);
  const composerWait = createComposerWait({ box: els.cbox, prompt, send: els.send, note: els.composerNote,
    busyLine: els.composerBusy, busyText: els.composerBusyText, t, ...wait });

  /**
   * 欄の高さの上限を決める。1 行から始めて中身に合わせて伸び（CSS）、上限はマウス 10 行・タッチ 6 行（promptMaxLines）。
   * その先は欄の中でスクロールする（送信の行は常に見える）。画面が低いとき（キーボードが出ている）は画面の 40% でも止める
   */
  function fit() {
    const css = getComputedStyle(prompt);
    const line = parseFloat(css.lineHeight) || 22;
    const pad = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
    prompt.style.maxHeight = `${promptMaxHeight({ line, pad, touch: matchMedia('(pointer:coarse)').matches, viewport: innerHeight })}px`;
  }

  els.composer.onsubmit = (e) => { e.preventDefault(); onSubmit(); };
  prompt.onkeydown = (e) => {
    if (isComposingKey(e)) return;
    for (const take of keys) if (take(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (e.shiftKey) onSchedule(); else onSubmit(); }
  };
  prompt.addEventListener('input', fit);
  addEventListener('resize', fit);

  // 外から差し込む部品（通話のマイク・スピーカーなど）の置き場。送信ボタンのすぐ左に 1 つの枠を置き、中に並べる
  let slot = null;
  function partSlot() {
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'crow-slot';
      els.send.parentElement.insertBefore(slot, els.send);
    }
    return slot;
  }
  function addPart(node) {
    partSlot().append(node);
    parts.controls?.fit();
    return () => { node.remove(); parts.controls?.fit(); };
  }

  return {
    els, editor, attach: att, wait: composerWait, fit, addPart,
    /** 通話モードの差し込み口の composer（web/voice/index.mjs の slot.composer）。マイクとスピーカーは送信の左のスロットに入る */
    voiceSlot: () => ({ root: els.composer, row: partSlot(), before: null, below: els.cbox, refit: () => parts.controls?.fit() }),
    get controls() { return parts.controls ?? null; },
    get sendMenu() { return parts.sendMenu ?? null; },
    get slash() { return parts.slash ?? null; },
    get shell() { return parts.shell ?? null; },
    /** 設定のチップ（作業ディレクトリ・モデル・承認モード。web/composer-controls.mjs） */
    useControls({ cmd, get, on }) {
      parts.controls = setupComposerControls({ cmd, get, on, els: {
        chips: { cwd: els.cwdChip, model: els.modelChip, mode: els.modeChip },
        pops: { cwd: els.cwdPop, model: els.modelPop, mode: els.modePop } } });
      return parts.controls;
    },
    /** 送信の日時の面（▾・送信の円の右クリックと長押し・Ctrl+Shift+Enter。web/send-menu.mjs） */
    useSchedule(o) {
      parts.sendMenu = setupSendMenu({ send: els.send, more: els.sendMore, pop: els.sendPop, veil: els.sendVeil, narrow: matchMedia('(max-width:480px)'), ...o });
      return parts.sendMenu;
    },
    /** 欄の「/」のスキル候補（web/slash-skills.mjs） */
    useSlash(o) {
      parts.slash = setupSlashSkills({ input: prompt, list: els.skillList, hint: els.slashHint, idPrefix: prefix ? `${prefix}-slash-option` : 'slash-option', ...o });
      return parts.slash;
    },
    /** 欄の `!`（web/shell-composer.mjs） */
    useShell(o) {
      parts.shell = createShellComposer({ box: els.cbox, prompt, head: els.shellHead, send: els.send, t, ...o });
      prompt.addEventListener('beforeinput', (e) => parts.shell.beforeinput(e));
      prompt.addEventListener('input', () => parts.shell.input());
      return parts.shell;
    },
    /** 失敗などの一行（欄の上の #settingsError） */
    say(text) { if (els.settingsError) els.settingsError.textContent = text ?? ''; },
    focus(o) { prompt.focus?.(o); },
    destroy() {
      removeEventListener('resize', fit);
      parts.controls?.destroy?.();
      editor.destroy?.();
    },
  };
}
