// worktree の画面の部品（web/worktree-ui.mjs。ADR 0089）を最小の DOM で見る。
// 別の会話の書き込みの知らせ・会話の中の静かな 1 行の状態（here / backing / back）・
// 右パネルの「残っている worktree」（取り込みを頼む・退避して消す・残す・取り消し・元に戻す）・取り込みの依頼文。
import assert from 'node:assert/strict';
import { shortPath, whoText, askText, busyPlan, renderWorktreeLine, paintWorktreeLine, setWorktreeLineMode, createLeftovers } from '../../web/worktree-ui.mjs';

export const name = 'worktree-view';
export const title = 'worktree の画面: 競合の知らせ・会話の中の静かな 1 行・残っている worktree の操作と結果の行・取り込みの依頼文';

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

  // ---- 衝突の知らせ（自動作成はしない）
  const conflict = { git: true, canSplit: true, conflicts: [{ title: 'リリースノートの下書き' }] };
  assert.deepEqual(busyPlan(conflict), { who: '「リリースノートの下書き」' });
  assert.deepEqual(busyPlan({ ...conflict, conflicts: [{ title: 'A' }, { title: 'B' }] }), { who: '「A」ほか 1 件' });
  assert.equal(busyPlan({ ...conflict, conflicts: [] }), null);
  assert.equal(busyPlan({ ...conflict, canSplit: false }), null);
  assert.equal(busyPlan(conflict, { running: true }), null);
  assert.equal(busyPlan(null), null);
  t.ok('衝突は worktree を作れる場所で別の会話が書き込み中のときだけ知らせる', true);

  // ---- 会話の中の静かな 1 行
  const ev = { kind: 'worktree', worktree: { id: 'ply-7f3a', branch: 'pleiad/ply-7f3a', path: 'D:/dev/pleiad.pleiad/ply-7f3a', origin: 'D:/dev/pleiad', conflicts: ['リリースノートの下書き'], count: 1 } };
  let modeNow = 'here';
  setWorktreeLineMode(() => modeNow);
  const line = renderWorktreeLine(ev);
  assert.equal(line.className, 'wt-line'); assert.equal(line.dataset.worktreeId, 'ply-7f3a');
  assert.equal(line.querySelector('.wt-line-t').textContent, 'worktree で始めました（「リリースノートの下書き」が作業中）');
  const lineBtn = line.querySelector('button');
  assert.equal(lineBtn.textContent, '元の場所に戻す');
  let acted = null;
  line.addEventListener('ply-worktree', (e) => { acted = e.detail; });
  lineBtn.onclick();
  assert.equal(acted?.act, 'back'); assert.equal(acted?.note.origin, 'D:/dev/pleiad');
  paintWorktreeLine(line, 'backing');
  assert.equal(line.querySelector('.wt-line-t').textContent, '次のターンから元の場所に戻します'); assert.equal(lineBtn.textContent, 'もう一度 worktree で始める');
  acted = null; lineBtn.onclick(); assert.equal(acted?.act, 'again', '戻す前（backing）の「もう一度 worktree で始める」は again');
  paintWorktreeLine(line, 'back');
  assert.equal(line.querySelector('.wt-line-t').textContent, '元の場所に戻しました'); assert.equal(lineBtn.textContent, 'もう一度 worktree で始める');
  modeNow = 'back';
  assert.equal(renderWorktreeLine(ev).dataset.mode, 'back', '初めの状態は client が決める（cwd と予約から）');
  const many = renderWorktreeLine({ worktree: { id: 'x', conflicts: ['A'], count: 3 } });
  modeNow = 'here'; paintWorktreeLine(many, 'here');
  assert.equal(many.querySelector('.wt-line-t').textContent, 'worktree で始めました（「A」ほか 2 件が作業中）', '件数が題より多いときは、ほか N 件');
  paintWorktreeLine(renderWorktreeLine({ worktree: { id: 'y', conflicts: [], count: 0 } }), 'here');
  assert.equal(renderWorktreeLine({ worktree: { id: 'y' } }).querySelector('.wt-line-t').textContent, 'worktree で始めました');
  assert.equal(renderWorktreeLine({}).className, 'wt-line', '印が無ければ空の枠');
  t.ok('会話の中の行: 始めた文・here / backing / back の文とボタン・押すと ply-worktree（back / again）・題が無い・件数が多い', true);

  // ---- 取り込みの依頼文
  assert.equal(askText({ branch: 'pleiad/ply-7f3a', path: 'D:/dev/pleiad.pleiad/ply-7f3a', origin: 'D:/dev/pleiad', baseBranch: 'main' }),
    'worktree pleiad/ply-7f3a（D:/dev/pleiad.pleiad/ply-7f3a）の変更を、元の作業場所（D:/dev/pleiad）のブランチ main に取り込んでください。競合があれば解いてください。取り込めたら、worktree は Pleiad が片付けます。');
  assert(askText({ branch: 'b', path: 'p', origin: 'o', baseBranch: null }).includes('の元のブランチに取り込んでください'));
  t.ok('取り込みの依頼文: ブランチ・場所・元の場所・取り込み先（無ければ元のブランチ）・競合は解く・片付けは Pleiad', true);

  // ---- git パネルの worktree 行を開いた中の操作
  let changed = 0;
  const log = [];
  const ops = {
    keep: async (id, kept) => { log.push(['keep', id, kept]); },
    ask: async (row) => { log.push(['ask', row.id]); return row.mergeSessionId ? { title: '更新まわりの不具合をまとめて直す', messageId: 'm1', sessionId: row.mergeSessionId } : null; },
    unask: async (sent) => { log.push(['unask', sent.messageId]); return true; },
    archive: async (row) => { log.push(['archive', row.id]); return row.fail ? { action: 'failed', why: 'busy' } : { action: 'removed', ref: `refs/pleiad/archive/${row.id}/x` }; },
    restore: async (row, ref) => { log.push(['restore', row.id, ref]); return true; },
    changed: () => { changed++; },
  };
  const left = createLeftovers(ops);
  const row = { id: 'ply-7f3a', branch: 'pleiad/ply-7f3a', mergeSessionId: 's-parent' };
  let item = left.actions(row);
  assert.deepEqual(buttonsOf(item).map((b) => b.textContent), ['エージェントに取り込みを頼む', '退避して消す', '残す']);
  labelled(item, 'エージェントに取り込みを頼む').onclick(); await tick(); await tick();
  item = left.actions(row);
  assert.equal(item.dataset.state, 'ask');
  labelled(item, '取り消す').onclick(); await tick(); await tick();
  assert.equal(left.actions(row).dataset.state, 'idle');
  assert.equal(labelled(left.actions({ ...row, id: 'none', mergeSessionId: null }), 'エージェントに取り込みを頼む').disabled, true);
  labelled(left.actions(row), '残す').onclick(); await tick(); await tick();
  item = left.actions(row); assert.equal(item.dataset.state, 'keep');
  labelled(item, '戻す').onclick(); await tick(); await tick();
  assert.equal(left.actions(row).dataset.state, 'idle');
  labelled(left.actions(row), '退避して消す').onclick(); await tick(); await tick();
  item = left.actions(row); assert.equal(item.dataset.state, 'stash');
  labelled(item, '元に戻す').onclick(); await tick(); await tick();
  assert.equal(left.actions(row).dataset.state, 'idle');
  const failing = { ...row, id: 'failed', fail: true };
  labelled(left.actions(failing), '退避して消す').onclick(); await tick(); await tick();
  assert.equal(left.actions(failing).dataset.state, 'fail');
  left.reset();
  assert.equal(left.actions(failing).dataset.state, 'idle');
  t.ok('git パネルの worktree 行: 取り込み・残す・退避と戻し・失敗・無効の状態', changed > 0 && log.length > 0);

}
