// git の動きの画面の部品（web/git-view.mjs・web/git-panel.mjs の純粋な部分）。
// 要約行の文・委譲カードの「変更」の行・右パネルの「したこと」の行と差分の描き方（色を付けない・+ − の記号と面の階調）を、最小の DOM で見る。
import assert from 'node:assert/strict';
import { changeText, branchLabel, filesText, summaryParts, renderGitSummary, renderDelegateGit } from '../../web/git-view.mjs';
import { actRow, diffBody } from '../../web/git-panel.mjs';
import { applySlots, gitSlots } from '../../web/side-panel.mjs';

export const name = 'git-view';
export const title = 'git の動きの画面: 要約行の文・委譲カードの変更の行・したことの行・差分の面（色なし）・右パネルの表';

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
  assert.equal(text(child.querySelector('.git-sum')), 'pleiad/ply-1（分けた作業場所）·3 ファイル +40 −12·コミット 2');
  let childDetail = null;
  child.querySelector('.git-sum').addEventListener('ply-git-open', (e) => { childDetail = e.detail; });
  child.querySelector('.git-sum').on.click[0]();
  assert.deepEqual(childDetail, { sessionId: 'c' }, '押すとその子の会話の作業場所の git パネル');
  assert.equal(text(renderDelegateGit({ branch: 'main', linked: false, session: { files: 1, add: 1, del: 0, commits: 0 } }, { sessionId: 'c' }).querySelector('.git-sum')), 'main·1 ファイル +1', '分けた作業場所でなければ札を付けない・コミットが無ければ出さない');
  t.ok('委譲カード: 「変更」の行（分けた作業場所の札・ファイルとコミット）・押すと子の git パネル', true);

  // ---- 右パネルの「したこと」の行
  const jumps = [];
  const branchRow = actRow({ kind: 'branch', branch: 'fix/x', at: '2026-10-03T03:31:00Z', uuid: 'a1', toolId: 't1' }, { jump: (e) => jumps.push(e) });
  assert(text(branchRow).includes('ブランチ') && text(branchRow).includes('fix/x') && text(branchRow).includes('を作成'));
  assert.equal(branchRow.querySelector('code').textContent, 'fix/x', 'ブランチ名・hash は等幅（code）');
  const commitRow = actRow({ kind: 'commit', hash: '3f2a9c1', subject: 'fix: a', branch: 'x' }, { jump: () => {} });
  assert(text(commitRow).includes('コミット') && text(commitRow).includes('3f2a9c1') && text(commitRow).includes('「fix: a」'));
  assert(text(actRow({ kind: 'pr', number: 128, url: 'u' }, { jump: () => {} })).includes('PR #128 を作成'));
  const go = branchRow.querySelector('button');
  assert.equal(go.attrs['aria-label'], '会話のこの場所へ'); go.onclick();
  assert.deepEqual(jumps, [{ kind: 'branch', branch: 'fix/x', at: '2026-10-03T03:31:00Z', uuid: 'a1', toolId: 't1' }], '会話のこの場所へ: 行の元の出来事を渡す');
  assert.equal(actRow({ kind: 'pr', number: 1, url: 'u' }, { jump: () => {}, jumpable: false }).querySelector('button').hidden, true, '別の会話の作業場所では飛ばない');
  t.ok('したことの行: 時刻・種類のアイコン・文（ブランチ名と hash は等幅）・会話のこの場所へ', true);

  // ---- 差分: 色を付けず、記号と面の階調
  const box = diffBody({ hunks: [{ header: '@@ -1,2 +1,2 @@ fn', lines: [{ t: ' ', s: 'keep' }, { t: '-', s: 'old' }, { t: '+', s: 'new' }] }, { header: '@@ -9 +9 @@', lines: [{ t: '+', s: 'x' }] }] });
  const lines = all(box, 'git-dl');
  assert.deepEqual(lines.map((l) => l.className), ['git-dl c', 'git-dl d', 'git-dl a', 'git-dl a']);
  assert.deepEqual(lines.map((l) => l.children[0].textContent), [' ', '−', '+', '+'], '削除は − の記号（U+2212）で出す');
  assert.equal(all(box, 'git-dh').length, 2);
  assert(!/color|style/.test(box.outerHTML.replace(/class="[^"]*"/g, '')), '色や style を直書きしない');
  t.ok('差分: 追加・削除・文脈を class で分け（面の階調は CSS）、記号は + − 、色の指定を持たない', true);

  // ---- 右パネルの表（gitSlots）
  const slots = gitSlots({ label: 'git', footer: ['custom0', 'custom1'] });
  assert.deepEqual(slots.head, ['close']); assert.deepEqual(slots.footer, ['custom0', 'custom1']);
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
