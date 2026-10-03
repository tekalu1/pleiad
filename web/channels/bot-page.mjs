// bot のページと作成（W4。ADR 0109・docs/channels.md「bot のページ」・承認済みのモック 05）。
// #channelsBody の中に section#botView.bot-page を作る。見せるのは show({ kind: 'bot', id }) のとき（id が 'new' なら作る画面）。
//
// 設定は Chats の入力欄と同じ程度に簡単にする:
//   名前・アイコン（絵文字ピッカー）・人格（自由文）… 離れたときに bots.update
//   エージェント・モデル・エフォート … 入力欄と同じ 1 つの選択（composer-controls.mjs の renderModel）。bots.update
//   承認モード … 入力欄と同じ選択（renderMode）。bots.setMode（人だけ。ADR 0082）
//   触れてよいフォルダー … 行（パス・読み書き/読み取り）と［フォルダーを足す］。bots.update の folders（置き換え）
//     実際に書き込みの範囲を限れないモード（範囲 full: Claude の YOLO・Codex の YOLO・Antigravity）だけ「すべてのフォルダー」で非活性（計画 §7.2-2）
//   他の会話に送る … スイッチ（既定 ON）。bots.update の sendToOthers
// 右に記憶の一覧（memory-list.mjs）と今週の使用量。操作はすべて host.invoke(op, args)。出来事は botsChanged・memoryChanged・channelsChanged。
// 認証・アカウント・1 日の上限・長い注記は出さない。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { openEmojiPicker, closeEmojiPicker } from '../emoji-picker.mjs';
import { panel, renderModel, renderMode, folderBrowser, isDanger, modelChipLabel, resolvedModel } from '../composer-controls.mjs';
import { splitChipLabel } from '../composer-layout.mjs';
import { createMemoryList } from './memory-list.mjs';
import * as M from './bot-model.mjs';

// 線画（composer-controls.mjs のチップと同じ。あちらは内部の定数）
const MODEL = ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3'];
const SHIELD = ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z'];
const WARN = ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5M12 17.2v.3'];
const CARET = ['M7 10l5 5 5-5'];
const FOLDER = ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'];
const FOLDER_ADD = ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 11v5M9.5 13.5h5'];
const LOCK = ['M7 11V8a5 5 0 0 1 10 0v3', 'M6 11h12v9H6z'];
const REPLY = ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v3'];
const CLOSE = ['M6 6l12 12M18 6L6 18'];

function glyph(paths, cls = 'i') {
  const svg = svgEl('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) svg.append(svgEl('path', { d }));
  return svg;
}
const caret = () => { const g = glyph(CARET); g.classList.add('caret'); return g; };
const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));
const show = (node, on) => { node.hidden = !on; };

export function createBotPage(host) {
  const body = document.getElementById('channelsBody');
  if (!body) return {};

  const S = {
    id: null,             // 見せている bot の id。'new' = 作る画面
    bot: null,            // bots.get の行（Bot + usage + state）
    draft: null,          // 作る画面の下書き（M.newDraft）
    v: null,              // 今の backend の語彙 { modes, models, efforts }
    vocab: new Map(),     // backend → { modes, models, efforts: Map<model, efforts> }
    bots: new Map(),      // id → Bot（記憶の出どころの字に使う）
    channels: new Map(),  // id → Channel
    sessions: () => new Map((host.state?.sessions ?? []).map((s) => [s.id, s])),
    gone: false,
    seq: 0,
    chain: Promise.resolve(),   // 保存を 1 本ずつ流す（続けて押しても順番を保つ）
  };
  // メインの頭（#channelsView > .top）は、bot のページを見せている間は見出しを引っ込める（bot のページ自身の頭が見出し。汎用の「Channels」は出さない）。
  // 流れの部品が show/hide で見出しを替える順（流れ → 自分）の後に付け外しする。頭は流れの有無で置き場所が動くので、その都度引く
  const topEl = () => document.getElementById('channelsPageTitle')?.closest('.top') ?? null;
  const navigate = (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail }));
  const vm = () => S.draft ?? S.bot;
  const unlimited = () => M.foldersUnlimited(S.v?.modes?.[vm()?.mode]);

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'bot-page');
  root.id = 'botView';
  root.hidden = true;

  const av = el('button', 'bp-av');
  av.type = 'button';
  av.setAttribute('aria-label', t('channels:bot.iconLabel'));
  av.title = t('channels:bot.iconLabel');
  const nameIn = el('input', 'bp-name');
  nameIn.id = 'botName';
  nameIn.type = 'text';
  nameIn.maxLength = 64;
  nameIn.autocomplete = 'off';
  nameIn.spellcheck = false;
  nameIn.setAttribute('aria-label', t('channels:bot.nameLabel'));
  nameIn.placeholder = t('channels:bot.namePlaceholder');
  const sub = el('div', 'bp-sub');
  const dmBtn = el('button', 'btn bp-dm');
  dmBtn.type = 'button';
  dmBtn.append(glyph(REPLY), t('channels:bot.openDm'));
  const createBtn = el('button', 'btn btn-primary bp-create', t('channels:bot.createButton'));
  createBtn.type = 'button';
  const idBox = el('div', 'bp-id');
  idBox.append(nameIn, sub);
  const head = el('div', 'bp-head');
  head.append(av, idBox, el('span', 'bp-spacer'), dmBtn, createBtn);

  const err = el('p', 'bp-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const notice = el('p', 'bp-gone');
  notice.hidden = true;

  // 人格
  const persona = el('textarea', 'bp-persona');
  persona.id = 'botPersona';
  persona.rows = 3;
  persona.maxLength = 6000;
  persona.spellcheck = false;
  persona.setAttribute('aria-label', t('channels:bot.persona.label'));
  persona.placeholder = t('channels:bot.persona.placeholder');
  const personaBlk = el('div', 'bp-blk');
  personaBlk.append(el('h4', null, t('channels:bot.persona.title')), persona);

  // 動かし方: モデルと承認モードのチップ（入力欄と同じ面）
  const modelName = el('span', 'v');
  const modelChip = el('button', 'chip fieldish model');
  modelChip.type = 'button';
  modelChip.id = 'botModelChip';
  modelChip.append(glyph(MODEL), modelName, caret());
  const modelPop = el('div', 'pop cpop');
  modelPop.id = 'botModelPop';
  modelPop.setAttribute('role', 'dialog');
  modelPop.setAttribute('aria-label', t('chat.composer.model'));
  modelPop.hidden = true;
  const modeName = el('span', 'v');
  const shield = glyph(SHIELD);
  const warn = glyph(WARN);
  const modeChip = el('button', 'chip fieldish mode');
  modeChip.type = 'button';
  modeChip.id = 'botModeChip';
  modeChip.append(shield, modeName, caret());
  const modePop = el('div', 'pop cpop');
  modePop.id = 'botModePop';
  modePop.setAttribute('role', 'dialog');
  modePop.setAttribute('aria-label', t('chat.composer.mode'));
  modePop.hidden = true;
  const chips = el('div', 'bp-kvr bp-chips');
  chips.append(modelChip, modeChip);
  const lockNote = el('span', 'bp-locknote');
  lockNote.append(glyph(LOCK), t('channels:bot.modeHumanOnly'));
  const modeFact = el('p', 'bp-nt bp-fact');
  modeFact.hidden = true;

  // フォルダー
  const folderTitle = el('h4', 'bp-h-folders', t('channels:bot.folders.title'));
  const folderBox = el('div', 'bp-folders');
  const addBtn = el('button', 'btn bp-addfolder');
  addBtn.type = 'button';
  addBtn.id = 'botAddFolder';
  addBtn.append(glyph(FOLDER_ADD), t('channels:bot.folders.add'));
  const addPop = el('div', 'pop cpop');
  addPop.id = 'botFolderPop';
  addPop.setAttribute('role', 'dialog');
  addPop.setAttribute('aria-label', t('channels:bot.folders.add'));
  addPop.hidden = true;
  const folderNote = el('p', 'bp-locknote bp-folder-note');
  folderNote.hidden = true;

  // 他の会話に送る
  const sw = el('button', 'bp-sw');
  sw.type = 'button';
  sw.id = 'botSendSwitch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('channels:bot.send.label'));
  const sendRow = el('div', 'bp-kvr bp-send');
  sendRow.append(el('span', 'k', t('channels:bot.send.label')), sw, el('p', 'bp-nt', t('channels:bot.send.hint')));

  const runBlk = el('div', 'bp-blk');
  const runHead = el('h4', null, t('channels:bot.run.title'));
  let removingTarget = false;
  const sendTargets = el('div', 'bp-send-targets');
  sendTargets.setAttribute('aria-label', t('channels:bot.send.targets'));
  runBlk.append(runHead, chips, lockNote, modeFact, folderTitle, folderBox, folderNote, addBtn, sendRow, sendTargets);

  // 記憶・使用量
  const memory = createMemoryList(host, {
    lookup: () => ({ channels: S.channels, bots: S.bots, sessions: S.sessions() }),
    openSource: (target) => {
      if (target.sessionId) host.openSession?.(target.sessionId);
      else navigate({ kind: 'channel', id: target.channelId, ...(target.threadId ? { threadId: target.threadId } : {}), ...(target.postId ? { postId: target.postId } : {}) });
    },
  });
  const memHead = el('h4', null, t('channels:bot.memory.title'));
  memHead.append(el('span', 'r', t('channels:bot.memory.auto')));
  const memBlk = el('div', 'bp-blk bp-memory');
  memBlk.append(memHead, memory.el);
  const usage = el('div', 'bp-usage');

  const left = el('div', 'bp-col');
  left.append(personaBlk, runBlk);
  const right = el('div', 'bp-col');
  right.append(memBlk, usage);
  const grid = el('div', 'bp-grid');
  grid.append(left, right);
  root.append(head, err, notice, grid, modelPop, modePop, addPop);
  body.append(root);

  // ---------------------------------------------------------------- 浮く面（入力欄と同じ。チップは画面の途中にあるので、広い方（なるべく下）に置き直す）
  const place = (p) => {
    const base = p.place.bind(p);
    p.place = () => {
      if (p.pop.hidden) return;
      base();
      const r = p.chip.getBoundingClientRect();
      const above = r.top - 12;
      const below = window.innerHeight - r.bottom - 14;
      if (below >= 400 || below > above) {
        p.pop.style.bottom = 'auto';
        p.pop.style.top = `${Math.round(r.bottom + 6)}px`;
        p.pop.style.maxHeight = `${Math.max(160, Math.round(below))}px`;
      } else p.pop.style.top = 'auto';
    };
    return p;
  };
  const modelPanel = place(panel(modelChip, modelPop, { width: 360, render: () => renderModel({ pop: modelPop, target: modelTarget(), on: modelOn, hide: (f) => modelPanel.hide(f) }) }));
  const modePanel = place(panel(modeChip, modePop, { width: 360, align: 'right', render: paintModePop }));
  const addPanel = place(panel(addBtn, addPop, { width: 360, render: renderAddPop, when: () => !unlimited(), onHide: () => { addPop.replaceChildren(); } }));
  const closePanels = () => { modelPanel.hide(false); modePanel.hide(false); addPanel.hide(false); closeEmojiPicker(); };

  // ---------------------------------------------------------------- 語彙（バックエンドごとの承認モード・モデル・エフォート）
  async function vocabOf(backend, model = '') {
    let v = S.vocab.get(backend);
    if (!v) {
      const [modes, models] = await Promise.all([
        host.cmd('modes', { backend }).catch(() => ({})),
        host.cmd('models', { backend }).catch(() => ({})),
      ]);
      v = { modes: modes ?? {}, models: models ?? {}, efforts: new Map() };
      if (Object.keys(v.modes).length && Object.keys(v.models).length) S.vocab.set(backend, v);
    }
    if (!v.efforts.has(model)) {
      const efforts = await host.cmd('efforts', { backend, model }).catch(() => ({ '': { label: t('chat.next.useDefault') } }));
      v.efforts.set(model, efforts ?? {});
    }
    return { modes: v.modes, models: v.models, efforts: v.efforts.get(model) };
  }
  /** 今の bot（か下書き）の語彙を読み、読み終えたら描き直す。読んでいる間に替わっていたら捨てる */
  async function loadVocab() {
    const cur = vm();
    if (!cur) return;
    const seq = ++S.seq;
    const v = await vocabOf(cur.backend, cur.model ?? '');
    if (seq !== S.seq) return;
    S.v = v;
    paintRun();
  }
  const backends = () => host.state?.backends ?? [];
  const backendLabel = (id) => backends().find((b) => b.id === id)?.label ?? id;

  // ---------------------------------------------------------------- 描画
  function paintHead() {
    const cur = vm();
    if (!cur) return;
    av.textContent = cur.icon || '🤖';
    if (document.activeElement !== nameIn) nameIn.value = cur.name ?? '';
    // 「Claude · Opus 5.5 · 作業中」
    const parts = [];
    if (cur.backend) {
      parts.push(backendLogo(cur.backend, backendLabel(cur.backend)));
      const model = S.v ? resolvedModel(S.v.models, cur.model ?? '').label : '';
      parts.push(document.createTextNode(`${backendLabel(cur.backend)}${model ? ` · ${model}` : ''}`));
    }
    if (!S.draft && S.bot) {
      parts.push(el('span', 'dot', '·'));
      if (S.bot.state === 'working') parts.push(runMark(t('channels:bot.state.working')), document.createTextNode(t('channels:bot.state.working')));
      else if (S.bot.state === 'waiting') parts.push(el('span', 'wait', t('channels:bot.state.waiting')));
      // 使用量の上限で休んでいる（ADR 0119）。解除の時刻は見出しの title に
      else if (Number(S.bot.restingUntil) > Date.now()) {
        const rest = el('span', null, t('channels:bot.state.resting'));
        rest.title = t('channels:bot.state.restingUntil', { time: new Date(S.bot.restingUntil).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
        parts.push(rest);
      }
      else parts.push(document.createTextNode(t('channels:bot.state.idle')));
    }
    sub.replaceChildren(...parts);
    dmBtn.disabled = !S.bot?.dmChannelId;
  }

  function paintChips() {
    const cur = vm();
    if (!cur) return;
    const v = S.v;
    const label = v ? modelChipLabel(v.models, cur.model ?? '', v.efforts, cur.effort ?? '') : cur.model || '…';
    const { head: h, tail } = splitChipLabel(label);
    modelName.classList.add('split');
    modelName.replaceChildren(el('span', 'mn', h), ...(tail ? [el('span', 'ef', tail)] : []));
    modelChip.title = t('composer.model.chipTitle', { label });
    modelChip.setAttribute('aria-label', t('composer.model.chipAria', { label }));
    modelChip.dataset.value = cur.model ?? '';
    modelChip.dataset.backend = cur.backend ?? '';
    const m = v?.modes?.[cur.mode];
    const danger = isDanger(m);
    modeName.replaceChildren(el('span', 'full', m?.label ?? cur.mode ?? ''));
    const icon = danger ? warn : shield;
    if (modeChip.firstChild !== icon) modeChip.firstChild.replaceWith(icon);
    modeChip.classList.toggle('danger', danger);
    modeChip.title = danger ? t('composer.mode.dangerTitle') : t('chat.composer.mode');
    modeChip.setAttribute('aria-label', danger ? t('composer.mode.chipAriaDanger', { mode: m?.label ?? cur.mode ?? '' }) : t('composer.mode.chipAria', { mode: m?.label ?? cur.mode ?? '' }));
    modeChip.dataset.value = cur.mode ?? '';
    // 承認モードが 1 つしか選べないバックエンド（Antigravity）は、事実を 1 行添える
    const only = v ? M.onlyMode(v.modes) : null;
    show(modeFact, Boolean(only));
    if (only) modeFact.textContent = t('channels:bot.modeOnly', { backend: backendLabel(cur.backend), mode: v.modes[only]?.label ?? only });
    // 開いている面も描き直す（語彙が届いた・選んだ直後）
    for (const p of [modelPanel, modePanel]) if (p.open) { p.render(); p.place(); }
  }

  function folderRow(f, disabled) {
    const row = el('div', 'bp-fold');
    row.dataset.path = f.path;
    const p = el('span', 'p', f.path);
    p.title = f.path;
    const acc = el('button', 'bp-fold-acc', f.access === 'rw' ? t('channels:bot.folders.rw') : t('channels:bot.folders.ro'));
    acc.type = 'button';
    acc.title = t('channels:bot.folders.toggle');
    acc.setAttribute('aria-label', t('channels:bot.folders.toggleAria', { path: f.path, access: acc.textContent }));
    acc.disabled = disabled;
    acc.onclick = () => update({ folders: M.toggleAccess(S.bot.folders, f.path) });
    const rm = el('button', 'bp-fold-rm');
    rm.type = 'button';
    rm.append(glyph(CLOSE));
    rm.title = t('channels:bot.folders.remove');
    rm.setAttribute('aria-label', t('channels:bot.folders.removeAria', { path: f.path }));
    rm.disabled = disabled;
    rm.onclick = () => update({ folders: M.removeFolder(S.bot.folders, f.path) });
    row.append(glyph(FOLDER), p, acc, rm);
    return row;
  }

  function paintFolders() {
    const cur = vm();
    if (!cur || S.draft) return;
    const lim = unlimited();
    const rows = (cur.folders ?? []).map((f) => folderRow(f, lim));
    folderBox.classList.toggle('all', lim);
    if (lim) {
      const all = el('div', 'bp-fold allf');
      all.append(glyph(FOLDER), el('span', 'p all-name', t('channels:bot.folders.all')));
      const off = el('div', 'folders-off');
      off.setAttribute('aria-disabled', 'true');
      off.append(...rows);
      folderBox.replaceChildren(all, ...(rows.length ? [off] : []));
      folderNote.textContent = t('channels:bot.folders.unlimited', { mode: S.v?.modes?.[cur.mode]?.label ?? cur.mode });
    } else {
      folderBox.replaceChildren(...(rows.length ? rows : [el('p', 'bp-empty', t('channels:bot.folders.none'))]));
    }
    show(folderNote, lim);
    addBtn.disabled = lim;
    if (lim) addPanel.hide(false);
  }

  function paintSend() {
    const cur = vm();
    if (!cur || S.draft) return;
    sw.setAttribute('aria-checked', String(cur.sendToOthers !== false));
    sendTargets.replaceChildren(el('h3', 'bp-send-title', t('channels:bot.send.targets')));
    const details = new Map((cur.sendTargetDetails ?? []).map((row) => [row.sessionId, row]));
    if (!cur.sendTargets?.length) sendTargets.append(el('p', 'bp-nt', t('channels:bot.send.empty')));
    for (const id of cur.sendTargets ?? []) {
      const detail = details.get(id);
      const title = detail?.title || id;
      const row = el('div', 'bp-send-target');
      const open = el('button', 'btn bp-send-open', title);
      open.type = 'button'; open.title = id;
      open.onclick = () => host.openSession(id);
      const source = detail?.source === 'shown' ? t('channels:bot.send.shown')
        : detail?.source === 'created' ? t('channels:bot.send.created') : t('channels:bot.send.manual');
      const info = el('div', 'bp-send-info');
      info.append(open, el('span', 'bp-nt', source));
      const remove = el('button', 'btn btn-quiet', t('channels:bot.send.remove'));
      remove.type = 'button';
      remove.setAttribute('aria-label', t('channels:bot.send.removeLabel', { title }));
      remove.disabled = removingTarget;
      remove.onclick = async () => {
        if (removingTarget) return;
        removingTarget = true;
        for (const button of sendTargets.querySelectorAll('.btn-quiet')) button.disabled = true;
        try { await update({ sendTargets: S.bot.sendTargets.filter((target) => target !== id) }); }
        finally { removingTarget = false; paintSend(); }
      };
      row.append(info, remove); sendTargets.append(row);
    }
  }

  function paintUsage() {
    const view = M.usageView(S.bot?.usage);
    usage.replaceChildren();
    if (S.draft || !S.bot) return;
    usage.append(document.createTextNode(`${t('channels:bot.usage.week')} `), el('b', 'bp-mono', view.tokens), document.createTextNode(` ${t('channels:bot.usage.tokens')}`));
    if (view.cache != null) {
      usage.append(document.createTextNode(` · ${t('channels:bot.usage.cache')} `), el('b', `bp-mono${view.warn ? ' warn' : ''}`, `${view.cache}%`));
      if (view.warn) { usage.append(el('span', 'bp-usage-warn', t('channels:bot.usage.low'))); }
    }
  }

  function paintRun() {
    paintChips();
    paintHead();
    paintFolders();
    paintSend();
  }

  function paintAll() {
    const creating = Boolean(S.draft);
    root.classList.toggle('is-new', creating);
    root.classList.toggle('is-gone', S.gone);
    show(dmBtn, !creating);
    show(createBtn, creating);
    show(folderTitle, !creating);
    show(folderBox, !creating);
    show(addBtn, !creating);
    show(sendRow, !creating);
    show(sendTargets, !creating);
    show(memBlk, !creating);
    show(usage, !creating);
    show(notice, S.gone);
    show(grid, !S.gone);
    show(head, !S.gone);
    const cur = vm();
    if (cur && document.activeElement !== persona) persona.value = cur.persona ?? '';
    growPersona();
    paintRun();
    paintUsage();
    if (!creating && S.bot) memory.setBot(S.bot);
    else memory.setBot(null);
  }

  const growPersona = () => {
    persona.style.height = 'auto';
    persona.style.height = `${Math.min(persona.scrollHeight + 2, 480)}px`;
  };

  const setError = (text) => { err.textContent = text; show(err, Boolean(text)); };

  // ---------------------------------------------------------------- 保存
  /** bots.get の行を取り込む（自分の画面の bot なら描き直す） */
  function applyBot(bot) {
    S.bots.set(bot.id, bot);
    if (S.id !== bot.id) return;
    S.bot = { ...S.bot, ...bot };
    paintAll();
    loadVocab();
  }

  /** 保存を 1 本ずつ流す。失敗は理由を出して、入力欄を保存済みの値に戻す */
  function queue(task) {
    const run = S.chain.catch(() => {}).then(task);
    S.chain = run;
    return run;
  }

  async function update(patch) {
    if (S.draft) { await draftUpdate(patch); return; }
    const botId = S.id;
    setError('');
    await queue(async () => {
      try {
        const bot = await host.invoke('bots.update', { botId, ...patch });
        if (S.id === botId) applyBot(bot);
      } catch (e) {
        if (S.id === botId) { setError(t('channels:bot.saveFailed', { error: message(e) })); paintAll(); }
      }
    });
  }

  async function setMode(mode) {
    if (S.draft) { S.draft.mode = mode; paintChips(); return; }
    const botId = S.id;
    setError('');
    await queue(async () => {
      try {
        const bot = await host.invoke('bots.setMode', { botId, mode });
        if (S.id === botId) applyBot(bot);
      } catch (e) {
        if (S.id === botId) { setError(t('channels:bot.saveFailed', { error: message(e) })); paintAll(); }
      }
    });
  }

  /** 作る画面の下書きを変える（保存はしない）。エージェントを替えたら、モデル・エフォートは既定へ、承認モードは同じ id があれば保つ */
  async function draftUpdate(patch) {
    const d = S.draft;
    Object.assign(d, patch);
    if ('backend' in patch) {
      d.model = ''; d.effort = '';
      const v = await vocabOf(d.backend, '');
      if (S.draft !== d) return;
      d.mode = M.modeAfterBackend(v.modes, d.mode);
      S.v = v;
    } else if ('model' in patch) {
      d.effort = '';
      const v = await vocabOf(d.backend, d.model);
      if (S.draft !== d) return;
      S.v = v;
    } else if ('effort' in patch) {
      /* そのまま */
    }
    paintRun();
  }

  async function create() {
    const d = S.draft;
    if (!d) return;
    const name = nameIn.value.trim();
    d.name = name;
    d.persona = persona.value;
    if (!name) { setError(t('channels:bot.nameRequired')); nameIn.focus(); return; }
    setError('');
    createBtn.disabled = true;
    try {
      const args = { name, icon: d.icon, backend: d.backend, ...(d.persona.trim() ? { persona: d.persona } : {}), ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) };
      let bot = await host.invoke('bots.create', args);
      if (d.mode && d.mode !== bot.mode) bot = await host.invoke('bots.setMode', { botId: bot.id, mode: d.mode });
      S.bots.set(bot.id, bot);
      navigate({ kind: 'bot', id: bot.id });
    } catch (e) {
      setError(t('channels:bot.createFailed', { error: message(e) }));
    } finally {
      createBtn.disabled = false;
    }
  }

  const modelOn = {
    backend: (id) => update({ backend: id }),
    model: (id) => update({ model: id }),
    effort: (v) => update({ effort: v }),
  };
  function modelTarget() {
    const cur = vm();
    const v = S.v ?? { modes: {}, models: {}, efforts: {} };
    return {
      backends: backends(), backend: cur.backend, backendSwitchable: backends().length > 1,
      models: v.models, model: cur.model ?? '',
      efforts: v.efforts, effort: cur.effort ?? '', effortDisabled: Object.keys(v.efforts ?? {}).length <= 1,
    };
  }
  function paintModePop() {
    const cur = vm();
    renderMode({ pop: modePop, target: { mode: cur.mode, modes: S.v?.modes ?? {} }, on: { mode: (id) => setMode(id) }, hide: () => modePanel.hide() });
  }

  // ---------------------------------------------------------------- フォルダーを足す
  async function addPath(path) {
    await update({ folders: M.addFolder(S.bot.folders ?? [], path) });
  }
  function renderAddPop() {
    const input = el('input', 'cpath');
    input.placeholder = t('channels:bot.folders.placeholder');
    input.setAttribute('aria-label', t('channels:bot.folders.inputLabel'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    const wrap = el('div', 'cpath-wrap');
    wrap.append(input);
    const msg = el('p', 'cerr');
    msg.setAttribute('role', 'alert');
    const box = el('div', 'cbrowse');
    box.hidden = true;
    const done = async (path) => { addPanel.hide(); await addPath(path); };
    const check = async (value) => {
      const v = value.trim();
      if (!v) return;
      msg.textContent = '';
      try { const r = await host.cmd('listDirs', { path: v }); await done(r.path || v); }
      catch (e) { msg.textContent = e.code === 'ENOENT' ? t('composer.cwd.notFound') : message(e); input.setAttribute('aria-invalid', 'true'); }
    };
    input.addEventListener('keydown', (e) => { if (isComposingKey(e) || e.key !== 'Enter') return; e.preventDefault(); check(input.value); });
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); msg.textContent = ''; });
    const browse = folderBrowser({ cmd: (c, a) => host.cmd(c, a), box, err: msg, onChoose: (p) => done(p), closed: () => addPop.hidden });
    const pick = el('button', 'caction');
    pick.type = 'button';
    pick.append(glyph(FOLDER_ADD), el('span', null, t('composer.cwd.choose')));
    pick.onclick = async () => {
      msg.textContent = '';
      if (window.plyDesktop?.chooseFolder) {
        const picked = await window.plyDesktop.chooseFolder().catch(() => null);
        const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
        if (chosen) await done(chosen);
        return;
      }
      browse('');
    };
    addPop.replaceChildren(wrap, pick, box, msg);
  }

  // ---------------------------------------------------------------- 入力
  av.addEventListener('click', (e) => {
    e.stopPropagation();   // 脇の document の click が、開いたばかりのピッカーを閉じないように（web/side.mjs の closePops）
    openEmojiPicker({
      anchor: av, current: vm()?.icon, title: t('channels:bot.iconLabel'),
      onPick: (emoji) => update({ icon: emoji }),
    });
  });

  const commitName = async () => {
    const cur = vm();
    const name = nameIn.value.trim();
    if (S.draft) { S.draft.name = name; return; }
    if (!cur || name === cur.name) { nameIn.value = cur?.name ?? ''; return; }
    if (!name) { nameIn.value = cur.name; return; }
    await update({ name });
    if (document.activeElement !== nameIn) nameIn.value = S.bot?.name ?? '';
  };
  nameIn.addEventListener('blur', commitName);
  nameIn.addEventListener('keydown', (e) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); if (S.draft) create(); else nameIn.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameIn.value = vm()?.name ?? ''; nameIn.blur(); }
  });
  persona.addEventListener('input', growPersona);
  persona.addEventListener('blur', () => {
    const cur = vm();
    if (S.draft) { S.draft.persona = persona.value; return; }
    if (cur && persona.value !== (cur.persona ?? '')) update({ persona: persona.value });
  });
  sw.addEventListener('click', () => {
    if (S.draft || !S.bot) return;
    const next = S.bot.sendToOthers === false;
    sw.setAttribute('aria-checked', String(next));
    update({ sendToOthers: next });
  });
  dmBtn.addEventListener('click', () => { if (S.bot?.dmChannelId) navigate({ kind: 'channel', id: S.bot.dmChannelId }); });
  createBtn.addEventListener('click', create);

  // ---------------------------------------------------------------- 読み込み
  async function loadChannels() {
    try {
      const r = await host.invoke('channels.list', {});
      S.channels = new Map((r?.channels ?? []).map((c) => [c.id, c]));
      memory.repaint();
    } catch { /* 出どころの字が簡略になるだけ */ }
  }
  async function loadBots() {
    try {
      const r = await host.invoke('bots.list', {});
      for (const b of r?.bots ?? []) S.bots.set(b.id, b);
      if (S.id && S.id !== 'new' && S.bots.has(S.id)) S.bot = { ...S.bot, ...S.bots.get(S.id) };
    } catch { /* 同上 */ }
  }

  async function open(id) {
    closePanels();
    S.id = id;
    S.gone = false;
    S.v = null;
    S.seq += 1;
    setError('');
    if (id === 'new') {
      S.bot = null;
      const first = backends().find((b) => b.id === host.state?.backendId)?.id ?? backends()[0]?.id ?? '';
      const v = await vocabOf(first, '');
      if (S.id !== 'new') return;
      S.draft = M.newDraft(first, v.modes);
      S.v = v;
      nameIn.value = '';
      persona.value = '';
      paintAll();
      nameIn.focus();
      return;
    }
    S.draft = null;
    const have = S.bots.get(id) ?? null;
    S.bot = have;
    if (have) { paintAll(); loadVocab(); }
    try {
      const bot = await host.invoke('bots.get', { botId: id });
      if (S.id !== id) return;
      S.bot = bot;
      S.bots.set(id, bot);
      nameIn.value = bot.name;
      persona.value = bot.persona ?? '';
      paintAll();
      await loadVocab();
    } catch (e) {
      if (S.id !== id) return;
      S.gone = true;
      notice.textContent = e?.code === 'BOT_NOT_FOUND' ? t('channels:bot.notFound') : t('channels:bot.loadFailed', { error: message(e) });
      paintAll();
    }
    loadBots();
    loadChannels();
  }

  let refetch = null;
  const refetchSoon = () => {
    clearTimeout(refetch);
    refetch = setTimeout(async () => {
      const id = S.id;
      if (!id || id === 'new' || root.hidden) return;
      try { const bot = await host.invoke('bots.get', { botId: id }); if (S.id === id) applyBot(bot); }
      catch (e) { if (S.id === id && e?.code === 'BOT_NOT_FOUND') { S.gone = true; notice.textContent = t('channels:bot.removed'); paintAll(); } }
    }, 200);
  };

  return {
    show(view) {
      if (view?.kind !== 'bot' || !view.id) { this.hide(); return; }
      root.hidden = false;
      topEl()?.classList.add('bot-top');
      open(view.id);
    },
    hide() {
      topEl()?.classList.remove('bot-top');
      if (root.hidden) return;
      closePanels();
      root.hidden = true;
      S.id = null;
      S.draft = null;
      memory.setBot(null);
    },
    onEvent(ev) {
      switch (ev?.type) {
        case 'botsChanged':
          if (ev.removed) { S.bots.delete(ev.removed); if (S.id === ev.removed) { S.gone = true; notice.textContent = t('channels:bot.removed'); paintAll(); } return; }
          if (ev.bot) { S.bots.set(ev.bot.id, { ...S.bots.get(ev.bot.id), ...ev.bot }); if (S.id === ev.bot.id) refetchSoon(); }
          return;
        case 'memoryChanged':
          if (!root.hidden) memory.refresh(ev.layer);
          return;
        case 'channelsChanged':
          if (!root.hidden) loadChannels();
          return;
        default:
      }
    },
  };
}
