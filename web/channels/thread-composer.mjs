// スレッドの入力欄（docs/design-system.md「入力欄と上端」「スレッドの空間モデル」、ADR 9101）。Chats の会話の入力欄と同じ部品
// （web/composer/composer.mjs。骨組みは Chats の欄の写しで、id の頭は th: thPrompt・thSend…）に、スレッドの持ち物を足す:
//   - 宛先のチップ（行の先頭。このスレッドの bot → ほかのメンバー）。選ぶと channels.post の to で送る（本文の @ が先に効く）
//   - 「@」の補完（mention-complete.mjs）・誰も @ していない文への提案・@here / @everyone の人数の確認（ADR 0121）
//   - 書きかけはスレッドごとに端末へ（流れの入力欄と同じ入れ物。ch-composer.mjs の draftStore）
// まだ使わない部品（作業ディレクトリ・モデル・承認モードのチップ、送信の日時、待ち行列、文脈の帯、中断・再開）は隠す（段ごとに開ける）。
// 口は流れの入力欄（createChComposer）と同じ形にしてある（thread.mjs がそのまま使う）。
import { buildComposer, composerEls, createComposer } from '../composer/composer.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { draftStore, persistDrafts } from './ch-composer.mjs';
import { runMark } from '../arc.mjs';
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { botIcon } from './bot-icon.mjs';

const PREFIX = 'th';
const SAVE_WAIT_MS = 400;
/** スレッドではまだ使わない部品（段ごとに開ける） */
const UNUSED = ['cwdChip', 'modelChip', 'modeChip', 'sendMore', 'armedChip', 'draftSaved', 'abort', 'resume', 'contextStrip', 'outbox', 'nextSettings',
  'shellHead', 'resumeNote', 'armedNote', 'draftFail', 'connNote'];

/**
 * @param {object} o
 * @param {object} o.host setupChannels の host
 * @param {() => string|null} o.bucket 添付の置き場の分け先（チャンネルの id）
 * @param {() => object[]} o.candidates @ の候補
 * @param {() => object|null} [o.suggest] 誰も @ していないときに勧める bot
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {(text: string) => Promise<{required: boolean, botIds: string[]}>} [o.wakePreview]
 * @param {(post: { text: string, attachments: object[], confirmedWake?: string[], to?: string }) => Promise<void>} o.onSend
 * @param {() => { inThread: object[], others: object[], fallback: string|null }} [o.dest] 宛先の候補（bot は { id, name, icon, iconImage, state }）と、選んでいないときの宛先
 * @param {() => void} [o.onDestChange] 宛先が替わった（placeholder を合わせる）
 */
export function createThreadComposer({ host, bucket = () => null, candidates, suggest = () => null, backendLabel, wakePreview, onSend, dest = () => ({ inThread: [], others: [], fallback: null }), onDestChange = () => {} }) {
  const form = buildComposer(PREFIX);
  form.classList.add('th-composer');
  form.noValidate = true;
  const els = composerEls(PREFIX, form);
  for (const part of UNUSED) if (els[part]) els[part].hidden = true;

  // ---- スレッドの持ち物（提案・集団宛ての確認・@ の候補）。入力の箱の上に置く
  const hint = el('div', 'ch-hint');
  hint.hidden = true;
  const wakeCard = el('div', 'ch-wake-confirm card');
  wakeCard.hidden = true;
  wakeCard.setAttribute('role', 'group');
  wakeCard.setAttribute('aria-label', t('channels:feed.wakeConfirm.label'));
  const wakeText = el('span', 'ch-wake-count');
  const wakeCancel = el('button', 'btn', t('channels:feed.wakeConfirm.cancel'));
  wakeCancel.type = 'button';
  const wakeButton = el('button', 'btn btn-primary', t('channels:feed.wakeConfirm.wake'));
  wakeButton.type = 'button';
  wakeCard.append(wakeText, wakeCancel, wakeButton);
  const list = el('ul', 'mention-list');
  list.id = `${PREFIX}Mentions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('channels:feed.mention.label'));
  list.hidden = true;
  els.cbox.before(hint, wakeCard, list);
  const input = els.prompt;
  input.setAttribute('aria-controls', list.id);

  // ---- 宛先のチップ（行の先頭、添付の後）
  const destChip = el('button', 'chip dest');
  destChip.type = 'button';
  destChip.hidden = true;   // 描くのはスレッドを開いてから（setDraftKey・refresh。作る時点では候補を読めない）
  destChip.setAttribute('aria-haspopup', 'menu');
  els.attach.after(destChip);
  let chosen = null;   // 人が選んだ宛先（null = 選んでいない。このスレッドの決まりで決まる）

  let busy = false, disabled = false, noteTimer = null, draftKey = null, saveTimer = null, pendingWake = null;
  const dismissWake = () => { pendingWake = null; wakeCard.hidden = true; };
  wakeCancel.onclick = dismissWake;
  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    els.settingsError.textContent = text ?? '';
    if (text && !sticky) noteTimer = setTimeout(() => { els.settingsError.textContent = ''; }, 6000);
  };

  // ---- 書きかけ
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!draftKey) return;
    const d = { text: input.value ?? '', attached: c.attach.items, at: Date.now() };
    if (!d.text.trim() && !d.attached.length) draftStore().delete(draftKey); else draftStore().set(draftKey, d);
    persistDrafts();
  }
  const saveDraftSoon = () => { if (saveTimer === null) saveTimer = setTimeout(saveDraft, SAVE_WAIT_MS); };
  function adopt(owner, item) {
    const d = draftStore().get(owner) ?? { text: '', attached: [], at: 0 };
    draftStore().set(owner, { ...d, attached: [...d.attached, item], at: Date.now() });
    persistDrafts();
  }

  const c = createComposer({
    els, prefix: PREFIX, t,
    attach: {
      host, bucket, owner: () => draftKey ?? '', accepts: () => !disabled, say, adopt, originOf: () => 'device',
      onChange: () => { dismissWake(); saveDraft(); paintHint(); },
    },
    wait: { runMark, onChange: () => syncSend() },
    keys: [(e) => mention.keydown(e)],
    onSubmit: () => submit(),
  });
  const att = c.attach;
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${PREFIX}-mention`, backendLabel, onChange: () => paintHint() });

  // クリップ: この端末のファイルを選ぶ（出どころの面はチャンネルには無い。ADR 0116）
  els.attach.addEventListener('pointerdown', att.rememberAt, true);
  els.attach.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') att.rememberAt(); }, true);
  els.attach.addEventListener('click', () => { if (!disabled) els.fileIn.click(); });
  els.fileIn.onchange = () => { att.attachFiles([...els.fileIn.files]); els.fileIn.value = ''; };

  function syncSend() { els.send.disabled = busy || disabled || Boolean(att.blockReason()); }

  // ---- 宛先
  const destNow = () => {
    const d = dest();
    const all = [...(d.inThread ?? []), ...(d.others ?? [])];
    const id = chosen && all.some((b) => b.id === chosen) ? chosen : d.fallback;
    return { bot: all.find((b) => b.id === id) ?? null, all, d };
  };
  function paintDest() {
    const { bot, all } = destNow();
    destChip.hidden = !all.length;
    destChip.replaceChildren();
    if (bot) destChip.append(botIcon(bot, 'av xs'), el('span', 'v', bot.name));
    else destChip.append(el('span', 'v', t('channels:thread.dest.auto')));
    destChip.append(el('span', 'cv', '▾'));
    const label = bot ? t('channels:thread.dest.label', { name: bot.name }) : t('channels:thread.dest.auto');
    destChip.title = label;
    destChip.setAttribute('aria-label', label);
    destChip.classList.toggle('chosen', Boolean(chosen));
    c.controls?.fit?.();
  }
  // i18n-dynamic: channels:side.botState.
  const stateText = (b) => t(`channels:side.botState.${['working', 'waiting', 'resting'].includes(b.state) ? b.state : 'idle'}`);
  destChip.onclick = () => {
    const { bot, d } = destNow();
    const item = (b) => ({ label: b.name, hint: stateText(b), checked: bot?.id === b.id, onClick: () => { chosen = b.id; paintDest(); onDestChange(); input.focus(); } });
    const items = [];
    if (d.inThread?.length) items.push({ label: t('channels:thread.dest.inThread'), disabled: true }, ...d.inThread.map(item));
    if (d.others?.length) {
      if (items.length) items.push({ sep: true });
      items.push({ label: d.inThread?.length ? t('channels:thread.dest.others') : t('channels:thread.dest.members'), disabled: true }, ...d.others.map(item));
    }
    const r = destChip.getBoundingClientRect();
    host.showMenu(r.left, r.top - 4, items, t('channels:thread.dest.title'));
  };

  // ---- 提案（誰も @ していない文に）
  function paintHint() {
    const text = input.value.trim();
    const bot = text && !disabled && !chosen ? suggest() : null;
    if (!bot || /@/.test(text)) { hint.hidden = true; return; }
    hint.replaceChildren(el('span', null, t('channels:feed.hint.nobody')));
    const b = el('button', null, t('channels:feed.hint.call', { name: bot.name }));
    b.type = 'button';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      input.setRangeText(`@${bot.name} `, 0, 0, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    };
    hint.append(b);
    hint.hidden = false;
  }

  // ---- 送る
  async function sendBody(body, confirmedWake) {
    busy = true;
    syncSend();
    wakeButton.disabled = true;
    say('');
    try {
      await onSend({ ...body, ...(confirmedWake ? { confirmedWake } : {}), ...(chosen ? { to: chosen } : {}) });
      input.value = '';
      att.clear();
      dismissWake();
      saveDraft();
      paintHint();
      c.fit();
    } catch (err) {
      dismissWake();
      say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true);
    } finally {
      busy = false;
      syncSend();
      wakeButton.disabled = false;
    }
  }
  async function submit() {
    if (busy || disabled || pendingWake) return;
    const body = att.compose(input.value);
    if (!body.text.trim() && !body.attachments.length) return;
    const block = att.blockReason();
    if (block) { say(block); att.flash(); return; }
    if (wakePreview && /[@＠](?:here|everyone)(?![\p{L}\p{N}_-])/iu.test(body.text)) {
      const owner = draftKey;
      busy = true;
      syncSend();
      try {
        const preview = await wakePreview(body.text);
        if (owner !== draftKey || JSON.stringify(att.compose(input.value)) !== JSON.stringify(body)) return;
        if (preview.required) {
          pendingWake = { body, botIds: preview.botIds };
          wakeText.textContent = t('channels:feed.wakeConfirm.count', { count: preview.botIds.length });
          wakeCard.hidden = false;
          wakeButton.focus();
          return;
        }
      } catch (err) { say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true); return; }
      finally { busy = false; syncSend(); }
    }
    await sendBody(body);
  }
  wakeButton.onclick = () => { if (pendingWake && !busy && !disabled) sendBody(pendingWake.body, pendingWake.botIds); };

  input.addEventListener('input', () => { dismissWake(); if (els.settingsError.textContent && !busy) say(''); paintHint(); saveDraftSoon(); });
  input.addEventListener('blur', saveDraft);
  const onHidden = () => { if (document.visibilityState === 'hidden') saveDraft(); };
  document.addEventListener('visibilitychange', onHidden);
  addEventListener('pagehide', saveDraft);
  // 箱のどこを押しても字の欄へ（Chats の入力欄と同じ）
  els.cbox.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .md-b, [contenteditable], input')) return;
    e.preventDefault();
    input.focus();
  });

  return {
    el: form,
    input,
    editor: c.editor,
    attach: att,
    composer: c,
    focus: () => input.focus({ preventScroll: true }),
    setPlaceholder(text) { input.placeholder = text; },
    setDisabled(on, reason = '') {
      disabled = Boolean(on);
      input.disabled = disabled;
      form.classList.toggle('disabled', disabled);
      syncSend();
      say(on ? reason : '', true);
      paintHint();
    },
    refresh() { paintHint(); paintDest(); c.fit(); },
    say,
    clear() { dismissWake(); input.value = ''; att.clear(); say(''); saveDraft(); paintHint(); },
    mention,
    /** 宛先: 今の宛先の bot（選んでいなければこのスレッドの決まりの bot）と、人が選んだか */
    get dest() { const { bot } = destNow(); return { bot, chosen: Boolean(chosen) }; },
    setDraftKey(key) {
      if (key === draftKey) return;
      dismissWake();
      saveDraft();
      draftKey = key;
      chosen = null;   // 宛先はスレッドごと（別のスレッドへ移ったら、そのスレッドの決まりに戻る）
      const d = key ? draftStore().get(key) : null;
      att.restore(d?.attached);
      input.value = d?.text ?? '';
      say('');
      paintHint();
      paintDest();
    },
    saveDraft,
    bindDropZone: (zone) => att.bindDropZone(zone),
    /** 通話モードの差し込み口の composer（web/voice/index.mjs）。マイクとスピーカーは送信の左のスロット */
    voiceSlot: () => c.voiceSlot(),
    destroy() { saveDraft(); document.removeEventListener('visibilitychange', onHidden); removeEventListener('pagehide', saveDraft); c.destroy(); },
  };
}
