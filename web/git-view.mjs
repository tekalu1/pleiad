// git の動きの小さな部品（docs/design-system.md「git の動き」、ADR 0085）。
//   - 返答の下の要約行（present kind: 'git'）: ⑂ ブランチ · N ファイル +a −d · コミット hash · PR #n ›
//   - 委譲カードの内訳の先頭の「変更」の行
// 文の組み立て（summaryParts・changeText・branchLabel）は DOM に触れない。押したときは ply-git-open を投げ、
// 右パネルを開くのは web/client.mjs（web/git-panel.mjs）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { branchIcon, chevRightIcon } from './icons.mjs';

/** 「+6 −2」。削除が 0 なら +6 だけ（新規ファイルだけのときに −0 を出さない） */
export const changeText = (add, del) => `+${add}${del ? ` −${del}` : ''}`;

/** ブランチの名前。分離した HEAD は HEAD <hash>、最初のコミット前は「（コミットなし）」 */
export const branchLabel = (git) => git?.branch ?? (git?.head ? t('git.detached', { hash: git.head }) : t('git.noBranch'));

/** 「2 ファイル +6 −2」 */
export const filesText = (total) => `${t('git.files', { count: total.files })} ${changeText(total.add, total.del)}`;

/**
 * 返答の下の 1 行の中身。ブランチ以外は、あるものだけ。
 * 返り値: [{ key: 'files'|'commit'|'pr', text }]（狭いときは commit を隠す）
 */
export function summaryParts(git) {
  const parts = [];
  if (git?.files > 0) parts.push({ key: 'files', text: filesText({ files: git.files, add: git.add, del: git.del }) });
  if (git?.commitCount > 0) parts.push({ key: 'commit', text: git.commitCount === 1 && git.commits?.[0] ? t('git.commitOne', { hash: git.commits[0].hash }) : t('git.commits', { count: git.commitCount }) });
  if (git?.pr) parts.push({ key: 'pr', text: t('git.pr', { number: git.pr.number }) });
  return parts;
}

/** 1 つのチップ: アイコン + 字の列 + › のボタン（要約行と委譲カードの「変更」の行が共有する） */
function chipButton(className, label, branch, parts, detail) {
  const b = el('button', className);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const icon = el('span', 'git-sum-ic');
  icon.innerHTML = branchIcon;
  b.append(icon, el('span', 'git-sum-br', branch));
  for (const p of parts) {
    const part = el('span', `git-sum-part ${p.key}`);
    part.append(el('span', 'git-sum-sep', '·'), el('span', null, p.text));
    b.append(part);
  }
  const go = el('span', 'git-sum-go');
  go.innerHTML = chevRightIcon;
  b.append(go);
  b.addEventListener('click', () => b.dispatchEvent(new CustomEvent('ply-git-open', { bubbles: true, detail })));
  return b;
}

/**
 * 返答の下の要約行。ev は present イベント / 保存した記録（kind: 'git'、git: ターンの要約、sessionId、at）。
 * 要約が空なら null（何も出さない）
 */
export function renderGitSummary(ev) {
  const git = ev?.git;
  if (!git) return null;
  const row = el('div', 'git-sum-row');
  row.dataset.gitTurn = String(git.n ?? '');
  row.append(chipButton('git-sum', t('git.sumOpen'), branchLabel(git), summaryParts(git), { sessionId: ev.sessionId ?? null, turn: git.n ?? null }));
  return row;
}

/**
 * 委譲カードの内訳の先頭の「変更」の行。status は gitStatus { summary: true } の git（子の作業場所の状態と会話の間の合計）。
 * 変更もコミットも無ければ null。押すとその作業場所の git パネル（detail.sessionId は子の会話）
 */
export function renderDelegateGit(status, { sessionId }) {
  const w = status?.session;
  if (!status || !w || (!w.files && !w.commits)) return null;
  const parts = [];
  if (w.files > 0) parts.push({ key: 'files', text: filesText(w) });
  if (w.commits > 0) parts.push({ key: 'commit', text: t('git.commits', { count: w.commits }) });
  const row = el('div', 'git-delegate');
  row.append(el('div', 'git-delegate-label', t('git.delegateChanges')));
  const name = status.linked ? t('git.branchWorktree', { branch: branchLabel(status) }) : branchLabel(status);
  row.append(chipButton('git-sum wrap', t('git.delegateOpen'), name, parts, { sessionId }));
  return row;
}
