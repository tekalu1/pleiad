// 設定 › 通話（承認済み 2026-10-06。docs/voice-call.md「設定とキー」）。
// 使う OpenRouter のキーは設定 › API キー（承認済み 2026-10-07。docs/design-system.md「設定 › API キー」）で選ぶ（WS の setApiKeyUse。画面にはキーを返さない）。
// 選んだときから音声と読み上げる文章が OpenRouter へ送られ、選ぶまでは何も送らない。未登録ならその場で登録でき、登録先は API キー。
// モデル・声・言語・上限・エコー除去は設定の一覧の voice（settings.set。値の検査・保存はホストが同じ定義を通す）。変えたらその場で保存する。
// 状態はホストが持つ（invoke の voice.status と、変わるたびに届く voiceChanged・settingsChanged）。面と部品は設定の管理の面（web/manage-panel.css の .mp-*）。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { apiKeyList, keySelect, registerForm, statusLine, manageLink } from '../api-key-ui.mjs';

const DEFAULTS = { sttModel: 'microsoft/mai-transcribe-2', sttFallbackModel: 'assemblyai/universal-3-5-pro', ttsModel: 'x-ai/grok-voice-tts-1.0', ttsVoice: 'eve' };
const minutes = (seconds) => Math.round(seconds / 60);

/**
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd  WS コマンド
 * @param {(page: string) => void} o.page  設定のページを切り替える（onboarding.page）
 * @param {(name: string) => void} [o.openPage]  設定のほかのページへ移る（API キー）
 */
export function setupVoiceSettings({ cmd, page, openPage = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const root = $('voicePanel');
  const tab = $('voiceTab');
  if (!root || !tab) return { event() {}, load() {} };
  let status = null, keys = null, message = '', busy = false, registering = false, focusKey = null;

  const invoke = (op, args = {}) => cmd('invoke', { op, args });
  const say = (text) => { message = text; const line = root.querySelector('.vc-status'); if (line) line.textContent = text; };

  async function load() {
    try { status = await invoke('voice.status'); } catch (e) { status = null; say(t('voice.settings.loadFailed', { error: e?.message ?? String(e) })); }
    // 選べるキー。取れなくても通話の設定は見せる（選ぶ欄だけ使えない）
    keys = await apiKeyList(cmd).catch(() => null);
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

  /** 通話に使うキーを選ぶ（null は使わない）。選んだときから送り始める */
  async function chooseKey(id) {
    if (busy) return;
    busy = true; focusKey = 'sel:voice';
    try {
      await cmd('setApiKeyUse', { use: 'voice', id });
      say(id ? t('apiKeys.voice.chosen') : t('apiKeys.voice.unchosen'));
    } catch (e) { say(t('voice.settings.failed', { error: e?.message ?? String(e) })); }
    busy = false;
    await load();
  }
  /** その場で登録して、通話に使う（登録先は API キー） */
  async function registerKey(value) {
    if (busy) return;
    busy = true; focusKey = 'sel:voice';
    try {
      const { id } = await cmd('setApiKey', { provider: 'openrouter', label: '', key: value });
      await cmd('setApiKeyUse', { use: 'voice', id });
      registering = false;
      // 登録の直後に確かめる（キーそのもの。料金はかからない）。確かめられなくても登録はできている
      await invoke('apiKeys.check', { id }).catch(() => null);
      say(t('apiKeys.voice.registered'));
    } catch (e) { say(t('voice.settings.failed', { error: e?.message ?? String(e) })); }
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
    info.append(el('strong', null, t('apiKeys.useKey')));
    const openrouter = (keys?.keys ?? []).filter(k => k.provider === 'openrouter');
    const current = openrouter.find(k => k.id === s.keyRef) ?? null;
    if (keys?.migration?.state === 'deferred') info.append(el('small', null, s.hasKey ? t('apiKeys.deferredInUse') : t('apiKeys.deferredShort')));
    else if (current) { const small = statusLine(current); small.append(' · ', manageLink(openPage)); info.append(small); }
    else info.append(el('small', null, t('apiKeys.voice.unset')));
    row.append(info);
    // 移行を保留している間は、選び直せない（古い置き場のまま使う。設定 › API キーに理由）
    if (keys && keys.migration?.state !== 'deferred') {
      const actions = el('div', 'mp-card-actions ak-sels');
      actions.append(keySelect({ keys: openrouter, current: current?.id ?? null, label: t('apiKeys.voice.selectLabel'), focusKey: 'sel:voice', provider: 'openrouter', choose: chooseKey,
        register: () => { registering = true; focusKey = 'regin'; paint(); } }).element);
      row.append(actions);
    }
    card.append(row);
    if (registering && keys) card.append(registerForm({ provider: 'openrouter', label: t('voice.settings.key.title'), storage: keys.storage ?? s.storage, focusKey: 'regin', onSubmit: registerKey,
      onCancel: () => { registering = false; focusKey = 'sel:voice'; paint(); } }));
    sec.append(card);
    if (keys?.migration?.state !== 'deferred') sec.append(el('p', 'mp-note', t('apiKeys.voice.note')));
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

  /** 丸い台の選び方（通知の一覧の「すべて | あなた待ち」と同じ形。role=radiogroup）。choices: [[値, 字]] */
  function segmented(name, current, choices, onPick) {
    const group = el('div', 'vc-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', name);
    for (const [value, label] of choices) {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === current));
      b.dataset.value = value;
      b.onclick = () => onPick(value);
      group.append(b);
    }
    return group;
  }

  /** 話の区切り（まとめ待ち）・割り込み・効果音（承認済み 2026-10-07）と、マイク */
  function audioSection(v) {
    const out = document.createDocumentFragment();
    const turn = el('section', 'nf-section');
    turn.append(el('h4', null, t('voice.settings.turn.title')));
    const turnCard = el('div', 'nf-card');
    // i18n-dynamic: voice.settings.turn.
    const turnChoices = ['short', 'standard', 'long'].map((k) => [k, t(`voice.settings.turn.${k}`)]);
    const est = el('p', 'mp-note vc-est', t(`voice.settings.turn.est.${v.turnHold}`));
    est.setAttribute('role', 'status');
    turnCard.append(el('small', null, t('voice.settings.turn.hint')), segmented(t('voice.settings.turn.label'), v.turnHold, turnChoices, (k) => save({ turnHold: k })), est, el('small', null, t('voice.settings.turn.tail')));
    turn.append(turnCard);

    const barge = el('section', 'nf-section');
    barge.append(el('h4', null, t('voice.settings.barge.title')));
    const bargeCard = el('div', 'nf-card');
    const bargeLabel = el('label', 'mp-check');
    const bargeBox = el('input');
    bargeBox.type = 'checkbox'; bargeBox.checked = v.bargeIn; bargeBox.disabled = !v.echoCancellation;
    bargeBox.onchange = () => save({ bargeIn: bargeBox.checked });
    bargeLabel.append(bargeBox, el('span', null, ` ${t('voice.settings.barge.label')}`));
    bargeCard.append(bargeLabel, el('small', null, t('voice.settings.barge.hint')));
    barge.append(bargeCard);

    const sounds = el('section', 'nf-section');
    sounds.append(el('h4', null, t('voice.settings.sounds.title')));
    const soundsCard = el('div', 'nf-card');
    // i18n-dynamic: voice.settings.sounds.
    const soundChoices = ['off', 'few', 'all'].map((k) => [k, t(`voice.settings.sounds.${k}`)]);
    soundsCard.append(segmented(t('voice.settings.sounds.label'), v.sounds, soundChoices, (k) => save({ sounds: k })), el('small', null, t('voice.settings.sounds.hint')));
    sounds.append(soundsCard);

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
    // 区切り・話して止める・エコー除去は、通話を始めるときに決まる（録音の制約・ready で渡す値）。通話中に替えたら次の通話から効く
    out.append(turn, barge, sounds, sec, el('p', 'mp-note vc-nextcall', t('voice.settings.nextCall')));
    return out;
  }

  function paint() {
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused?.getAttribute?.('aria-label') ?? null;
    const keepFk = focusKey ?? focused?.dataset?.fk ?? null;
    focusKey = null;
    root.replaceChildren();
    root.append(el('p', null, t('voice.settings.intro')));
    if (status) {
      root.append(keySection(status), modelsSection(status.settings), limitsSection(status.settings, status.today), audioSection(status.settings));
    }
    const line = el('p', 'mp-state vc-status', message);
    line.setAttribute('role', 'status');
    root.append(line);
    if (keepFk) root.querySelector(`[data-fk="${CSS.escape(keepFk)}"]`)?.focus({ preventScroll: true });
    else if (keep) root.querySelector(`[aria-label="${CSS.escape(keep)}"]`)?.focus();
  }

  tab.onclick = () => { page('voice'); load(); };
  return {
    /** voiceChanged・settingsChanged（voice）が届いたとき。開いているときだけ取り直す */
    event(ev) { if (!root.hidden && (ev?.type === 'voiceChanged' || ev?.type === 'apiKeysChanged' || ev?.keys?.includes?.('voice'))) load(); },
    load,
  };
}
