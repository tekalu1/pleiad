// 承認モードの軸（core/modes.mjs）の解決規則を表で固定する。
// ここが崩れると、委譲した子が親より強い権限で黙って動く。
import assert from 'node:assert/strict';
import { canDelegate, modePosition, resolveDelegatedMode } from '../../core/modes.mjs';
import { backend as claude } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { backend as antigravity } from '../../core/backends/antigravity.mjs';

export const name = 'modes';
export const title = '承認モードの2軸と、委譲したときの強さの引き継ぎ';

const BACKENDS = { claude, codex, antigravity };
const resolve = (parent, parentMode, childId) => resolveDelegatedMode({
  parentMode, parentModes: BACKENDS[parent].modes(), childModes: BACKENDS[childId].modes(),
});

// [親, 親のモード, 子, 期待する子のモード, escalation]
const TABLE = [
  ['codex',  'full',    'claude',      'auto',      false],   // never は claude に無いので judge まで
  ['claude', 'auto',    'codex',       'auto',      false],
  ['claude', 'default', 'codex',       'ask',       false],
  ['codex',  'ask',     'antigravity', 'yolo',      true],    // yolo しか無く、上限を超える
  ['codex',  'yolo',    'antigravity', 'yolo',      false],   // 親が無制限なら超えない
  ['claude', 'default', 'claude',      'default',   false],
];

export default async function (t) {
  for (const [parent, parentMode, childId, mode, escalation] of TABLE) {
    const got = resolve(parent, parentMode, childId);
    t.ok(`${parent}/${parentMode} → ${childId} は ${mode}${escalation ? '（1回聞く）' : ''}`,
      got.mode === mode && got.escalation === escalation, `${got.mode} / escalation=${got.escalation} / ${got.reason}`);
  }

  const readonlyParents = [['claude', 'plan'], ['codex', 'readonly']];
  for (const [id, mode] of readonlyParents)
    t.ok(`${id}/${mode} からは委譲させない`, !canDelegate(BACKENDS[id].modes()[mode]));
  t.ok('触れる範囲を持つ親からは委譲できる', canDelegate(claude.modes().default) && canDelegate(codex.modes().yolo));

  // 知らないモード名・軸の宣言が無いモードでも落ちない。既定は弱い側（workspace / ask）。
  assert.deepEqual(modePosition(undefined), { scope: 'workspace', autonomy: 'ask', enforced: false });
  assert.deepEqual(modePosition({ label: 'x', scope: 'galaxy', autonomy: 'whenever' }), { scope: 'workspace', autonomy: 'ask', enforced: false });
  const unknownParent = resolveDelegatedMode({ parentMode: 'まだ無いモード', parentModes: claude.modes(), childModes: codex.modes() });
  t.ok('知らない親のモードは弱い側として扱う', unknownParent.mode === 'ask' && unknownParent.escalation === false, unknownParent.mode);
  const bare = resolveDelegatedMode({ parentMode: 'a', parentModes: { a: { label: '軸なし' } }, childModes: { x: { label: '軸なし' }, y: { label: '軸なし' } } });
  t.ok('軸の宣言が無い同士でも決まる', bare.mode === 'x' && bare.escalation === false, bare.mode);
  const empty = resolveDelegatedMode({ parentMode: 'default', parentModes: claude.modes(), childModes: {} });
  t.ok('モードを持たない相手でも落ちない', empty.mode === null && empty.escalation === false);
  t.ok('引数が欠けても落ちない', resolveDelegatedMode({}).mode === null);
}
