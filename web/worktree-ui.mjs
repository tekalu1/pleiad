// worktree の画面の部品（docs/design-system.md「worktree」、ADR 0136）。
//   - 書き込み中の別の会話を知らせるチップ（web/composer-controls.mjs が描く）
//   - 会話の中の静かな 1 行（worktree で始めました・元の場所に戻す）— present kind: 'worktree'
//   - 右パネル「git」の作業場所タブの、未取り込みの行を開いた中の操作（取り込みを頼む・退避して消す・残す。ADR 0135）
// 文の組み立ては DOM に触れない関数に分ける。DOM は web/dom.mjs の el だけ。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { branchIcon, archiveIcon, undoIcon } from './icons.mjs';

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

// ---------------------------------------------------------------- 別の会話の書き込み

/**
 * 同じリポジトリに別の会話が書き込んでいるときだけ { who } を返す。
 * この会話が走っている間の送信は今のターンへ渡るため、知らせは出さない。
 * @param {{ canSplit?: boolean, conflicts?: object[] }|null} data worktreeCheck の結果
 * @param {{ running?: boolean }} [o]
 */
export function busyPlan(data, { running = false } = {}) {
  if (!data || !data.canSplit || !data.conflicts?.length || running) return null;
  return { who: whoText(data.conflicts) };
}

// ---------------------------------------------------------------- 会話の中の静かな 1 行

/** 会話の中の行の初めの状態を決める関数（client.mjs が入れる。会話の cwd と次のターンの予約から here / backing / back を返す） */
let modeOf = () => 'here';
export const setWorktreeLineMode = (fn) => { modeOf = fn; };

/**
 * worktree で始めた印の行（present kind: 'worktree'。worktree: { id, branch, path, origin, conflicts, count }）。
 * 状態は paintWorktreeLine で切り替える（here: 元の場所に戻す / backing: 次のターンから戻す・もう一度 worktree で始める / back: 戻した・もう一度 worktree で始める）。
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

// ---------------------------------------------------------------- 右パネル「残っている worktree」

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

  const set = (row, state) => { stateOf.set(row.id, { ...state, row }); changed(); };
  const clear = (id) => { stateOf.delete(id); changed(); };

  // i18n-dynamic: worktree.left.fail.
  const failText = (why) => t(`worktree.left.fail.${['busy', 'links', 'changed', 'archive', 'unowned', 'attached'].includes(why) ? why : 'other'}`);

  function rowView(row) {
    const st = stateOf.get(row.id) ?? { s: row.kept ? 'keep' : 'idle', msg: row.kept ? t('worktree.left.kept') : '', undo: t('worktree.left.keptUndo') };
    const box = el('div', 'wt-item');
    box.dataset.state = st.s;
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
    actions(row) { return rowView(row); },
    reset() { stateOf.clear(); },
  };
}
