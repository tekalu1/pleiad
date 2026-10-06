// 承認のカードの id（無停止の更新 2b-6。core/approval-id.mjs。docs/zero-downtime-update/stage2-server-state.md §3 の 5・A3）。
//   - ツールの id と会話の id が同じなら、別のプロセス（旧サーバーと新サーバー）でも同じ id
//   - 会話が違えば別の id（委譲の子の承認を祖先の会話へ中継する複製も、会話の id で別になる）
//   - ツールの id が無い承認は乱数
//   - 同じプロセスの 2 回目は乱数（カードの上書きと、通知の一覧の dedupeKey の重複を避ける）。覚える数には上限がある
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { approvalCardId, createApprovalIds } from '../../core/approval-id.mjs';

export const name = 'approval-id';
export const title = '承認のカードの id: ツールの id と会話の id から決まる値・2 回目と、ツールの id が無い承認は乱数';

const MODULE = new URL('../../core/approval-id.mjs', import.meta.url).href;
const SCRIPT = `import { createApprovalIds } from '${MODULE}'; process.stdout.write(createApprovalIds().next('s-1', 'toolu_01'));`;

export default async function (t) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  {
    const id = approvalCardId('s-1', 'toolu_01');
    assert.match(id, /^perm-[0-9a-f]{32}$/);
    assert.equal(approvalCardId('s-1', 'toolu_01'), id, '同じ入力は同じ値');
    assert.notEqual(approvalCardId('s-2', 'toolu_01'), id, '会話が違えば別の値');
    assert.notEqual(approvalCardId('s-1', 'toolu_02'), id, 'ツールの id が違えば別の値');
    // 別のプロセス（旧サーバーと新サーバー）の 1 回目は同じ値
    const other = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { encoding: 'utf8' });
    assert.equal(other.status, 0, other.stderr);
    assert.equal(createApprovalIds().next('s-1', 'toolu_01'), id);
    assert.equal(other.stdout, id, '別のプロセスの 1 回目も同じ値');
    t.ok('ツールの id と会話の id から決まる値（別のプロセスでも同じ・会話やツールが違えば別）', true);
  }
  {
    const ids = createApprovalIds();
    for (const toolUseID of [undefined, null, '']) assert.match(ids.next('s-1', toolUseID), UUID, `ツールの id が ${JSON.stringify(toolUseID)} なら乱数`);
    assert.notEqual(ids.next('s-1', null), ids.next('s-1', null), '乱数は毎回別');
    t.ok('ツールの id が無い承認は乱数', true);
  }
  {
    const ids = createApprovalIds();
    const first = ids.next('s-1', 'toolu_01');
    assert.equal(first, approvalCardId('s-1', 'toolu_01'));
    assert.match(ids.next('s-1', 'toolu_01'), UUID, '同じプロセスの 2 回目は乱数');
    assert.equal(ids.next('s-2', 'toolu_01'), approvalCardId('s-2', 'toolu_01'), '会話が違えば 1 回目');
    t.ok('同じプロセスで同じ承認が 2 回求められたら、2 回目は乱数（カードの上書きと通知の一覧の重複を避ける）', true);
  }
  {
    const ids = createApprovalIds({ max: 3 });
    for (const n of [1, 2, 3, 4]) ids.next('s', `t${n}`);
    assert.match(ids.next('s', 't3'), UUID, '覚えている間は乱数');
    assert.equal(ids.next('s', 't1'), approvalCardId('s', 't1'), '古いものは忘れる（上限）');
    t.ok('覚える数には上限がある', true);
  }
}
