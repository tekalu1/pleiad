// 記憶の一覧（bot のページの右。ADR 0110・docs/channels.md「記憶」）。2 層: あなたについて（全 bot 共通）と、この bot だけ。
// 各行に本文と出どころ（押すとその投稿・会話へ）と［直す］［忘れる］。凝った編集画面は作らず、その場で書き換える。
// 忘れたら 12 秒の「元に戻す」の帯（memory.forget は墓石を残すので、戻すのは memory.unforget）。
// 操作はすべて memory.* の op を host.invoke で呼ぶ。更新は memoryChanged（呼び出し側が refresh する）。
// 頭に夜の整理の様子の 1 行（memory.learnStatus。最後に走った時刻・覚えた件数・飛ばした回数と理由・失敗・次の予定。ADR 0118）。
// 各行に種類の札（約束・やめたこと…）と、薄れた記憶（会話の始まりには渡さないが、探せば出る）の印。
// i18n-dynamic: channels:memory.learn.
// i18n-dynamic: channels:memory.kind.
//
//   createMemoryList(host, { lookup, openSource }) → { el, setBot(bot), refresh(layer?), layers() }
//     lookup() … { channels: Map<id, Channel>, bots: Map<id, Bot>, sessions: Map<id, session> }（出どころの字に使う）
//     openSource(target) … 出どころを開く（{ channelId, threadId?, postId? } か { sessionId }）
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { sourceView, learnStatusView } from './bot-model.mjs';
import { botIcon } from './bot-icon.mjs';

export const UNDO_MS = 12000;
const FADE_MS = 240;
const TEXT_MAX = 300;

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));

export function createMemoryList(host, { lookup, openSource }) {
  const root = el('div', 'mem-wrap');
  const S = {
    bot: null,
    // 層ごとの写し。entries: null = まだ読んでいない
    user: { entries: null, error: '' },
    own: { entries: null, error: '' },
    editing: null,   // 直している行の id
    draft: '',       // 直している途中の字（別の端末の変更で描き直しても消さない）
    focusEdit: false,
    seq: {},         // 層ごとの読み込みの番号
  };
  const groups = {};
  const undo = el('div', 'mem-undo');
  undo.hidden = true;
  undo.setAttribute('role', 'status');
  let undoTimer = null;
  const note = el('p', 'mem-err');
  note.setAttribute('role', 'alert');
  note.hidden = true;
  const learnLine = el('p', 'mem-learn');
  learnLine.hidden = true;
  let learnSeq = 0;

  for (const key of ['user', 'own']) {
    const head = el('div', 'memh');
    const title = el('b');
    const meta = el('span');
    head.append(title, meta);
    const core = el('div', 'memcore');
    core.dataset.layer = key;
    core.setAttribute('aria-label', '');
    groups[key] = { head, title, meta, core };
  }
  root.append(learnLine, groups.user.head, groups.user.core, groups.own.head, groups.own.core, note, undo);
  groups.own.head.classList.add('second');

  const layerId = (key) => (key === 'user' ? 'user' : S.bot?.id);
  const keyOf = (layer) => (layer === 'user' ? 'user' : layer === S.bot?.id ? 'own' : null);

  const showError = (text) => { note.textContent = text; note.hidden = !text; };

  // ---------------------------------------------------------------- 描画
  function sourceNode(entry) {
    const box = el('span', 'src');
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    const first = sources.find((s) => s?.kind === 'post' || s?.kind === 'message');
    if (!first) {
      box.classList.add('untrusted');
      box.textContent = entry.by?.kind === 'human' ? t('channels:memory.source.written') : t('channels:memory.source.none');
    } else {
      const v = sourceView(first, lookup());
      const where = v.where.type === 'dm' ? t('channels:memory.source.dm', { name: [v.where.iconImage ? '' : v.where.icon, v.where.name].filter(Boolean).join(' ') })
        : v.where.type === 'chat' ? (v.where.name ? t('channels:memory.source.chat', { title: v.where.name }) : t('channels:memory.source.chatGone'))
        : v.where.name ? `#${v.where.name}` : t('channels:memory.source.channelGone');
      const when = v.date ?? t('channels:memory.source.today');
      const text = t('channels:memory.source.line', { where, when });
      const image = v.where.iconImage ? botIcon(v.where, 'src-bot-icon') : null;
      if (v.target) {
        const link = el('button', 'src-link', text);
        if (image) link.prepend(image);
        link.type = 'button';
        link.title = t('channels:memory.source.open');
        link.onclick = () => openSource(v.target);
        box.append(link);
      } else {
        box.classList.add('untrusted');
        box.textContent = text;
        if (image) box.prepend(image);
      }
      if (sources.length > 1) box.append(el('span', 'src-more', t('channels:memory.source.more', { n: sources.length - 1 })));
    }
    if ((entry.updatedAt ?? 0) - (entry.at ?? 0) > 60000) {
      const v = sourceView({ kind: 'post', at: entry.updatedAt }, lookup());
      box.append(el('span', 'src-more', t('channels:memory.source.edited', { when: v.date ?? t('channels:memory.source.today') })));
    }
    return box;
  }

  function rowNode(key, entry) {
    const row = el('div', 'mem');
    row.dataset.id = entry.id;
    const tx = el('span', 'tx');
    const acts = el('span', 'acts2');
    const learnedToday = entry.by?.kind === 'bot' && entry.by.botId === 'b_learner' && entry.origBy?.kind !== 'human'
      && entry.updatedAt && new Date(entry.updatedAt).toDateString() === new Date().toDateString();
    if (S.editing === entry.id) {
      row.classList.add('editing');
      const input = el('input', 'fin memedit');
      input.type = 'text';
      input.value = S.draft || entry.text;
      input.addEventListener('input', () => { S.draft = input.value; });
      input.maxLength = TEXT_MAX;
      input.setAttribute('aria-label', t('channels:memory.editLabel'));
      input.autocomplete = 'off';
      const cancel = el('button', 'btn', t('channels:memory.cancel'));
      cancel.type = 'button';
      const save = el('button', 'btn link', t('channels:memory.save'));
      save.type = 'button';
      cancel.onclick = () => stopEditing();
      save.onclick = () => saveEdit(key, entry, input.value);
      input.addEventListener('keydown', (e) => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); saveEdit(key, entry, input.value); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing(); }
      });
      tx.append(input, sourceNode(entry));
      acts.append(cancel, save);
      if (S.focusEdit) {
        S.focusEdit = false;
        queueMicrotask(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
      }
    } else {
      const textLine = el('span', 'tx-text');
      if (entry.kind) {
        const kindKey = entry.kind === 'promise' && entry.status === 'done' ? 'promiseDone' : entry.kind;
        textLine.append(el('span', 'mem-kind', t(`channels:memory.kind.${kindKey}`)), ' ');
      }
      textLine.append(entry.text);
      if (entry.faded) {
        row.classList.add('faded');
        const faded = el('span', 'src-more mem-faded', t('channels:memory.faded'));
        faded.title = t('channels:memory.fadedTitle');
        textLine.append(faded);
      }
      tx.append(textLine);
      if (learnedToday) tx.append(el('span', 'src-more mem-new', t('channels:memory.new')));
      tx.append(sourceNode(entry));
      const fix = el('button', 'btn forget', t('channels:memory.edit'));
      fix.type = 'button';
      fix.dataset.act = 'edit';
      fix.setAttribute('aria-label', t('channels:memory.editAria', { text: entry.text }));
      fix.onclick = () => { S.editing = entry.id; S.draft = ''; S.focusEdit = true; showError(''); paint(); };
      const gone = el('button', 'btn forget', t('channels:memory.forget'));
      gone.type = 'button';
      gone.dataset.act = 'forget';
      gone.setAttribute('aria-label', t('channels:memory.forgetAria', { text: entry.text }));
      gone.onclick = () => forget(key, entry, row);
      acts.append(fix, gone);
    }
    row.append(tx, acts);
    return row;
  }

  function paintGroup(key) {
    const g = groups[key];
    const s = S[key];
    const name = S.bot?.name ?? '';
    g.title.textContent = key === 'user' ? t('channels:memory.user.title') : t('channels:memory.own.title', { name });
    const n = s.entries?.length ?? 0;
    g.meta.textContent = key === 'user' ? t('channels:memory.user.meta', { n }) : t('channels:memory.own.meta', { n });
    g.core.setAttribute('aria-label', g.title.textContent);
    if (s.entries == null) {
      g.core.replaceChildren(el('div', 'mem-empty', s.error || t('channels:memory.loading')));
      return;
    }
    if (!s.entries.length) { g.core.replaceChildren(el('div', 'mem-empty', t('channels:memory.empty'))); return; }
    const sorted = [...s.entries].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    g.core.replaceChildren(...sorted.map((e) => rowNode(key, e)));
  }

  function paint() { paintGroup('user'); paintGroup('own'); }

  // ---------------------------------------------------------------- 夜の整理の様子
  function paintLearn(status) {
    const view = learnStatusView(status);
    learnLine.hidden = !view;
    if (!view) return;
    const parts = view.parts.map(({ key, params = {} }) => t(`channels:memory.learn.${key}`, {
      ...params, ...(params.reasonKey ? { reason: t(`channels:memory.learn.reason.${params.reasonKey}`) } : {}),
    }));
    learnLine.textContent = `${t('channels:memory.learn.label')}: ${parts.join(' · ')}`;
    learnLine.classList.toggle('warn', view.warn);
  }

  async function loadLearn() {
    const seq = ++learnSeq;
    try {
      const status = await host.invoke('memory.learnStatus', {});
      if (seq === learnSeq) paintLearn(status);
    } catch {
      if (seq === learnSeq) paintLearn(null);   // 様子が読めなくても記憶の一覧は使える
    }
  }

  // ---------------------------------------------------------------- 読み込み
  async function load(key) {
    const layer = layerId(key);
    if (!layer) return;
    const seq = (S.seq[key] = (S.seq[key] ?? 0) + 1);
    const mine = S.bot?.id;
    // 続けて呼ばれたときは最後の 1 回だけを当てる。別の bot に替わっていたら捨てる
    const stale = () => S.bot?.id !== mine || S.seq[key] !== seq;
    try {
      const entries = await host.invoke('memory.list', { layer });
      if (stale()) return;
      S[key] = { entries: Array.isArray(entries) ? entries : [], error: '' };
    } catch (e) {
      if (stale()) return;
      S[key] = { entries: S[key].entries, error: t('channels:memory.loadFailed', { error: message(e) }) };
    }
    paintGroup(key);
  }

  // ---------------------------------------------------------------- 直す・忘れる
  function stopEditing() { S.editing = null; S.draft = ''; paint(); }

  async function saveEdit(key, entry, raw) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text === entry.text) { stopEditing(); return; }
    try {
      const done = await host.invoke('memory.edit', { id: entry.id, text });
      S.editing = null;
      S.draft = '';
      const s = S[key];
      if (s.entries) s.entries = s.entries.map((e) => (e.id === entry.id ? { ...e, ...done } : e));
      showError('');
      paint();
    } catch (e) {
      showError(t('channels:memory.editFailed', { error: message(e) }));
    }
  }

  function clearUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    undo.hidden = true;
    undo.replaceChildren();
  }

  async function forget(key, entry, row) {
    showError('');
    row.classList.add('gone');
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await host.invoke('memory.forget', { id: entry.id });
    } catch (e) {
      row.classList.remove('gone');
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showError(t('channels:memory.forgetFailed', { error: message(e) }));
      return;
    }
    await new Promise((r) => setTimeout(r, reduced() ? 0 : FADE_MS));
    const s = S[key];
    if (s.entries) s.entries = s.entries.filter((e) => e.id !== entry.id);
    paint();
    const clip = [...entry.text].length > 30 ? `${[...entry.text].slice(0, 29).join('')}…` : entry.text;
    const back = el('button', 'btn link', t('channels:memory.undo'));
    back.type = 'button';
    back.onclick = async () => {
      back.disabled = true;
      try {
        const restored = await host.invoke('memory.unforget', { id: entry.id });
        clearUndo();
        const t2 = S[key];
        if (t2.entries && !t2.entries.some((e) => e.id === restored.id)) t2.entries = [...t2.entries, restored];
        paint();
      } catch (e) {
        back.disabled = false;
        showError(t('channels:memory.undoFailed', { error: message(e) }));
      }
    };
    undo.replaceChildren(el('span', 'undo-text', t('channels:memory.forgotten', { text: clip })), back);
    undo.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(clearUndo, UNDO_MS);
  }

  return {
    el: root,
    /** 見せる bot を替える（null で空に）。層の写しは読み直す */
    setBot(bot) {
      if (S.bot?.id === bot?.id) {
        if (bot) { S.bot = bot; paint(); }
        return;
      }
      S.bot = bot ?? null;
      S.user = { entries: null, error: '' };
      S.own = { entries: null, error: '' };
      S.editing = null;
      S.draft = '';
      clearUndo();
      showError('');
      paint();
      if (bot) { load('user'); load('own'); loadLearn(); }
      else { learnSeq++; learnLine.hidden = true; }
    },
    /** 層を読み直す（memoryChanged）。layer を省けば両方。直している間は本文を上書きしないよう、描き直しは直し終えてから */
    refresh(layer) {
      if (!S.bot) return;
      const key = layer == null ? null : keyOf(layer);
      if (layer != null && !key) return;
      for (const k of key ? [key] : ['user', 'own']) load(k);
      loadLearn();
    },
    /** 出どころの字に使う外の写し（チャンネル・bot・会話）が変わった */
    repaint: paint,
    layers: () => ({ user: S.user.entries, own: S.own.entries }),
  };
}
