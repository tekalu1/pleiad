// 分けた作業場所の画面の部品（web/worktree-ui.mjs。ADR 0089）を最小の DOM で見る。
// 送ると自動で分けるかの判定・設定の「作業場所」・会話の中の静かな 1 行の状態（here / backing / back）・
// 右パネルの「残っている作業場所」（取り込みを頼む・退避して消す・残す・取り消し・元に戻す・安全の 2 行）・取り込みの依頼文。
import assert from 'node:assert/strict';
import { shortPath, whoText, askText, autoSplitPlan, setupWorktreeSettings, renderWorktreeLine, paintWorktreeLine, setWorktreeLineMode, createLeftovers } from '../../web/worktree-ui.mjs';

export const name = 'worktree-view';
export const title = '分けた作業場所の画面: 自動で分けるかの判定・設定の作業場所・会話の中の静かな 1 行・残っている作業場所の操作と結果の行・取り込みの依頼文';

const all = (node, cls) => node.querySelectorAll(`.${cls}`);
const buttonsOf = (node) => node.querySelectorAll('button');
const labelled = (node, text) => buttonsOf(node).find((b) => b.textContent.includes(text));
const tick = () => new Promise((r) => setTimeout(r, 0));

export default async function (t) {
  assert.equal(shortPath('D:/dev/pleiad.pleiad/ply-7f3a'), 'pleiad.pleiad/ply-7f3a'); assert.equal(shortPath('C:\\Users\\a\\x.pleiad\\ply-1'), 'x.pleiad/ply-1'); assert.equal(shortPath(''), '');
  t.ok('短い名前: パスの末尾 2 つ', true);
  assert.equal(whoText([{ title: 'リリースノートの下書き' }]), '「リリースノートの下書き」');
  assert.equal(whoText([{ title: 'A' }, { title: 'B' }, { title: 'C' }]), '「A」ほか 2 件');
  assert.equal(whoText([{ title: '' }]), 'ほかの会話'); assert.equal(whoText([]), 'ほかの会話');
  t.ok('作業中の別の会話の名前: 1 件・複数・題が無い', true);

  // ---- 送ると自動で分けるか（チップの「· 分けて始めます」の元。入力欄の上の 1 行は無い）
  const conflict = { git: true, canSplit: true, always: true, conflicts: [{ title: 'リリースノートの下書き' }] };
  assert.deepEqual(autoSplitPlan(conflict), { who: '「リリースノートの下書き」' }, 'ぶつかっていて自動で分けるなら、誰が作業中かを返す');
  assert.deepEqual(autoSplitPlan({ ...conflict, conflicts: [{ title: 'A' }, { title: 'B' }] }), { who: '「A」ほか 1 件' });
  assert.equal(autoSplitPlan({ ...conflict, always: false }), null, '自動で分ける設定がオフなら出さない（保存したオフ）');
  assert.equal(autoSplitPlan({ ...conflict, conflicts: [] }), null, 'ぶつかっていなければ出さない');
  assert.equal(autoSplitPlan({ ...conflict, canSplit: false }), null, '分けた作業場所の中・分けられない場所では出さない');
  assert.equal(autoSplitPlan(conflict, { stay: true }), null, '「このまま元の場所で始める」を選んだら出さない');
  assert.equal(autoSplitPlan(conflict, { running: true }), null, 'この会話が走っている間は出さない（送ると今のターンへ渡る）');
  assert.equal(autoSplitPlan(null), null); assert.equal(autoSplitPlan(undefined, { stay: false }), null);
  t.ok('自動で分けるか: ぶつかり・設定・分けられるか・今回だけ元の場所・走っている間', true);

  // ---- 設定 › エージェント設定の「作業場所」
  const sent = [];
  const settings = setupWorktreeSettings({ cmd: async (c, a) => { sent.push([c, a]); return { always: c === 'setWorktreeSettings' ? a.always : false }; } });
  assert.equal(settings.element.querySelector('h3').textContent, '作業場所');
  const sw = settings.element.querySelector('button');
  assert.equal(sw.attrs['aria-label'], 'ほかの会話が同じリポジトリで書いている間は、分けた作業場所で始める');
  assert.equal(settings.element.querySelector('.mp-note').textContent, '分けたときは、会話の一行から元の場所に戻せます。');
  settings.paint(true);
  assert.equal(sw.getAttribute('aria-checked'), 'true', '既定はオンの見た目');
  sw.onclick(); await tick(); await tick();
  assert.deepEqual(sent.at(-1), ['setWorktreeSettings', { always: false }]); assert.equal(sw.getAttribute('aria-checked'), 'false');
  t.ok('設定「作業場所」: 見出し・スイッチの名前・説明・既定オン・押すと保存', true);

  // ---- 会話の中の静かな 1 行
  const ev = { kind: 'worktree', worktree: { id: 'ply-7f3a', branch: 'pleiad/ply-7f3a', path: 'D:/dev/pleiad.pleiad/ply-7f3a', origin: 'D:/dev/pleiad', conflicts: ['リリースノートの下書き'], count: 1 } };
  let modeNow = 'here';
  setWorktreeLineMode(() => modeNow);
  const line = renderWorktreeLine(ev);
  assert.equal(line.className, 'wt-line'); assert.equal(line.dataset.worktreeId, 'ply-7f3a');
  assert.equal(line.querySelector('.wt-line-t').textContent, '分けた作業場所で始めました（「リリースノートの下書き」が作業中）');
  const lineBtn = line.querySelector('button');
  assert.equal(lineBtn.textContent, '元の場所に戻す');
  let acted = null;
  line.addEventListener('ply-worktree', (e) => { acted = e.detail; });
  lineBtn.onclick();
  assert.equal(acted?.act, 'back'); assert.equal(acted?.note.origin, 'D:/dev/pleiad');
  paintWorktreeLine(line, 'backing');
  assert.equal(line.querySelector('.wt-line-t').textContent, '次のターンから元の場所に戻します'); assert.equal(lineBtn.textContent, 'もう一度分ける');
  acted = null; lineBtn.onclick(); assert.equal(acted?.act, 'again', '戻す前（backing）の「もう一度分ける」は again');
  paintWorktreeLine(line, 'back');
  assert.equal(line.querySelector('.wt-line-t').textContent, '元の場所に戻しました'); assert.equal(lineBtn.textContent, 'もう一度分ける');
  modeNow = 'back';
  assert.equal(renderWorktreeLine(ev).dataset.mode, 'back', '初めの状態は client が決める（cwd と予約から）');
  const many = renderWorktreeLine({ worktree: { id: 'x', conflicts: ['A'], count: 3 } });
  modeNow = 'here'; paintWorktreeLine(many, 'here');
  assert.equal(many.querySelector('.wt-line-t').textContent, '分けた作業場所で始めました（「A」ほか 2 件が作業中）', '件数が題より多いときは、ほか N 件');
  paintWorktreeLine(renderWorktreeLine({ worktree: { id: 'y', conflicts: [], count: 0 } }), 'here');
  assert.equal(renderWorktreeLine({ worktree: { id: 'y' } }).querySelector('.wt-line-t').textContent, '分けた作業場所で始めました');
  assert.equal(renderWorktreeLine({}).className, 'wt-line', '印が無ければ空の枠');
  t.ok('会話の中の行: 始めた文・here / backing / back の文とボタン・押すと ply-worktree（back / again）・題が無い・件数が多い', true);

  // ---- 取り込みの依頼文
  assert.equal(askText({ branch: 'pleiad/ply-7f3a', path: 'D:/dev/pleiad.pleiad/ply-7f3a', origin: 'D:/dev/pleiad', baseBranch: 'main' }),
    '分けた作業場所 pleiad/ply-7f3a（D:/dev/pleiad.pleiad/ply-7f3a）の変更を、元の作業場所（D:/dev/pleiad）のブランチ main に取り込んでください。競合があれば解いてください。取り込めたら、分けた作業場所は Pleiad が片付けます。');
  assert(askText({ branch: 'b', path: 'p', origin: 'o', baseBranch: null }).includes('の元のブランチに取り込んでください'));
  t.ok('取り込みの依頼文: ブランチ・場所・元の場所・取り込み先（無ければ元のブランチ）・競合は解く・片付けは Pleiad', true);

  // ---- 右パネルの「残っている作業場所」
  let changed = 0;
  const log = [];
  const ops = {
    keep: async (id, kept) => { log.push(['keep', id, kept]); },
    ask: async (row) => { log.push(['ask', row.id]); return row.mergeSessionId ? { title: '更新まわりの不具合をまとめて直す', messageId: 'm1', sessionId: row.mergeSessionId } : null; },
    unask: async (sent) => { log.push(['unask', sent.messageId]); return sent.late !== true; },
    archive: async (row) => { log.push(['archive', row.id]); return row.fail ? { action: 'failed', why: 'busy' } : { action: 'removed', ref: `refs/pleiad/archive/${row.id}/x` }; },
    restore: async (row, ref) => { log.push(['restore', row.id, ref]); return true; },
    changed: () => { changed++; },
  };
  const left = createLeftovers(ops);
  assert.equal(left.section([]), null, '残りが無ければブロックを出さない');
  const rows = [
    { id: 'ply-7f3a', branch: 'pleiad/ply-7f3a', files: 3, at: Date.now() - 2 * 86400_000, kept: false, mergeSessionId: 's-parent', fileNames: ['core/auth.mjs', 'docs/auth.md', 'tests/auth-refresh.test.mjs'] },
    { id: 'ply-8b21', branch: 'pleiad/ply-8b21', files: 1, at: Date.now() - 3600_000, kept: true, mergeSessionId: null, fileNames: [] },
  ];
  let sec = left.section(rows);
  assert.equal(all(sec, 'git-sh')[0].querySelector('h3').textContent, '残っている作業場所'); assert.equal(all(sec, 'git-tot')[0].textContent, '2', '件数');
  let items = all(sec, 'wt-item');
  assert.equal(items.length, 2); assert.equal(items[0].dataset.state, 'idle'); assert.equal(items[1].dataset.state, 'keep', '残すにしてあるものは最初から「残します」');
  assert(items[0].querySelector('.wt-row').textContent.includes('pleiad/ply-7f3a') && items[0].querySelector('.wt-row').textContent.includes('3 ファイル'));
  assert.deepEqual(buttonsOf(items[0]).filter((b) => !b.className.includes('wt-row')).map((b) => b.textContent), ['エージェントに取り込みを頼む', '退避して消す', '残す']);
  assert(buttonsOf(items[0]).find((b) => b.textContent.includes('エージェントに取り込みを頼む')).className.includes('btn-primary'), '取り込みを頼むが塗り（主）');
  assert.deepEqual(all(sec, 'wt-safety')[0].children.map((li) => li.textContent), ['消す前に、中のリンクだけ外します。', '使っている会話やシェルがあるあいだは、消しません。'], '安全の要点 2 行');
  // 行を開くとファイル名
  items[0].querySelector('.wt-row').onclick();
  assert.equal(changed, 1);
  sec = left.section(rows); items = all(sec, 'wt-item');
  assert.deepEqual(all(items[0], 'wt-files')[0].children.map((li) => li.textContent), rows[0].fileNames, '開くとファイル名の一覧');
  t.ok('ブロック: 件数・行（ブランチ・ファイル数・いつ）・3 つの操作・安全の 2 行・開くとファイル名', true);

  // 取り込みを頼む → 結果の行・取り消す
  labelled(items[0], 'エージェントに取り込みを頼む').onclick();
  await tick(); await tick();
  sec = left.section(rows); items = all(sec, 'wt-item');
  assert.deepEqual(log.at(-1), ['ask', 'ply-7f3a']); assert.equal(items[0].dataset.state, 'ask');
  assert(items[0].querySelector('.wt-stat').textContent.includes('『更新まわりの不具合をまとめて直す』に頼みました。取り込まれたら自動で消えます。'));
  const undoAsk = labelled(items[0], '取り消す');
  assert(undoAsk && !undoAsk.hidden);
  undoAsk.onclick(); await tick(); await tick();
  sec = left.section(rows); items = all(sec, 'wt-item');
  assert.deepEqual(log.at(-1), ['unask', 'm1']); assert.equal(items[0].dataset.state, 'idle', '取り消せたら元の操作に戻る');
  // 取り込みを頼める会話が無い
  const noAsk = left.section([{ ...rows[0], id: 'ply-none', mergeSessionId: null }]);
  assert.equal(labelled(all(noAsk, 'wt-item')[0], 'エージェントに取り込みを頼む').disabled, true, '頼む相手が無ければ押せない');
  // 残す・戻す
  labelled(items[0], '残す').onclick(); await tick(); await tick();
  sec = left.section(rows); items = all(sec, 'wt-item');
  assert.deepEqual(log.at(-1), ['keep', 'ply-7f3a', true]); assert.equal(items[0].dataset.state, 'keep'); assert(items[0].querySelector('.wt-stat').textContent.includes('残します。'));
  labelled(items[0], '戻す').onclick(); await tick(); await tick();
  assert.deepEqual(log.at(-1), ['keep', 'ply-7f3a', false]);
  sec = left.section(rows); items = all(sec, 'wt-item');
  assert.equal(items[0].dataset.state, 'idle');
  // 退避して消す・元に戻す。消えた後も、元に戻す行は残る
  labelled(items[0], '退避して消す').onclick(); await tick(); await tick();
  const afterArchive = left.section([rows[1]]);
  const stash = all(afterArchive, 'wt-item').find((i) => i.dataset.state === 'stash');
  assert(stash && stash.querySelector('.wt-stat').textContent.includes('退避して消しました。'), '退避して消した後も、サーバーの一覧から消えた行を「元に戻す」付きで出す');
  assert.equal(all(afterArchive, 'git-tot')[0].textContent, '1', '件数は残っているものだけ');
  labelled(stash, '元に戻す').onclick(); await tick(); await tick();
  assert.deepEqual(log.at(-1), ['restore', 'ply-7f3a', 'refs/pleiad/archive/ply-7f3a/x']);
  assert.equal(all(left.section([rows[1]]), 'wt-item').length, 1, '元に戻したら退避の行は消える（作り直した作業場所は一覧に出る）');
  // 退避に失敗: 理由の行・操作は残す
  const fail = left.section([{ ...rows[0], id: 'ply-fail', fail: true }]);
  labelled(all(fail, 'wt-item')[0], '退避して消す').onclick(); await tick(); await tick();
  const failed = all(left.section([{ ...rows[0], id: 'ply-fail', fail: true }]), 'wt-item')[0];
  assert.equal(failed.dataset.state, 'fail'); assert(failed.querySelector('.wt-fail').textContent.includes('使っているものがあるので、消せません。'));
  assert.deepEqual(buttonsOf(failed).filter((b) => !b.className.includes('wt-row')).map((b) => b.textContent), ['エージェントに取り込みを頼む', '退避して消す', '残す'], '失敗しても操作は残す');
  left.reset();
  assert.equal(all(left.section([{ ...rows[0], id: 'ply-fail' }]), 'wt-item')[0].dataset.state, 'idle', 'reset で結果の行は消える');
  t.ok('操作: 取り込みを頼む（結果の行・取り消す・相手が無ければ押せない）・残す（戻す）・退避して消す（元に戻す・消えた後も行が残る・失敗は理由）', true);
  assert(!/style=/.test(sec.outerHTML), '色や style を直書きしない');
}
