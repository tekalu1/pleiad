// 分けた作業場所の画面の部品（docs/design-system.md「分けた作業場所」、ADR 0089）。
//   - 入力欄の上の 1 行（同じリポジトリで別の会話が作業中: 分けて始める / このまま / いつも分ける）
//   - 会話の中の静かな 1 行（分けた作業場所で始めました・元の場所に戻す）— present kind: 'worktree'
//   - 右パネル「git」の「残っている作業場所」（取り込みを頼む・退避して消す・残す）
//   - 設定の「いつも分ける」
// 文の組み立ては DOM に触れない関数に分ける。DOM は web/dom.mjs の el だけ。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { branchIcon, archiveIcon, linkIcon, lockIcon, chevRightIcon, undoIcon } from './icons.mjs';

const MARK = '⁣';

/** パスの末尾 2 つ（D:/dev/pleiad.pleiad/ply-7f3a → pleiad.pleiad/ply-7f3a）。次のターンの行・チップの title に使う */
export function shortPath(p) {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** 作業中の別の会話の名前（「題」・「題」ほか N 件・ほかの会話）。conflicts は worktreeCheck の conflicts */
export function whoText(conflicts) {
  const titles = (conflicts ?? []).map((c) => c.title).filter(Boolean);
  const count = (conflicts ?? []).length;
  if (!titles.length) return t('worktree.whoAnother');
  return count > 1 ? t('worktree.whoMany', { title: titles[0], count: count - 1 }) : t('worktree.who', { title: titles[0] });
}

/** 辞書の文の {{x}} の所へ要素を差し込む（git-panel の fill と同じ手） */
// i18n-dynamic: worktree.note
function fill(key, params, nodes) {
  const text = t(key, { ...params, ...Object.fromEntries(Object.keys(nodes).map((k) => [k, `${MARK}${k}${MARK}`])) });
  const out = [];
  for (const piece of text.split(MARK)) if (piece) out.push(nodes[piece] ?? el('span', null, piece));
  return out;
}

function icon(svg) {
  const s = el('span', 'wt-ic');
  s.innerHTML = svg;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function button(className, label, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

// ---------------------------------------------------------------- 入力欄の上の 1 行

/**
 * 同じリポジトリで別の会話が書き込み中のとき、入力欄のすぐ上に出す 1 行。送信は止めない（選ばずに送れば「このまま」）。
 * @param {{ conflicts: object[], onSplit: () => void, onKeep: () => void, onAlways: () => void }} o
 */
export function renderSplitNote({ conflicts, onSplit, onKeep, onAlways }) {
  const box = el('div', 'wt-note');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('worktree.noteLabel'));
  const text = el('span', 'wt-note-t');
  text.append(icon(branchIcon), ...fill('worktree.note', {}, { who: el('b', null, whoText(conflicts)) }));
  const acts = el('span', 'wt-acts');
  acts.append(button('btn btn-quiet', t('worktree.split'), onSplit), button('btn', t('worktree.keep'), onKeep));
  const always = button('wt-always', t('worktree.always'), onAlways);
  always.title = t('worktree.alwaysTitle');
  box.append(text, acts, always);
  return box;
}

// ---------------------------------------------------------------- 会話の中の静かな 1 行

/** 会話の中の行の初めの状態を決める関数（client.mjs が入れる。会話の cwd と次のターンの予約から here / backing / back を返す） */
let modeOf = () => 'here';
export const setWorktreeLineMode = (fn) => { modeOf = fn; };

/**
 * 分けた作業場所で始めた印の行（present kind: 'worktree'。worktree: { id, branch, path, origin, conflicts, count }）。
 * 状態は paintWorktreeLine で切り替える（here: 元の場所に戻す / backing: 次のターンから戻す・もう一度分ける / back: 戻した・もう一度分ける）。
 * 押したら ply-worktree を投げる（detail: { act: 'back' | 'again', note }）。聞くのは web/client.mjs
 */
export function renderWorktreeLine(ev) {
  const note = ev?.worktree;
  if (!note) return el('div', 'wt-line');
  const row = el('div', 'wt-line');
  row.dataset.worktreeId = note.id ?? '';
  row.worktreeNote = note;
  const text = el('span', 'wt-line-t');
  const act = button('btn btn-quiet', '', () => row.dispatchEvent(new CustomEvent('ply-worktree', { bubbles: true, detail: { act: row.dataset.mode === 'here' ? 'back' : 'again', note } })));
  row.append(icon(branchIcon), text, act);
  paintWorktreeLine(row, modeOf(note));
  return row;
}

export function paintWorktreeLine(row, mode) {
  const note = row.worktreeNote ?? {};
  row.dataset.mode = mode;
  const count = note.count ?? note.conflicts?.length ?? 0;
  const who = whoText((note.conflicts ?? []).map((title) => ({ title })).concat(Array.from({ length: Math.max(0, count - (note.conflicts?.length ?? 0)) }, () => ({ title: '' }))));
  const hasWho = (note.conflicts ?? []).length > 0 || count > 0;
  row.querySelector('.wt-line-t').textContent = mode === 'backing' ? t('worktree.line.backing')
    : mode === 'back' ? t('worktree.line.backed')
    : hasWho ? t('worktree.line.started', { who }) : t('worktree.line.startedNoWho');
  row.querySelector('button').textContent = mode === 'here' ? t('worktree.back') : t('worktree.line.again');
}

// ---------------------------------------------------------------- 取り込みを頼む文

/** エージェントに送る取り込みの依頼文（画面の言語。取り込みの判断・競合の解決はエージェントがする） */
export function askText(row) {
  return row.baseBranch ? t('worktree.ask.text', { branch: row.branch, path: row.path, origin: row.origin, base: row.baseBranch })
    : t('worktree.ask.textOriginal', { branch: row.branch, path: row.path, origin: row.origin });
}

// ---------------------------------------------------------------- 右パネル「残っている作業場所」

/**
 * @param {object} o
 * @param {(id:string, kept:boolean) => Promise<any>} o.keep
 * @param {(row:object) => Promise<{ title: string, messageId: string, sessionId: string }|null>} o.ask 取り込みを頼む（その会話へ依頼文を送る）
 * @param {(ask:object) => Promise<boolean>} o.unask 送った依頼の取り消し
 * @param {(row:object) => Promise<object>} o.archive 退避して消す。{ action, ref?, why? }
 * @param {(row:object, ref:string) => Promise<boolean>} o.restore 退避から作業場所を作り直す
 * @param {() => void} o.changed 状態が変わったので、パネルを描き直してほしい
 */
export function createLeftovers({ keep, ask, unask, archive, restore, changed }) {
  /** 行ごとの今の状態。id -> { s: 'idle'|'ask'|'keep'|'stash'|'fail', msg, undo, ref?, ask?, row? } */
  const stateOf = new Map();
  const open = new Set();   // 開いているファイルの一覧（id）

  const set = (row, state) => { stateOf.set(row.id, { ...state, row }); changed(); };
  const clear = (id) => { stateOf.delete(id); changed(); };

  // i18n-dynamic: worktree.left.fail.
  const failText = (why) => t(`worktree.left.fail.${['busy', 'links', 'changed', 'archive', 'unowned', 'attached'].includes(why) ? why : 'other'}`);

  function rowView(row, { header = true } = {}) {
    const st = stateOf.get(row.id) ?? { s: row.kept ? 'keep' : 'idle', msg: row.kept ? t('worktree.left.kept') : '', undo: t('worktree.left.keptUndo') };
    const box = el('div', 'wt-item');
    box.dataset.state = st.s;
    if (header) {
      const line = el('button', 'wt-row');
      line.type = 'button';
      line.setAttribute('aria-expanded', String(open.has(row.id)));
      line.append(icon(branchIcon), el('code', null, row.branch));
      const meta = [row.files != null ? t('git.files', { count: row.files }) : null, row.at ? fmt.relative(row.at) : null].filter(Boolean).join(' · ');
      line.append(el('span', 'wt-row-m', meta ? `· ${meta}` : ''));
      const chev = el('span', 'wt-chev');
      chev.innerHTML = chevRightIcon;
      line.append(chev);
      line.onclick = () => { if (open.has(row.id)) open.delete(row.id); else open.add(row.id); changed(); };
      box.append(line);
      if (open.has(row.id) && row.fileNames?.length) {
        const ul = el('ul', 'wt-files');
        for (const name of row.fileNames) ul.append(el('li', null, name));
        box.append(ul);
      }
    }
    if (st.s === 'idle' || st.s === 'fail') {
      const acts = el('div', 'wt-item-acts');
      const askBtn = button('btn btn-primary', t('worktree.left.ask'), async () => {
        const sent = await ask(row).catch((e) => ({ error: e?.message ?? String(e) }));
        if (sent?.title != null) set(row, { s: 'ask', msg: t('worktree.left.asked', { title: sent.title || t('worktree.whoAnother') }), undo: t('worktree.left.askedUndo'), ask: sent });
        else set(row, { s: 'fail', msg: sent?.error ? t('worktree.left.askFailed', { error: sent.error }) : t('worktree.left.askNone') });
      });
      askBtn.disabled = !row.mergeSessionId;
      const stash = button('btn btn-quiet', null, async () => {
        stash.disabled = true;
        const res = await archive(row).catch(() => ({ action: 'failed', why: 'other' }));
        if (res?.action === 'removed') set(row, { s: 'stash', msg: t('worktree.left.archived'), undo: t('worktree.left.archivedUndo'), ref: res.ref });
        else set(row, { s: 'fail', msg: failText(res?.why) });
      });
      stash.append(icon(archiveIcon), el('span', null, t('worktree.left.archive')));
      const keepBtn = button('btn btn-quiet', t('worktree.left.keep'), async () => {
        await keep(row.id, true).catch(() => {});
        set(row, { s: 'keep', msg: t('worktree.left.kept'), undo: t('worktree.left.keptUndo') });
      });
      acts.append(askBtn, stash, keepBtn);
      box.append(acts);
      if (st.s === 'fail') box.append(el('div', 'wt-stat wt-fail', st.msg));
    } else {
      const stat = el('div', 'wt-stat');
      stat.append(el('span', null, st.msg));
      const undo = button('btn wt-undo', null, async () => {
        if (st.s === 'keep') { await keep(row.id, false).catch(() => {}); clear(row.id); }
        else if (st.s === 'ask') { const ok = await unask(st.ask).catch(() => false); if (ok) clear(row.id); else set(row, { s: 'ask', msg: t('worktree.left.askedLate'), ask: st.ask, undo: '' }); }
        else if (st.s === 'stash') { const ok = await restore(row, st.ref).catch(() => false); if (ok) clear(row.id); else set(row, { s: 'stash', msg: t('worktree.left.restoreFailed'), undo: '' }); }
      });
      undo.append(icon(undoIcon), el('span', null, st.undo ?? ''));
      undo.hidden = !st.undo;
      stat.append(undo);
      box.append(stat);
    }
    return box;
  }

  return {
    /** 行を開いた中の操作と結果だけ（git パネルの作業場所タブ。見出しの行は呼び出し側が持つ） */
    actions(row) { return rowView(row, { header: false }); },
    /** パネルのブロック。rows が空でも、退避した直後の「元に戻す」の行が残っていれば出す */
    section(rows) {
      const shown = [...rows];
      for (const [id, st] of stateOf) if (st.s === 'stash' && !shown.some((r) => r.id === id)) shown.push(st.row);
      if (!shown.length) return null;
      const sec = el('section', 'git-sec wt-left');
      const head = el('div', 'git-sh');
      head.append(el('h3', null, t('worktree.left.title')), el('span', 'git-tot', String(rows.length)));
      sec.append(head);
      for (const row of shown) sec.append(rowView(row));
      const safety = el('ul', 'wt-safety');
      for (const [svg, text] of [[linkIcon, t('worktree.left.safetyLinks')], [lockIcon, t('worktree.left.safetyUse')]]) {
        const li = el('li');
        li.append(icon(svg), el('span', null, text));
        safety.append(li);
      }
      sec.append(safety);
      return sec;
    },
    reset() { stateOf.clear(); open.clear(); },
  };
}

// ---------------------------------------------------------------- 設定の「いつも分ける」

/**
 * 設定 › 委譲の末尾の節。同じリポジトリで別の会話が作業中のとき、確かめずに分けて始める。
 * @param {{ cmd: (c:string, a?:object) => Promise<any> }} o
 */
export function setupWorktreeSettings({ cmd }) {
  const sec = el('section', 'mp-panel wt-settings');
  sec.id = 'worktreeSettings';
  const sw = el('button', 'cx-sw');
  sw.type = 'button';
  sw.id = 'worktreeAlways';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('worktree.settings.always'));
  const label = el('label', 'rm-switch-label', t('worktree.settings.always'));
  label.htmlFor = 'worktreeAlways';
  const row = el('div', 'rm-switch');
  row.append(label, sw);
  const desc = el('p', 'mp-note', t('worktree.settings.description'));
  sec.append(el('h3', null, t('worktree.settings.title')), row, desc);
  const paint = (always) => { sw.setAttribute('aria-checked', String(Boolean(always))); };
  paint(false);
  const load = () => cmd('worktreeSettings').then((s) => paint(s?.always)).catch(() => {});
  sw.onclick = () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    paint(next);
    cmd('setWorktreeSettings', { always: next }).then((s) => paint(s?.always)).catch(() => paint(!next));
  };
  load();
  return { element: sec, paint, load };
}
