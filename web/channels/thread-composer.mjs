// スレッドの入力欄（docs/design-system.md「入力欄と上端」「スレッドの空間モデル」、ADR 9101）。Chats の会話の入力欄と同じ部品
// （web/composer/composer.mjs。骨組みは Chats の欄の写しで、id の頭は th: thPrompt・thSend…）に、スレッドの持ち物を足す:
//   - 宛先のチップ（行の先頭。このスレッドの bot → ほかのメンバー）。選ぶと channels.post の to で送る（本文の @ が先に効く）
//   - 「@」の補完（mention-complete.mjs）・誰も @ していない文への提案・@here / @everyone の人数の確認（ADR 0121）
//   - 書きかけはスレッドごとに端末へ（流れの入力欄と同じ入れ物。ch-composer.mjs の draftStore）
//   - 宛先の bot の設定のチップ（作業フォルダー・モデルとエフォート・承認モード）。宛先の bot の、このスレッドの会話の値を出し、
//     変えるとこのスレッドだけに効く（channels.threadSettings。bot の既定と違えば「変更あり」の点）
// まだ使わない部品（送信の日時、待ち行列、文脈の帯、中断・再開）は隠す（段ごとに開ける）。
// 口は流れの入力欄（createChComposer）と同じ形にしてある（thread.mjs がそのまま使う）。
import { buildComposer, composerEls, createComposer } from '../composer/composer.mjs';
import { renderOutbox } from '../outbox.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { draftStore, persistDrafts } from './ch-composer.mjs';
import { runMark } from '../arc.mjs';
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { botIcon } from './bot-icon.mjs';

const PREFIX = 'th';
const SAVE_WAIT_MS = 400;
/** スレッドではまだ使わない部品（段ごとに開ける） */
const UNUSED = ['armedChip', 'draftSaved', 'abort', 'resume', 'contextStrip', 'nextSettings',
  'resumeNote', 'armedNote', 'draftFail', 'connNote'];

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
 * @param {(botId: string) => ({ backend: string, values: { model, effort, mode, cwd }, defaults: { model, effort, mode }, folders: string[] }|null)} [o.settings]
 *   宛先の bot のこのスレッドの会話の設定（無ければ bot の既定）。チップに出す
 * @param {(botId: string, patch: object) => Promise<void>} [o.onSettings] 設定を変えた（このスレッドだけ）
 * @param {() => object[]} [o.schedules] このスレッドへの返信の予定（schedule.json の kind post。時刻順）
 * @param {(sessionId: string) => Promise<void>} [o.compact] 宛先の bot の会話を圧縮する（/compact）
 * @param {() => { id: string, text: string }[]} [o.pending] bot へ届く前のあなたの投稿（送信待ちの行。投稿の順）
 * @param {(postId: string) => Promise<void>} [o.withdrawPending] 送信待ちの投稿を取り下げる（［取り消し］・［編集］）
 */
export function createThreadComposer({ host, bucket = () => null, candidates, suggest = () => null, backendLabel, wakePreview, onSend, dest = () => ({ inThread: [], others: [], fallback: null }), onDestChange = () => {},
  settings = () => null, onSettings = async () => {}, schedules = () => [], compact = async () => {}, pending = () => [], withdrawPending = async () => {} }) {
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
    saveServerDraft();
  }
  // 下書きのサーバーの写し（drafts.*。ADR 9101 の F35）。端末の写しが先で、ここは 1.5 秒まとめて追いかける。端末に無いスレッドを開いたら読む
  let serverTimer = 0;
  const saveServerDraft = () => {
    clearTimeout(serverTimer);
    const key = draftKey;
    if (!key) return;
    const text = input.value;
    serverTimer = setTimeout(() => { host.invoke('drafts.save', { key, text, at: Date.now() }).catch(() => {}); }, 1500);
  };
  async function loadServerDraft(key) {
    if (!key || input.value.trim()) return;
    const got = await host.invoke('drafts.load', { key }).catch(() => null);
    if (draftKey !== key || input.value.trim() || !got?.text) return;
    input.value = got.text;
    c.fit();
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
    keys: [(e) => mention.keydown(e), (e) => c.slash?.keydown(e)],
    onSubmit: () => submit(),
    onSchedule: () => c.sendMenu?.open(),
  });
  const att = c.attach;
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${PREFIX}-mention`, backendLabel, onChange: () => paintHint() });
  // 送信の日時（▾・送信の円の右クリックと長押し・Ctrl+Shift+Enter。ADR 0103）。時刻が来たら人の投稿として 1 回だけ投稿する（channels.schedulePost）
  c.useSchedule({
    context: () => ({ available: Boolean(input.value.trim() || att.items.length) && !disabled }),
    environment: async () => (await host.scheduleEnvironment?.().catch(() => null)) ?? { persistent: true, hostZone: null },
    onSchedule: (at) => submit({ at }),
    onSendNow: () => submit({ at: null }),
  });
  // 欄の「/」のスキル候補。候補は宛先の bot の会話の作業フォルダーから（/compact は宛先の bot の会話を圧縮する）
  const destSession = () => { const bot = destNow().bot; return bot ? settings(bot.id) : null; };
  c.useSlash({
    cwd: () => destSession()?.values?.cwd ?? '',
    canCompact: () => Boolean(destSession()?.sessionId),
    load: (cwd) => host.cmd('slashSkills', { cwd: cwd || undefined }),
    off: () => c.editor.inCode(),
  });
  // 欄の `!`: 宛先の bot の、このスレッドの会話の作業場所で走らせる（結果は次の配達に付く。ADR 9101・0054）
  c.useShell({
    availability: () => (destSession()?.sessionId ? { ok: true } : { ok: false, text: t('channels:thread.shellNoSession') }),
    where: () => ({ cwd: destSession()?.values?.cwd ?? '' }),
    touch: () => matchMedia('(pointer:coarse)').matches,
    onAsText: () => submit(),
    onChange: () => c.fit(),
  });
  async function runShell() {
    const command = input.value;
    const s = destSession();
    if (!command.trim() || !s?.sessionId) return;
    input.value = '';
    c.shell.exit();
    saveDraft();
    try { await host.cmd('runShell', { sessionId: s.sessionId, runId: `th-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, command, ...(s.values?.cwd ? { cwd: s.values.cwd } : {}) }); say(''); }
    catch (err) { c.shell.enter(); input.value = command; say(t('chat.shell.runFailed', { error: err?.message ?? String(err) }), true); }
  }
  // このスレッドへの返信の予定の行（送信待ちの行と同じ部品。今すぐ送る・編集・取り消す）
  const scheduleActions = {
    now: async (entry) => { await host.invoke('sessions.sendScheduledNow', { id: entry.id }); },
    cancel: async (entry) => { await host.invoke('sessions.cancelSchedule', { id: entry.id }); },
    // 本文を欄へ戻す（取り出した予定は時刻が来ても動かない）
    edit: async (entry) => {
      const taken = await host.invoke('sessions.cancelSchedule', { id: entry.id });
      const text = taken?.entry?.args?.prompt ?? entry.args?.prompt ?? '';
      input.value = input.value.trim() ? `${text}\n\n${input.value}` : text;
      input.focus();
      saveDraft();
    },
  };
  // 送信待ち（bot へ届く前のあなたの投稿）の行。［編集］は取り下げて本文を入力欄へ戻す、［取り消し］は取り下げる
  const pendingAction = async (postId, name) => {
    const row = pending().find((p) => p.id === postId);
    await withdrawPending(postId);
    if (name === 'edit' && row) { input.value = input.value.trim() ? `${row.text}\n\n${input.value}` : row.text; input.focus(); saveDraft(); }
  };
  function paintSchedules() {
    const queued = pending().map((p) => ({ id: p.id, status: 'queued', args: { prompt: p.text } }));
    renderOutbox(els.outbox, queued, pendingAction, new Set(), { schedules: schedules(), scheduleActions, editQueued: true });
  }

  // クリップ: この端末のファイルを選ぶ（出どころの面はチャンネルには無い。ADR 0116）
  els.attach.addEventListener('pointerdown', att.rememberAt, true);
  els.attach.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') att.rememberAt(); }, true);
  els.attach.addEventListener('click', () => { if (!disabled) els.fileIn.click(); });
  els.fileIn.onchange = () => { att.attachFiles([...els.fileIn.files]); els.fileIn.value = ''; };

  function syncSend() { els.send.disabled = busy || disabled || Boolean(att.blockReason()); }

  // ---- 宛先
  const destNow = () => {
    const d = dest();
    const all = [...(d.inThread ?? []), ...(d.others ?? []), ...(d.plain ? [d.plain] : [])];
    // 「bot なし」（'plain'）を選んだ後に組み込みの bot ができたら、その bot を指す
    const want = chosen === 'plain' ? all.find((b) => b.plain)?.id ?? chosen : chosen;
    const id = want && all.some((b) => b.id === want) ? want : d.fallback;
    return { bot: all.find((b) => b.id === id) ?? null, all, d };
  };
  // ---- 宛先の bot の設定のチップ（モックの 02。押すと一覧が浮く。選んだものはこのスレッドだけに効く）
  const chips = { cwd: els.cwdChip, model: els.modelChip, mode: els.modeChip };
  for (const chip of Object.values(chips)) { chip.removeAttribute('aria-controls'); chip.setAttribute('aria-haspopup', 'menu'); }
  let vocabFor = null, vocab = { models: {}, modes: {} };
  const loadVocab = async (backend) => {
    if (!backend || vocabFor === backend) return;
    vocabFor = backend;
    vocab = (await host.vocab?.(backend).catch(() => null)) ?? { models: {}, modes: {} };
    paintSettings();
  };
  const leaf = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const chipBody = (chip, text, changed) => {
    chip.replaceChildren(el('span', 'v', text), el('span', 'cv', '▾'));
    if (changed) { const dot = el('span', 'entry-dot'); dot.setAttribute('aria-hidden', 'true'); chip.append(dot); }
    chip.classList.toggle('changed', Boolean(changed));
  };
  function paintSettings() {
    const bot = destNow().bot;
    const s = bot ? settings(bot.id) : null;
    for (const chip of Object.values(chips)) chip.hidden = !s;
    if (!s) return;
    loadVocab(s.backend);
    const v = s.values, d = s.defaults;
    const modelLabel = vocab.models?.[v.model]?.label ?? (v.model || t('chat.model.default'));
    const changed = { model: (v.model ?? '') !== (d.model ?? '') || (v.effort ?? '') !== (d.effort ?? ''), mode: (v.mode ?? '') !== (d.mode ?? '') };
    chipBody(chips.cwd, leaf(v.cwd) || '~', false);
    chips.cwd.title = v.cwd ?? '';
    chipBody(chips.model, v.effort ? `${modelLabel} · ${v.effort}` : modelLabel, changed.model);
    chipBody(chips.mode, vocab.modes?.[v.mode]?.label ?? v.mode ?? '', changed.mode);
    const note = t('channels:thread.settings.note');
    chips.model.title = `${modelLabel}${changed.model ? ` · ${t('channels:thread.settings.changed')}` : ''}`;
    chips.mode.title = `${vocab.modes?.[v.mode]?.label ?? v.mode ?? ''}${changed.mode ? ` · ${t('channels:thread.settings.changed')}` : ''}`;
    chips.model.setAttribute('aria-label', `${t('chat.composer.model')}: ${chips.model.title}. ${note}`);
    chips.mode.setAttribute('aria-label', `${t('chat.composer.mode')}: ${chips.mode.title}. ${note}`);
    chips.cwd.setAttribute('aria-label', `${t('chat.composer.cwd')}: ${v.cwd ?? ''}`);
    c.controls?.fit?.();
  }
  const apply = async (patch) => {
    const bot = destNow().bot;
    if (!bot) return;
    try { await onSettings(bot.id, patch); } catch (err) { say(t('channels:thread.settings.failed', { error: err?.message ?? String(err) }), true); }
    paintSettings();
  };
  const menuAt = (chip, items, title) => { const r = chip.getBoundingClientRect(); host.showMenu(r.left, r.top - 4, items, title); };
  const noteItem = () => ({ head: t('channels:thread.settings.note'), wrap: true });
  chips.model.onclick = async () => {
    const bot = destNow().bot;
    const s = bot && settings(bot.id);
    if (!s) return;
    await loadVocab(s.backend);
    const efforts = await host.efforts?.({ backend: s.backend, model: s.values.model ?? '', cwd: s.values.cwd || undefined }).catch(() => null);
    const items = Object.entries(vocab.models ?? {}).filter(([id]) => id !== '').map(([id, m]) => ({
      label: m.label ?? id, hint: id === s.defaults.model ? t('channels:thread.settings.botDefault', { name: bot.name }) : (m.note ?? ''), checked: id === s.values.model,
      onClick: () => apply({ model: id }),
    }));
    const effortItems = Object.entries(efforts ?? {}).filter(([e]) => e !== '').map(([e, m]) => ({ label: m.label ?? e, checked: e === s.values.effort, onClick: () => apply({ effort: e }) }));
    menuAt(chips.model, [...items, ...(effortItems.length ? [{ sep: true }, { label: t('channels:thread.settings.effort'), sub: () => effortItems }] : []), { sep: true }, noteItem()], t('chat.composer.model'));
  };
  chips.mode.onclick = async () => {
    const bot = destNow().bot;
    const s = bot && settings(bot.id);
    if (!s) return;
    await loadVocab(s.backend);
    const items = Object.entries(vocab.modes ?? {}).map(([id, m]) => ({
      label: m.label ?? id, hint: id === s.defaults.mode ? t('channels:thread.settings.botDefault', { name: bot.name }) : (m.note ?? ''), checked: id === s.values.mode,
      onClick: () => apply({ mode: id }),
    }));
    menuAt(chips.mode, [...items, { sep: true }, noteItem()], t('chat.composer.mode'));
  };
  chips.cwd.onclick = () => {
    const bot = destNow().bot;
    const s = bot && settings(bot.id);
    if (!s) return;
    const items = s.folders.map((p) => ({ label: leaf(p) || p, hint: p, checked: p === s.values.cwd, onClick: () => apply({ cwd: p }) }));
    menuAt(chips.cwd, [...items, { sep: true }, noteItem()], t('chat.composer.cwd'));
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
    paintSettings();
  }
  // i18n-dynamic: channels:side.botState.
  const stateText = (b) => t(`channels:side.botState.${['working', 'waiting', 'resting'].includes(b.state) ? b.state : 'idle'}`);
  destChip.onclick = () => {
    const { bot, d } = destNow();
    const item = (b) => ({ label: b.name, hint: stateText(b), checked: bot?.id === b.id, onClick: () => { chosen = b.id; paintDest(); onDestChange(); input.focus(); } });
    const items = [];
    if (d.inThread?.length) items.push({ head: t('channels:thread.dest.inThread') }, ...d.inThread.map(item));
    if (d.others?.length) {
      if (items.length) items.push({ sep: true });
      items.push({ head: d.inThread?.length ? t('channels:thread.dest.others') : t('channels:thread.dest.members') }, ...d.others.map(item));
    }
    // 組み込みの bot（人格・記憶を持たない。モデル・承認モード・作業場所をチップで直接選ぶ。ADR 9101）
    if (d.plain) {
      if (items.length) items.push({ sep: true });
      items.push({ label: t('channels:plain.choose'), hint: t('channels:plain.hint'), checked: bot?.id === d.plain.id, onClick: () => { chosen = d.plain.id; paintDest(); onDestChange(); input.focus(); } });
    }
    const r = destChip.getBoundingClientRect();
    host.showMenu(r.left, r.top - 4, items, t('channels:thread.dest.title'));
  };

  // ---- 提案（誰も @ していない文に）。宛先のチップに bot が出ているとき（その bot が受ける）は出さない
  function paintHint() {
    const text = input.value.trim();
    const bot = text && !disabled && !chosen && !destNow().bot ? suggest() : null;
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
  // 送り直し（応答が届かなかった）でも二重に投稿しないよう、同じ中身には同じ clientId を使う（サーバーが同じ id の投稿を作らない）
  let attempt = null;
  const clientIdOf = (body, at) => {
    const key = JSON.stringify([body, at ?? null, chosen]);
    if (attempt?.key !== key) attempt = { key, id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
    return attempt.id;
  };
  async function sendBody(body, confirmedWake, at = null) {
    busy = true;
    syncSend();
    wakeButton.disabled = true;
    say('');
    try {
      await onSend({ ...body, ...(confirmedWake ? { confirmedWake } : {}), ...(chosen ? { to: chosen } : {}), clientId: clientIdOf(body, at), ...(at ? { at } : {}) });
      attempt = null;
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
  async function submit({ at = null } = {}) {
    if (busy || disabled || pendingWake) return;
    if (c.shell?.active) return runShell();
    if (c.shell?.blocked) return c.shell.flash?.();
    c.slash?.close();
    const body = att.compose(input.value);
    if (!body.text.trim() && !body.attachments.length) return;
    const block = att.blockReason();
    if (block) { say(block); att.flash(); return; }
    // /compact: 宛先の bot の、このスレッドの会話を圧縮する（投稿にはしない）
    if (body.text.trim() === '/compact' && !body.attachments.length) {
      const s = destSession();
      if (!s?.sessionId) { say(t('channels:thread.compactNoSession')); return; }
      busy = true; syncSend();
      try { await compact(s.sessionId); input.value = ''; saveDraft(); }
      catch (err) { say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true); }
      finally { busy = false; syncSend(); }
      return;
    }
    if (at) { await sendBody(body, null, at); return; }
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
    refresh() { paintHint(); paintDest(); paintSchedules(); c.fit(); },
    /** 予定が動いた */
    paintSchedules,
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
      if (!d) void loadServerDraft(key);   // この端末に写しが無い: サーバーの写しを読む（ほかの端末で書いた続き）
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
