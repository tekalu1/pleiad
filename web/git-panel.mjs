// 右パネル「git」（docs/design-system.md「git の動き」、ADR 0085・ADR 0015）。
// 見せるのは、ブランチと状態・この会話でしたこと（ブランチ作成・コミット・PR 作成）・変更（範囲 2 つ → ファイル → 統一差分）。
// 取るのは開いたときと再読み込みのときだけ（gitPanel・gitDiff）。差分に色は付けない（記号と面の階調。docs/design-system.md §2.2）。
// 右パネルの枠は web/file-preview.mjs の openPanel（customSlots + footer）。ここは中身だけを作る。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { branchIcon, commitIcon, prIcon, jumpIcon, chevRightIcon, backIcon, openInBrowserIcon } from './icons.mjs';
import { branchLabel, changeText, filesText } from './git-view.mjs';
import { createLeftovers } from './worktree-ui.mjs';

const KEY = 'git';
const ACT_ICON = { branch: branchIcon, commit: commitIcon, pr: prIcon };
const MARK = '⁣';

/** 辞書の文の {{x}} の所へ要素（<code> など）を差し込む。t() には目印だけ渡して、文を割る */
// i18n-dynamic: git.act
function fill(key, params, nodes) {
  const text = t(key, { ...params, ...Object.fromEntries(Object.keys(nodes).map((k) => [k, `${MARK}${k}${MARK}`])) });
  const out = [];
  for (const piece of text.split(MARK)) if (piece) out.push(nodes[piece] ?? el('span', null, piece));
  return out;
}

/** 会話でしたことの 1 行（時刻・アイコン・文・「会話のこの場所へ」）。events は gitPanel の timeline */
export function actRow(event, { jump, jumpable = true }) {
  const li = el('li', 'git-act');
  const time = el('time', null, event.at ? fmt.time(event.at) : '');
  const ic = el('span', 'git-act-ic');
  ic.innerHTML = ACT_ICON[event.kind] ?? commitIcon;
  const tx = el('span', 'git-act-tx');
  const code = (text) => el('code', null, text);
  if (event.kind === 'branch') tx.append(...fill('git.actBranch', {}, { branch: code(event.branch) }));
  else if (event.kind === 'commit') tx.append(...fill('git.actCommit', { subject: event.subject }, { hash: code(event.hash) }));
  else tx.append(el('span', null, t('git.actPr', { number: event.number })));
  const go = el('button', 'btn btn-icon git-act-go');
  go.type = 'button';
  go.innerHTML = jumpIcon;
  go.title = t('git.jump');
  go.setAttribute('aria-label', t('git.jump'));
  go.onclick = () => jump(event);
  go.hidden = jumpable === false;
  li.append(time, ic, tx, go);
  return li;
}

/** 統一差分の本文（ハンクの並び）。+ − の記号と面の階調で読む。色は付けない */
export function diffBody(diff) {
  const box = el('div', 'git-diff');
  const inner = el('div', 'git-diff-in');
  for (const hunk of diff.hunks) {
    inner.append(el('div', 'git-dh', hunk.header));
    for (const line of hunk.lines) {
      const row = el('div', `git-dl ${line.t === '+' ? 'a' : line.t === '-' ? 'd' : 'c'}`);
      row.append(el('span', 'git-sg', line.t === '-' ? '−' : line.t === '+' ? '+' : ' '), el('span', null, `${line.s} `));
      inner.append(row);
    }
  }
  box.append(inner);
  return box;
}

/**
 * @param {object} o
 * @param {(command:string, args?:object) => Promise<any>} o.cmd
 * @param {object} o.preview web/file-preview.mjs の返り値（openPanel・updatePanel・panelOpen・close）
 * @param {() => ({ id:string|null, cwd:string|null })} o.session 今の会話
 * @param {(event:object) => boolean} o.jump 会話のこの場所へ（見つからなければ false）
 * @param {(text:string) => void} o.use 入力欄へ字を足す
 * @param {(git:object|null) => void} o.onState 取った状態を頭の行・入力欄へ渡す
 * @param {object} o.worktrees 「残っている作業場所」の操作（keep・ask・unask・archive・restore。web/worktree-ui.mjs の createLeftovers）
 */
export function setupGitPanel({ cmd, preview, session, jump, use, onState = () => {}, worktrees }) {
  // 残っている作業場所（分けた作業場所の未取り込み。ADR 0088）。操作の結果の行はこの部品が持ち、変わったら描き直す
  const leftovers = createLeftovers({ ...worktrees, changed: () => paint() });
  let st = { key: null, range: 'session', data: null, loading: false, failed: false, file: null, diff: null, diffFailed: false, at: null, note: '' };
  let opener = null, ticket = 0, noteTimer = 0;
  // 開いている先の会話。別の会話の作業場所（委譲した子）を開いたときは今の会話と違う。その会話の中の場所へは飛べない
  let target = null;
  const sid = () => target ?? session().id;

  const isOpen = () => preview.panelOpen(KEY);

  // ---------------------------------------------------------------- 中身
  function statusSection(git, timeline) {
    const sec = el('section', 'git-st');
    const bn = el('div', 'git-bn');
    const ic = el('span', 'git-bn-ic');
    ic.innerHTML = branchIcon;
    bn.append(ic, el('span', null, branchLabel(git)));
    sec.append(bn);
    const chips = el('div', 'git-chips');
    if (git.linked) chips.append(el('span', 'git-tag', t('git.worktree')));
    if (git.branch) {
      if (git.upstream) {
        if (git.ahead > 0) chips.append(el('span', 'git-chip', t('git.ahead', { count: git.ahead })));
        if (git.behind > 0) chips.append(el('span', 'git-chip', t('git.behind', { count: git.behind })));
      } else if (git.head) chips.append(el('span', 'git-chip', t('git.unpushed')));
    }
    const pr = [...timeline].reverse().find((e) => e.kind === 'pr');
    if (pr) {
      const a = el('a', 'git-chip git-chip-link');
      a.href = pr.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = t('git.prTitle', { number: pr.number });
      a.append(t('git.pr', { number: pr.number }));
      const ext = el('span', 'git-chip-ic');
      ext.innerHTML = openInBrowserIcon;
      a.append(ext);
      chips.append(a);
    }
    if (chips.children.length) sec.append(chips);
    return sec;
  }

  function actsSection(timeline) {
    if (!timeline.length) return null;
    const sec = el('section', 'git-sec');
    const head = el('div', 'git-sh');
    head.append(el('h3', null, t('git.acts')));
    const ol = el('ol', 'git-acts');
    const foreign = Boolean(target && target !== session().id);
    for (const event of timeline) ol.append(actRow(event, { jump: (e) => { if (!jump(e)) setNote(t('git.jumpFailed')); }, jumpable: !foreign }));
    sec.append(head, ol);
    return sec;
  }

  function changesSection(changes) {
    const sec = el('section', 'git-sec');
    const head = el('div', 'git-sh');
    head.append(el('h3', null, t('git.changes')));
    if (changes && changes.files.length) head.append(el('span', 'git-tot', filesText(changes.total)));
    sec.append(head);
    const rng = el('div', 'git-rng');
    rng.setAttribute('role', 'group');
    rng.setAttribute('aria-label', t('git.range'));
    const pills = [['uncommitted', t('git.rangeUncommitted')], ...(changes?.hasSession ? [['session', t('git.rangeSession')]] : [])];
    for (const [value, label] of pills) {
      const b = el('button', 'git-rp', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(changes?.range === value));
      b.onclick = () => { if (st.range !== value) { st.range = value; load(); } };
      rng.append(b);
    }
    sec.append(rng);
    if (!changes || changes.failed) { sec.append(el('div', 'git-empty', t('git.failedChanges'))); return sec; }
    if (!changes.files.length) { sec.append(el('div', 'git-empty', changes.range === 'session' ? t('git.emptySession') : t('git.emptyUncommitted'))); return sec; }
    for (const file of changes.files) sec.append(fileRow(file));
    return sec;
  }

  function fileRow(file) {
    const b = el('button', 'git-frow');
    b.type = 'button';
    const slash = file.path.lastIndexOf('/');
    const nm = el('span', 'git-nm');
    nm.append(el('span', 'git-dir', file.path.slice(0, slash + 1)), file.path.slice(slash + 1));
    const counts = file.binary ? '' : changeText(file.add, file.del);
    const ic = el('span', 'git-go');
    ic.innerHTML = chevRightIcon;
    // i18n-dynamic: git.state
    b.append(el('span', 'git-k', t(`git.state${file.state}`)), nm, el('span', 'git-cn', counts), ic);
    b.onclick = () => openFile(file);
    return b;
  }

  function diffView() {
    const f = st.file;
    const box = el('div', 'git-view');
    const back = el('button', 'git-vback');
    back.type = 'button';
    back.innerHTML = backIcon;
    back.append(t('git.diffBack'));
    back.onclick = () => { st.file = null; st.diff = null; paint(); };
    const head = el('div', 'git-vhead');
    // i18n-dynamic: git.state
    head.append(el('span', 'git-k', t(`git.state${f.state}`)), el('span', null, f.path), el('span', 'git-cn', f.binary ? '' : changeText(f.add, f.del)));
    box.append(back, head);
    if (st.diffFailed) box.append(el('div', 'git-empty', t('git.failedDiff')));
    else if (!st.diff) box.append(el('div', 'git-empty', t('git.loading')));
    else if (st.diff.binary) box.append(el('div', 'git-empty', t('git.binary')));
    else if (!st.diff.hunks.length) box.append(el('div', 'git-empty', st.diff.truncated ? t('git.truncated') : t('git.noDiff')));
    else {
      box.append(diffBody(st.diff));
      if (st.diff.truncated) box.append(el('div', 'git-empty', t('git.truncated')));
    }
    return box;
  }

  function body() {
    const root = el('div', 'git-panel');
    if (st.file) { root.append(diffView()); return root; }
    if (st.loading && !st.data) { root.append(el('div', 'git-empty', t('git.loading'))); return root; }
    if (st.failed || !st.data) { root.append(el('div', 'git-empty', t('git.failed'))); return root; }
    const { git, timeline, changes } = st.data;
    root.append(statusSection(git, timeline));
    const left = leftovers.section(st.data.worktrees?.leftovers ?? []);
    if (left) root.append(left);
    const acts = actsSection(timeline);
    if (acts) root.append(acts);
    root.append(changesSection(changes));
    return root;
  }

  const statusText = () => st.note || (st.at ? t('git.fetchedAt', { time: fmt.time(st.at) }) : '');
  function paint() {
    if (!isOpen()) return;
    preview.updatePanel(KEY, { title: t('git.panel'), subtitle: st.data?.git?.root ?? '', body: body(), status: statusText() });
  }
  function setNote(text) {
    st.note = text;
    paint();
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => { st.note = ''; paint(); }, 1800);
  }

  // ---------------------------------------------------------------- 取得
  async function load() {
    const id = sid();
    if (!id) return;
    const mine = ++ticket;
    st.loading = true; st.failed = false;
    paint();
    let data = null;
    try { data = await cmd('gitPanel', { sessionId: id, range: st.range }); } catch { /* 取れなかった */ }
    if (mine !== ticket || sid() !== id) return;
    st.loading = false;
    st.at = Date.now();
    const foreign = Boolean(target && target !== session().id);
    if (!data?.git) { st.data = null; st.failed = true; onState(null, { foreign }); paint(); return; }
    st.data = data;
    st.range = data.changes?.range ?? st.range;
    onState(data.git, { foreign });
    if (st.file) await loadDiff();
    paint();
  }

  async function loadDiff() {
    const id = sid();
    const f = st.file;
    st.diff = null; st.diffFailed = false;
    paint();
    let res = null;
    try { res = await cmd('gitDiff', { sessionId: id, range: st.range, path: f.path }); } catch { /* */ }
    if (st.file !== f || sid() !== id) return;
    if (res?.diff) st.diff = res.diff; else st.diffFailed = true;
  }

  async function openFile(file) {
    st.file = file;
    await loadDiff();
    paint();
  }

  // ---------------------------------------------------------------- 開閉
  function resetFor(id) {
    if (st.key === id) return;
    ticket++;
    leftovers.reset();
    st = { key: id, range: 'session', data: null, loading: false, failed: false, file: null, diff: null, diffFailed: false, at: null, note: '' };
  }

  function useInChat() {
    const git = st.data?.git;
    let text = '';
    if (st.file) text = t('git.useFile', { path: st.file.path });
    else if (git) {
      const total = st.data.changes?.total;
      text = t('git.useStatus', { branch: branchLabel(git), summary: total?.files ? filesText(total) : t('git.emptyUncommitted') });
    }
    if (!text) return;
    use(text);
    setNote(t('git.used'));
  }

  function open(element, { sessionId = null } = {}) {
    target = sessionId && sessionId !== session().id ? sessionId : null;
    const id = sid();
    if (!id) return;
    resetFor(id);
    opener = element ?? null;
    preview.openPanel({
      key: KEY, title: t('git.panel'), subtitle: st.data?.git?.root ?? '', label: t('git.panel'), element: opener, body: body(),
      status: statusText(), onClose: () => { opener?.setAttribute?.('aria-expanded', 'false'); onOpenChange(false); },
      footer: [{ label: t('git.reload'), onClick: () => load() }, { label: t('git.use'), onClick: useInChat }],
    });
    onOpenChange(true);
    load();
  }
  let onOpenChange = () => {};

  function toggle(element, options) {
    if (isOpen()) preview.close(true); else open(element, options);
  }

  // Esc: 差分を開いている間は、パネルを閉じずに変更の一覧へ戻る
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen() || !st.file || e.defaultPrevented) return;
    e.preventDefault(); e.stopImmediatePropagation();
    st.file = null; st.diff = null; paint();
  }, true);

  return {
    open, toggle, isOpen, reload: () => { if (isOpen()) load(); },
    /** 別の会話へ移った・会話を閉じた。開いているパネルは閉じる */
    reset() { target = null; resetFor(null); if (isOpen()) preview.close(false); },
    /** 会話の今の状態が変わった（ターンの終わり）。開いていれば取り直す */
    changed() { if (isOpen()) load(); },
    onOpenChange(fn) { onOpenChange = fn; },
  };
}
