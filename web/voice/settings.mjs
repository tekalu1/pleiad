// 設定 › 通話（承認済み 2026-10-06。docs/voice-call.md「設定とキー」）。
// OpenRouter のキーはホストだけが持つ（登録・削除は WS の setVoiceKey・deleteVoiceKey。画面にはキーを返さず、登録済みかだけを見せる）。
// モデル・声・言語・上限・エコー除去は設定の一覧の voice（settings.set。値の検査・保存はホストが同じ定義を通す）。変えたらその場で保存する。
// 状態はホストが持つ（invoke の voice.status と、変わるたびに届く voiceChanged・settingsChanged）。面と部品は設定の管理の面（web/manage-panel.css の .mp-*）。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';

const DEFAULTS = { sttModel: 'microsoft/mai-transcribe-2', sttFallbackModel: 'assemblyai/universal-3-5-pro', ttsModel: 'x-ai/grok-voice-tts-1.0', ttsVoice: 'eve' };
const minutes = (seconds) => Math.round(seconds / 60);

/**
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd  WS コマンド
 * @param {(page: string) => void} o.page  設定のページを切り替える（onboarding.page）
 */
export function setupVoiceSettings({ cmd, page }) {
  const $ = (id) => document.getElementById(id);
  const root = $('voicePanel');
  const tab = $('voiceTab');
  if (!root || !tab) return { event() {}, load() {} };
  let status = null, message = '', checkText = '', busy = false, keyOpen = false;

  const invoke = (op, args = {}) => cmd('invoke', { op, args });
  const say = (text) => { message = text; const line = root.querySelector('.vc-status'); if (line) line.textContent = text; };

  async function load() {
    try { status = await invoke('voice.status'); } catch (e) { status = null; say(t('voice.settings.loadFailed', { error: e?.message ?? String(e) })); }
    paint();
  }

  async function save(patch) {
    if (busy) return;
    busy = true;
    try { await invoke('settings.set', { key: 'voice', value: patch }); say(t('voice.settings.saved')); }
    catch (e) { say(t('voice.settings.failed', { error: e?.message ?? String(e) })); }
    busy = false;
    await load();
  }

  async function setKey(value) {
    if (busy) return;
    busy = true;
    try {
      const res = await cmd('setVoiceKey', { key: value });
      // i18n-dynamic: voice.settings.key.check.
      checkText = t(`voice.settings.key.check.${res?.check ?? 'unreachable'}`);
      keyOpen = false;
      say(t('voice.settings.key.saved'));
    } catch (e) { say(t('voice.settings.failed', { error: e?.message ?? String(e) })); }
    busy = false;
    await load();
  }
  async function deleteKey() {
    if (busy) return;
    busy = true;
    try { await cmd('deleteVoiceKey', {}); checkText = ''; say(t('voice.settings.key.deleted')); }
    catch (e) { say(t('voice.settings.failed', { error: e?.message ?? String(e) })); }
    busy = false;
    await load();
  }

  const button = (label, onclick, cls = 'btn') => { const b = el('button', cls, label); b.type = 'button'; b.onclick = onclick; return b; };

  function field(label, hint, input) {
    const wrap = el('label', 'mp-field');
    wrap.append(el('span', null, label), input);
    if (hint) wrap.append(el('small', null, hint));
    return wrap;
  }
  function textInput(key, value, placeholder) {
    const input = el('input');
    input.type = 'text'; input.value = value; input.placeholder = placeholder ?? ''; input.spellcheck = false; input.autocomplete = 'off';
    input.onchange = () => save({ [key]: input.value.trim() === '' && key !== 'sttFallbackModel' ? null : input.value.trim() });
    return input;
  }
  function numberInput(key, value) {
    const input = el('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(value);
    input.onchange = () => { const n = Number(input.value); if (Number.isInteger(n)) save({ [key]: n }); else load(); };
    return input;
  }

  function keySection(s) {
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('voice.settings.key.title')));
    const card = el('div', 'nf-card');
    const row = el('div', 'mp-row');
    const info = el('div', 'mp-card-info');
    info.append(el('strong', null, s.hasKey ? t('voice.settings.key.set') : t('voice.settings.key.unset')));
    if (checkText) info.append(el('small', null, checkText));
    const actions = el('div', 'mp-card-actions');
    if (s.hasKey) actions.append(button(t('voice.settings.key.replace'), () => { keyOpen = !keyOpen; paint(); }), button(t('voice.settings.key.delete'), deleteKey));
    row.append(info, actions);
    card.append(row);
    if (!s.hasKey || keyOpen) {
      const form = el('form', 'rt-key-form');
      const keyrow = el('div', 'mp-keyrow');
      const input = el('input');
      input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'sk-or-…';
      input.setAttribute('aria-label', t('voice.settings.key.title'));
      const show = button(t('voice.settings.key.show'), () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? t('voice.settings.key.show') : t('voice.settings.key.hide'); });
      keyrow.append(input, show);
      const submit = el('button', 'btn btn-primary', t('voice.settings.key.save'));
      submit.type = 'submit';
      const formActions = el('div', 'mp-card-actions');
      formActions.append(submit);
      form.append(keyrow, formActions);
      form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) setKey(input.value); };
      card.append(form);
    }
    sec.append(card);
    sec.append(el('p', 'mp-note', t('voice.settings.key.note')));
    if (s.storage) sec.append(el('p', 'mp-note', s.storage.encrypted ? t('voice.settings.key.encrypted') : t('voice.settings.key.plain')));
    return sec;
  }

  function modelsSection(v) {
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('voice.settings.models.title')));
    const card = el('div', 'nf-card');
    card.append(
      field(t('voice.settings.models.stt'), null, textInput('sttModel', v.sttModel, DEFAULTS.sttModel)),
      field(t('voice.settings.models.fallback'), t('voice.settings.models.fallbackHint'), textInput('sttFallbackModel', v.sttFallbackModel, DEFAULTS.sttFallbackModel)),
      field(t('voice.settings.models.tts'), null, textInput('ttsModel', v.ttsModel, DEFAULTS.ttsModel)),
      field(t('voice.settings.models.voice'), null, textInput('ttsVoice', v.ttsVoice, DEFAULTS.ttsVoice)),
    );
    const lang = el('select');
    for (const [value, label] of [['auto', t('voice.settings.models.auto')], ['ja', t('voice.settings.models.ja')], ['en', t('voice.settings.models.en')]]) {
      const o = el('option', null, label);
      o.value = value; o.selected = v.language === value;
      lang.append(o);
    }
    lang.onchange = () => save({ language: lang.value });
    card.append(field(t('voice.settings.models.language'), null, lang));
    sec.append(card);
    return sec;
  }

  function limitsSection(v, today) {
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('voice.settings.limits.title')));
    const card = el('div', 'nf-card');
    card.append(
      field(t('voice.settings.limits.call'), null, numberInput('maxCallMinutes', v.maxCallMinutes)),
      field(t('voice.settings.limits.daily'), null, numberInput('dailyLimitMinutes', v.dailyLimitMinutes)),
    );
    card.append(el('small', 'vc-today', t('voice.settings.limits.today', { minutes: minutes(today.callSeconds), stt: minutes(today.sttSeconds), chars: today.ttsChars.toLocaleString() })));
    sec.append(card, el('p', 'mp-note', t('voice.settings.limits.note')));
    return sec;
  }

  function audioSection(v) {
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('voice.settings.audio.title')));
    const card = el('div', 'nf-card');
    const label = el('label', 'mp-check');
    const box = el('input');
    box.type = 'checkbox'; box.checked = v.echoCancellation;
    box.onchange = () => save({ echoCancellation: box.checked });
    label.append(box, el('span', null, ` ${t('voice.settings.audio.echo')}`));
    card.append(label, el('small', null, t('voice.settings.audio.echoHint')));
    sec.append(card, el('p', 'mp-note', t('voice.settings.audio.permission')));
    return sec;
  }

  function paint() {
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused?.getAttribute?.('aria-label') ?? null;
    root.replaceChildren();
    root.append(el('p', null, t('voice.settings.intro')));
    if (status) {
      root.append(keySection(status), modelsSection(status.settings), limitsSection(status.settings, status.today), audioSection(status.settings));
    }
    const line = el('p', 'mp-state vc-status', message);
    line.setAttribute('role', 'status');
    root.append(line);
    if (keep) root.querySelector(`[aria-label="${CSS.escape(keep)}"]`)?.focus();
  }

  tab.onclick = () => { page('voice'); load(); };
  return {
    /** voiceChanged・settingsChanged（voice）が届いたとき。開いているときだけ取り直す */
    event(ev) { if (!root.hidden && (ev?.type === 'voiceChanged' || ev?.keys?.includes?.('voice'))) load(); },
    load,
  };
}
