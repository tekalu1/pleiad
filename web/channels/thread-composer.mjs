// スレッドの入力欄（docs/design-system.md「入力欄と上端」「スレッドの空間モデル」、ADR 0157）。Chats の会話の入力欄と同じ部品
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
import { chipCaret, chipGlyph, defaultModeOf, destinationUsage, fitComposerRow, panel, paintWhoChip, renderModel, resolvedModel } from '../composer-controls.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { draftStore, persistDrafts } from './ch-composer.mjs';
import { runMark } from '../arc.mjs';
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { announce } from '../message-actions.mjs';

const PREFIX = 'th';
const SAVE_WAIT_MS = 400;
/** スレッドではまだ使わない部品（段ごとに開ける） */
const UNUSED = ['armedChip', 'draftSaved', 'abort', 'resume', 'contextStrip', 'usageChip', 'nextSettings',
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
 * @param {object} [o.edit] 「編集して再送信」の持ち分（web/composer/edit-mode.mjs の host）: target(id) → { time, tail } か null、send(ctx)、branch(ctx)、decorate(id, on, tail)、locate(id)
 */
export function createThreadComposer({ host, bucket = () => null, candidates, suggest = () => null, backendLabel, wakePreview, onSend, dest = () => ({ inThread: [], others: [], fallback: null }), onDestChange = () => {},
  settings = () => null, onSettings = async () => {}, schedules = () => [], compact = async () => {}, pending = () => [], withdrawPending = async () => {}, edit: editHost = {} }) {
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
  const destChip = el('button', 'chip model who dest');
  destChip.type = 'button';
  destChip.hidden = true;   // 描くのはスレッドを開いてから（setDraftKey・refresh。作る時点では候補を読めない）
  destChip.setAttribute('aria-haspopup', 'dialog');
  els.attach.after(destChip);
  let chosen = null;   // 人が選んだ宛先（null = 選んでいない。このスレッドの決まりで決まる）

  let busy = false, disabled = false, noteTimer = null, draftKey = null, saveTimer = null, pendingWake = null, pendingEdit = null;
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
    // 「編集中」も下書きと一緒に残す。スレッドを開き直した直後（投稿を読むまで）は、読み込んだままの状態を持ち越す
    const snap = edit.snapshot() ?? pendingEdit;
    const d = { text: input.value ?? '', attached: c.attach.items, at: Date.now(), ...(snap ? { edit: snap } : {}) };
    if (!d.text.trim() && !d.attached.length && !snap) draftStore().delete(draftKey); else draftStore().set(draftKey, d);
    persistDrafts();
    saveServerDraft();
  }
  // 下書きのサーバーの写し（drafts.*。ADR 0157 の F35）。端末の写しが先で、ここは 1.5 秒まとめて追いかける。端末に無いスレッドを開いたら読む
  let serverTimer = 0;
  const saveServerDraft = () => {
    clearTimeout(serverTimer);
    const key = draftKey;
    // 編集中の字は、まだ送っていない書きかけではない（ほかの端末の下書きにしない。戻したあとの保存が上書きする）
    if (!key || edit.active || pendingEdit) return;
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
  // 発言の ⋯ › 「編集して再送信」「再送信」: いつもの入力欄を「編集中」にする（web/composer/edit-mode.mjs。ADR 0177）。
  // 何を送るか・元の投稿の見せ方は thread.mjs（options.edit）。投稿を読み込むまでは、保存した状態を持っておく（syncEdit）
  const edit = c.useEdit({
    kind: 'reply', texts: { running: t('channels:thread.resend.running') }, announce: (text) => announce(text),
    host: {
      read: () => ({ text: input.value, attached: att.ordered() }),
      write: ({ text, attached }) => { c.shell?.reset?.(); att.restore(attached); input.value = text; c.fit(); paintHint(); },
      send: (ctx) => editHost.send(ctx), branch: (ctx) => editHost.branch(ctx),
      decorate: (id, on, tail) => editHost.decorate?.(id, on, tail), locate: (id) => editHost.locate?.(id),
      change: () => saveDraftSoon(),
    },
  });
  // 欄の「/」のスキル候補。候補は宛先の bot の会話の作業フォルダーから（/compact は宛先の bot の会話を圧縮する）
  const destSession = () => { const bot = destNow().bot; return bot ? settings(bot.id) : null; };
  c.useSlash({
    cwd: () => destSession()?.values?.cwd ?? '',
    canCompact: () => Boolean(destSession()?.sessionId),
    load: (cwd) => host.cmd('slashSkills', { cwd: cwd || undefined }),
    off: () => c.editor.inCode(),
  });
  // 欄の `!`: 宛先の bot の、このスレッドの会話の作業場所で走らせる（結果は次の配達に付く。ADR 0157・0054）
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
  chips.model.hidden = true;
  for (const chip of Object.values(chips)) { chip.removeAttribute('aria-controls'); chip.setAttribute('aria-haspopup', 'menu'); }
  let destinationPanel = null;
  let effortKey = '', threadEfforts = {};
  const quotaCache = new Map();
  const fitThreadRow = () => fitComposerRow(destChip.parentElement, { cwd: chips.cwd, who: destChip });
  addEventListener('resize', fitThreadRow);
  const rowObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(fitThreadRow) : null;
  rowObserver?.observe(destChip.parentElement);
  let vocabFor = null, vocab = { models: {}, modes: {} };
  const loadVocab = async (backend) => {
    if (!backend || vocabFor === backend) return;
    vocabFor = backend;
    vocab = (await host.vocab?.(backend).catch(() => null)) ?? { models: {}, modes: {} };
    paintSettings();
  };
  const leaf = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const chipKind = (chip) => (chip === chips.cwd ? 'cwd' : chip === chips.model ? 'model' : 'mode');
  const chipBody = (chip, text, changed) => {
    chip.replaceChildren(chipGlyph(chipKind(chip)), el('span', 'v', text), chipCaret());
    if (changed) { const dot = el('span', 'entry-dot'); dot.setAttribute('aria-hidden', 'true'); chip.append(dot); }
    chip.classList.toggle('changed', Boolean(changed));
  };
  function paintSettings() {
    const bot = destNow().bot;
    const s = bot ? settings(bot.id) : null;
    for (const chip of [chips.cwd, chips.mode]) chip.hidden = !s;
    if (!s) {
      destChip.replaceChildren(chipGlyph('model'), el('span', 'v', t('composer.destination.title')));
      destChip.setAttribute('aria-label', t('composer.destination.title'));
      fitThreadRow();
      return;
    }
    loadVocab(s.backend);
    const v = s.values, d = s.defaults;
    // 既定に従うモデルは、Chats のチップと同じく実際に当たるモデルの名前で出す
    const modelLabel = (vocab.models?.[v.model] ? resolvedModel(vocab.models, v.model).label : '') || v.model || t('chat.model.default');
    const changed = { model: (v.model ?? '') !== (d.model ?? '') || (v.effort ?? '') !== (d.effort ?? ''), mode: (v.mode ?? '') !== (d.mode ?? '') };
    chipBody(chips.cwd, leaf(v.cwd) || '~', false);
    chips.cwd.title = v.cwd ?? '';
    paintWhoChip(destChip, { bot: bot.plain ? null : bot, backend: s.backend, backendLabel: backendLabel?.(s.backend) ?? s.backend,
      model: modelLabel, effort: v.effort || resolvedModel(vocab.models, v.model).entry?.defaultEffort || '', changed: changed.model });
    // 承認モードを決めていない（bot なしで会話を作る前）は、エージェントの既定の承認モード
    const modeLabel = vocab.modes?.[v.mode || defaultModeOf(vocab.modes)]?.label ?? v.mode ?? '';
    chipBody(chips.mode, modeLabel, changed.mode);
    const modeValue = chips.mode.querySelector('.v');
    modeValue.replaceChildren(el('span', 'full', modeLabel), el('span', 'short', modeLabel.slice(0, 2)));
    const note = t('channels:thread.settings.note');
    chips.mode.title = `${vocab.modes?.[v.mode]?.label ?? v.mode ?? ''}${changed.mode ? ` · ${t('channels:thread.settings.changed')}` : ''}`;
    chips.mode.setAttribute('aria-label', `${t('chat.composer.mode')}: ${chips.mode.title}. ${note}`);
    chips.cwd.setAttribute('aria-label', `${t('chat.composer.cwd')}: ${v.cwd ?? ''}`);
    fitThreadRow();
    if (destinationPanel?.open) loadPanelData();
    repaintPanel();
  }
  /** 開いている面を描き直す。触っていた部品へフォーカスを戻す（data-key で引き直す） */
  function repaintPanel() {
    if (!destinationPanel?.open) return;
    const key = els.modelPop.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    destinationPanel.render(); destinationPanel.place();
    if (key) els.modelPop.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  const apply = async (patch) => {
    const bot = destNow().bot;
    if (!bot) return;
    try { await onSettings(bot.id, patch); } catch (err) { say(t('channels:thread.settings.failed', { error: err?.message ?? String(err) }), true); }
    paintSettings();
  };
  const menuAt = (chip, items, title) => { const r = chip.getBoundingClientRect(); host.showMenu(r.left, r.top - 4, items, title); };
  const noteItem = () => ({ head: t('channels:thread.settings.note'), wrap: true });
  // i18n-dynamic: channels:side.botState.
  const stateText = (b) => t(`channels:side.botState.${['working', 'waiting', 'resting'].includes(b.state) ? b.state : 'idle'}`);
  function modelTarget() {
    const { bot, d } = destNow();
    const s = bot && settings(bot.id);
    // 組み込みの bot（このスレッドで話した後も）は「bot なし」と、そのスレッドで動くエージェントのロゴ
    const options = (list) => list.map((b) => {
      const backend = b.plain ? settings(b.id)?.backend ?? b.backend : b.backend;
      return { id: b.id, name: b.plain ? t('channels:homeDest.none') : b.name, bot: b.plain ? null : b,
        backend, backendLabel: backendLabel?.(backend) ?? backend, state: stateText(b), waiting: b.state === 'waiting', working: b.state === 'working' };
    });
    const groups = [];
    if (d.inThread?.length) groups.push({ heading: t('channels:thread.dest.inThread'), options: options(d.inThread) });
    if (d.others?.length) groups.push({ heading: d.inThread?.length ? t('channels:thread.dest.others') : t('channels:thread.dest.members'), options: options(d.others) });
    // bot なし: そのとき動くエージェントのロゴ（選んでいなければ Chats の既定）
    if (d.plain) groups.push({ options: [{ id: d.plain.id, name: t('channels:homeDest.none'), bot: null, backend: settings(d.plain.id)?.backend }] });
    const pick = (id) => { chosen = id; paintDest(); onDestChange(); };
    if (!s) return { destination: { selected: null, groups, chooseOnly: true, onPick: pick } };
    const changed = !bot.plain && ((s.values.model ?? '') !== (s.defaults.model ?? '') || (s.values.effort ?? '') !== (s.defaults.effort ?? ''));
    return {
      backend: s.backend, backends: host.state?.backends ?? [], backendSwitchable: Boolean(bot.plain && !s.sessionId && (host.state?.backends?.length ?? 0) > 1),
      models: vocab.models, model: s.values.model, efforts: threadEfforts, effort: s.values.effort,
      effortDisabled: Object.keys(threadEfforts).length <= 1,
      destination: { selected: bot.id, groups, bot: bot.plain ? null : bot, threadPlain: Boolean(bot.plain), defaults: s.defaults,
        backendLabel: (id) => backendLabel?.(id) ?? id,
        usage: destinationUsage(quotaCache.get(s.backend), { open: host.openUsage }),
        changed, onReset: () => apply({ model: s.defaults.model ?? '', effort: s.defaults.effort ?? '' }),
        onPick: pick },
    };
  }
  destinationPanel = panel(destChip, els.modelPop, {
    align: 'left', width: 360,
    render: () => { const target = modelTarget(); if (target) renderModel({ pop: els.modelPop, target,
      on: { backend: v => apply({ backend: v, model: '', effort: '' }), model: v => apply({ model: v }), effort: v => apply({ effort: v }) },
      hide: () => destinationPanel.hide() }); },
    onShow: () => loadPanelData(true),
  });
  /** 面のエフォートの段と使用量を取る。宛先・エージェント・モデルが替わったら取り直す（使用量は開くたび） */
  function loadPanelData(opening = false) {
    const s = destNow().bot && settings(destNow().bot.id);
    if (!s) return;
    const key = `${s.backend}:${s.values.model}:${s.values.cwd}`;
    if (key !== effortKey) {
      effortKey = key; threadEfforts = {};
      const request = host.efforts?.({ backend: s.backend, model: s.values.model ?? '', cwd: s.values.cwd || undefined });
      request?.then(value => { if (effortKey === key) { threadEfforts = value ?? {}; repaintPanel(); } }).catch(() => {});
    }
    if (!opening && quotaCache.has(s.backend)) return;
    const quota = host.quota?.(s.backend);
    quota?.then(value => { quotaCache.set(s.backend, value); repaintPanel(); }).catch(() => {});
  }
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
    destChip.classList.toggle('chosen', Boolean(chosen));
    paintSettings();
  }

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
    if (edit.active) return edit.send();
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
      edit.reset();
      pendingEdit = null;
      draftKey = key;
      chosen = null;   // 宛先はスレッドごと（別のスレッドへ移ったら、そのスレッドの決まりに戻る）
      const d = key ? draftStore().get(key) : null;
      att.restore(d?.attached);
      input.value = d?.text ?? '';
      // 編集中だったスレッドは、投稿を読み込んだあと（syncEdit）に「編集中」へ戻す
      if (d?.edit) pendingEdit = d.edit;
      if (!d) void loadServerDraft(key);   // この端末に写しが無い: サーバーの写しを読む（ほかの端末で書いた続き）
      say('');
      paintHint();
      paintDest();
    },
    saveDraft,
    /** 「編集して再送信」の状態（begin・cancel など） */
    edit,
    /** 投稿を読み込んだ・増減した: 保存した編集中を戻す。元の投稿が無くなっていたら編集をやめ、消えるものの見立てが変わっていたら帯を直す */
    syncEdit() {
      if (edit.sending) return;
      if (pendingEdit) {
        const saved = pendingEdit;
        pendingEdit = null;
        edit.restore(saved, (id) => editHost.target?.(id) ?? null);
        return;
      }
      if (!edit.active) return;
      const found = editHost.target?.(edit.id);
      if (!found) edit.targetLost(); else edit.setTail(found.tail);
    },
    bindDropZone: (zone) => att.bindDropZone(zone),
    /** 通話モードの差し込み口の composer（web/voice/index.mjs）。マイクとスピーカーは送信の左のスロット */
    voiceSlot: () => c.voiceSlot(),
    destroy() { saveDraft(); document.removeEventListener('visibilitychange', onHidden); removeEventListener('pagehide', saveDraft);
      removeEventListener('resize', fitThreadRow); rowObserver?.disconnect(); destinationPanel?.hide(false); c.destroy(); },
  };
}
