// 操作の権限（core/ops/policy.mjs）を、主体 × 危険度 × 会話の承認モードの全組み合わせで表に固定する（ADR 0081）。
// ここが崩れると、AI が自分の関所を黙って緩められる・人間が自分の画面で断られる。
import { decide, visibleTo, maxRisk, RISKS } from '../../core/ops/policy.mjs';
import { SCOPES, AUTONOMIES } from '../../core/modes.mjs';
import { backend as claude } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { backend as antigravity } from '../../core/backends/antigravity.mjs';

export const name = 'ops-policy';
export const title = '操作の権限の表: 主体 × 危険度 × 会話の承認モード';

// 期待は [read, write, guarded, human-only]。a=allow  k=ask  d=deny  h=hidden。コードの形（scope の比較など）から導かず、表で書く
const E = { a: 'allow', k: 'ask', d: 'deny', h: 'hidden' };

// 会話に束縛された agent。軸 12 通り（scope × autonomy。none / readonly × never は実在しないが、表では埋める）
const ROWS = {
  // scope が none / readonly: 読めるが、write も guarded も断る（READ_ONLY_MODE）
  'none/ask': 'addh', 'none/judge': 'addh', 'none/never': 'addh',
  'readonly/ask': 'addh', 'readonly/judge': 'addh', 'readonly/never': 'addh',
  // workspace: write は通す。guarded は、ask・judge・（sandbox で workspace に閉じた）never のどれも承認カード
  'workspace/ask': 'aakh', 'workspace/judge': 'aakh', 'workspace/never': 'aakh',
  // full: ask・judge は承認カード。never（bypass・yolo）だけ通す
  'full/ask': 'aakh', 'full/judge': 'aakh', 'full/never': 'aaah',
};

const codes = (verdict) => `${verdict.decision}${verdict.code ? `:${verdict.code}` : ''}`;

export default async function (t) {
  const axes = SCOPES.flatMap((scope) => AUTONOMIES.map((autonomy) => `${scope}/${autonomy}`));
  t.ok('表が軸の全組み合わせを持つ', axes.length === 12 && axes.every((a) => ROWS[a]) && Object.keys(ROWS).length === 12);

  // 人間は全部通す
  for (const risk of RISKS) t.ok(`human × ${risk} は allow`, decide({ by: 'human' }, risk).decision === 'allow');

  // 会話に束縛された agent
  for (const [axis, row] of Object.entries(ROWS)) {
    const [scope, autonomy] = axis.split('/');
    RISKS.forEach((risk, i) => {
      const got = decide({ by: 'agent', sessionId: 's1', mode: { scope, autonomy } }, risk);
      t.ok(`agent（会話あり・${axis}）× ${risk} は ${E[row[i]]}`, got.decision === E[row[i]], codes(got));
    });
  }

  // 断る理由のコード。画面と CLI はコードで見分ける
  const bound = (scope, autonomy) => ({ by: 'agent', sessionId: 's1', mode: { scope, autonomy } });
  t.ok('plan の会話の write は READ_ONLY_MODE', decide(bound('none', 'ask'), 'write').code === 'READ_ONLY_MODE');
  t.ok('readonly の会話の guarded は READ_ONLY_MODE', decide(bound('readonly', 'judge'), 'guarded').code === 'READ_ONLY_MODE');
  t.ok('modeGate: false の write は読み取りの会話でも通す', decide(bound('none', 'ask'), 'write', { modeGate: false }).decision === 'allow');
  t.ok('modeGate: false でも guarded は読み取りの会話から通さない', decide(bound('none', 'ask'), 'guarded', { modeGate: false }).code === 'READ_ONLY_MODE');
  t.ok('通した guarded には理由が付く（記録に残す）', decide(bound('full', 'never'), 'guarded').reason === 'mode-never-full');

  // 会話に束縛されていない agent（外のターミナルの CLI・外の AI の pleiad mcp）。mode があっても見ない
  const unbound = [{ by: 'agent' }, { by: 'agent', sessionId: null }, { by: 'agent', sessionId: '' }, { by: 'agent', mode: { scope: 'full', autonomy: 'never' } }];
  unbound.forEach((p, i) => {
    const got = RISKS.map((risk) => codes(decide(p, risk)));
    t.ok(`会話なしの agent（${i}）: read・write は通し、guarded は NEEDS_UI、human-only は出さない`,
      got.join(' ') === 'allow allow deny:NEEDS_UI hidden', got.join(' '));
  });

  // 会話に束縛されているが、承認モードを引けない（モード名が不明・会話が消えた）→ 弱い側（workspace・ask）に倒す
  for (const mode of [undefined, null, {}, { scope: 'bogus', autonomy: 'bogus' }]) {
    const got = decide({ by: 'agent', sessionId: 's1', mode }, 'guarded');
    t.ok(`モードが引けない会話の guarded は ask（${JSON.stringify(mode)}）`, got.decision === 'ask');
  }

  // 実在するバックエンドのモード（宣言）を通した確認。表の行と同じ結果になる
  const REAL = [
    [claude, 'default', 'ask'], [claude, 'auto', 'ask'], [claude, 'acceptEdits', 'ask'], [claude, 'plan', 'deny'], [claude, 'bypass', 'allow'],
    [codex, 'ask', 'ask'], [codex, 'auto', 'ask'], [codex, 'full', 'ask'], [codex, 'yolo', 'allow'], [codex, 'readonly', 'deny'],
  ];
  for (const [b, mode, want] of REAL) {
    const got = decide({ by: 'agent', sessionId: 's1', mode: b.modes()[mode] }, 'guarded');
    t.ok(`${b.id}/${mode} の会話の guarded は ${want}`, got.decision === want, codes(got));
  }
  const agyFull = Object.entries(antigravity.modes()).filter(([, m]) => m.scope === 'full' && m.autonomy === 'never');
  for (const [mode] of agyFull) t.ok(`antigravity/${mode}（full・never）の会話の guarded は allow`, decide({ by: 'agent', sessionId: 's1', mode: antigravity.modes()[mode] }, 'guarded').decision === 'allow');

  // 一覧に出すか: human-only だけが agent から見えない
  t.ok('human-only は agent の一覧に出ない', !visibleTo({ by: 'agent', sessionId: 's1', mode: { scope: 'full', autonomy: 'never' } }, 'human-only') && !visibleTo({ by: 'agent' }, 'human-only'));
  t.ok('それ以外は agent にも見える（通すかどうかは別）', ['read', 'write', 'guarded'].every((r) => visibleTo({ by: 'agent' }, r)));
  t.ok('human には human-only も見える', visibleTo({ by: 'human' }, 'human-only'));

  // 不明な入力は通さない
  t.ok('不明な主体は deny', decide({ by: 'cli' }, 'read').decision === 'deny' && decide(undefined, 'read').decision === 'deny');
  t.ok('不明な危険度は deny', decide({ by: 'human' }, 'admin').decision === 'deny');

  // riskOf は定義の risk より下げない
  t.ok('maxRisk は高い方', maxRisk('write', 'guarded') === 'guarded' && maxRisk('guarded', 'write') === 'guarded' && maxRisk('read', 'read') === 'read');
}
