// git の動きの画面の部品（web/git-view.mjs・web/git-panel.mjs の純粋な部分）。
// 要約行の文・委譲カードの「変更」の行・右パネルの枠の表（gitSlots）を、最小の DOM で見る。
import assert from 'node:assert/strict';
import { changeText, branchLabel, filesText, summaryParts, renderGitSummary, renderDelegateGit } from '../../web/git-view.mjs';
import { applySlots, gitSlots } from '../../web/side-panel.mjs';

export const name = 'git-view';
export const title = 'git の動きの画面: 要約行の文・委譲カードの変更の行・右パネルの表';

const text = (node) => node.textContent;
const all = (node, cls) => node.querySelectorAll(`.${cls}`);

export default async function (t) {
  assert.equal(changeText(6, 2), '+6 −2'); assert.equal(changeText(18, 0), '+18', '削除が 0 なら −0 を出さない'); assert.equal(changeText(0, 3), '+0 −3');
  assert.equal(branchLabel({ branch: 'fix/x' }), 'fix/x'); assert.equal(branchLabel({ branch: null, head: '3f2a9c1' }), 'HEAD 3f2a9c1'); assert.equal(branchLabel({ branch: null, head: null }), '（コミットなし）');
  assert.equal(filesText({ files: 2, add: 6, del: 2 }), '2 ファイル +6 −2');
  t.ok('文: +a −d・ブランチ名（分離した HEAD・コミット前）・N ファイル', true);

  const turn = { n: 2, branch: 'fix/token-refresh', head: '3f2a9c1', files: 2, add: 6, del: 2, commits: [{ hash: '3f2a9c1', subject: 'fix' }], commitCount: 1, pr: { number: 128, url: 'https://x/pull/128' } };
  assert.deepEqual(summaryParts(turn).map((p) => p.key), ['files', 'commit', 'pr']);
  assert.equal(summaryParts(turn)[1].text, 'コミット 3f2a9c1'); assert.equal(summaryParts(turn)[2].text, 'PR #128');
  assert.equal(summaryParts({ ...turn, commitCount: 3 })[1].text, 'コミット 3', 'コミットが複数なら件数');
  assert.deepEqual(summaryParts({ branch: 'main', files: 0, commitCount: 0, pr: null }), [], 'ブランチだけ（切り替え・作成のみ）なら続きの部分は無い');
  t.ok('要約の部分: ファイル・コミット（1 件は hash、複数は件数）・PR は、あるものだけ', true);

  const row = renderGitSummary({ kind: 'git', git: turn, sessionId: 's1' });
  const button = row.querySelector('button');
  assert.equal(text(button), 'fix/token-refresh·2 ファイル +6 −2·コミット 3f2a9c1·PR #128');
  assert(button.attrs['aria-label'] === 'git の変更を開く' && row.className === 'git-sum-row' && button.className === 'git-sum');
  assert.equal(all(button, 'git-sum-part').map((p) => p.className).join(), 'git-sum-part files,git-sum-part commit,git-sum-part pr', '狭いときに commit だけ隠せるよう、部分ごとに種類の class を持つ');
  let detail = null;
  button.addEventListener('ply-git-open', (e) => { detail = e.detail; });
  button.on.click[0]();
  assert.deepEqual(detail, { sessionId: 's1', turn: 2 });
  assert.equal(renderGitSummary({ kind: 'git' }), null, '要約が無ければ何も描かない');
  t.ok('要約行: 1 つのボタン・部分の class・押すと ply-git-open（会話と何ターン目か）', true);

  assert.equal(renderDelegateGit(null, { sessionId: 'c' }), null);
  assert.equal(renderDelegateGit({ branch: 'pleiad/ply-1', session: { files: 0, add: 0, del: 0, commits: 0 } }, { sessionId: 'c' }), null, '変更もコミットも無ければ出さない');
  const child = renderDelegateGit({ branch: 'pleiad/ply-1', linked: true, session: { files: 3, add: 40, del: 12, commits: 2 } }, { sessionId: 'c' });
  assert.equal(child.querySelector('.git-delegate-label').textContent, '変更');
  assert.equal(text(child.querySelector('.git-sum')), 'pleiad/ply-1（worktree）·3 ファイル +40 −12·コミット 2');
  let childDetail = null;
  child.querySelector('.git-sum').addEventListener('ply-git-open', (e) => { childDetail = e.detail; });
  child.querySelector('.git-sum').on.click[0]();
  assert.deepEqual(childDetail, { sessionId: 'c' }, '押すとその子の会話の作業場所の git パネル');
  assert.equal(text(renderDelegateGit({ branch: 'main', linked: false, session: { files: 1, add: 1, del: 0, commits: 0 } }, { sessionId: 'c' }).querySelector('.git-sum')), 'main·1 ファイル +1', 'worktree でなければ札を付けない・コミットが無ければ出さない');
  t.ok('委譲カード: 「変更」の行（worktree の札・ファイルとコミット）・押すと子の git パネル', true);

  // ---- 右パネルの表（gitSlots）
  const slots = gitSlots({ label: 'git', footer: ['custom0', 'custom1'] });
  assert.deepEqual(slots.head, ['close']); assert.deepEqual(slots.footer, ['custom0', 'custom1']);
  assert.deepEqual(gitSlots({ label: 'git', head: ['customHead0'], toolbar: ['customTool0'] }).head, ['customHead0', 'wide', 'close'], 'git パネルは頭に再読み込み・広げる・閉じる');
  assert.deepEqual(gitSlots({ label: 'chrome', wide: true }).head, ['wide', 'close'], 'wide だけのパネル（Chrome の窓）は頭に広げる・閉じる');
  assert.deepEqual(gitSlots({ label: 'x' }).head, ['close'], '何も頼まなければ閉じるだけ');
  assert.deepEqual(gitSlots({ label: 'git', toolbar: ['customTool0'] }).toolbar, ['customTool0'], '道具の列にタブ');
  assert.equal(slots.aside, false); assert.equal(slots.views, false); assert.deepEqual(slots.toolbar, []); assert.equal(gitSlots({ label: 'git' }).footer, null);
  const node = (tag = 'div') => document.createElement(tag);
  const buttons = Object.fromEntries(['close', 'custom0', 'custom1', 'reload', 'use'].map((id) => { const b = node('button'); b.textContent = id; return [id, b]; }));
  const parts = { panel: node('aside'), name: node('span'), kind: node('span'), path: node('div'), actions: node(), toolbar: node(), switcher: node(), tools: node(),
    location: node(), note: node(), treePane: node(), footer: node('footer'), footActions: node(), status: node('span'), content: node(), buttons };
  applySlots(parts, { ...slots, title: 'git', subtitle: 'D:/dev/pleiad', status: '12:40 に取得' });
  assert.deepEqual(parts.footActions.children.map((c) => c.textContent), ['custom0', 'custom1'], '下の行は渡した 2 つだけ（ファイルの reload・use ではない）');
  assert.equal(parts.footer.hidden, false); assert.equal(parts.treePane.hidden, true); assert.equal(parts.status.textContent, '12:40 に取得'); assert.equal(parts.path.textContent, 'D:/dev/pleiad');
  t.ok('右パネルの表: git は閉じる・本文・下の行（取得時刻と 2 つのボタン）だけ', true);
}
