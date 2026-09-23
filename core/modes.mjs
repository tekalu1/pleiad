// 承認モードを「2つの軸」で表す。
//
// バックエンドごとのモード名（claude の acceptEdits、codex の yolo …）は
// 互いに比較できないので、総当たりの対応表を書くと**エージェントが増えるたびに表が増える**。
// そこで各バックエンドは自分のモードに軸の値だけを宣言し、強さの比較と委任の規則はここに集める。
// エージェントを足すときに触るのは core/backends/<id>.mjs の MODES だけになる。
//
//   範囲 (scope)     どこまで触れるか。none < readonly < workspace < full
//   自律 (autonomy)  人にどれだけ聞くか。ask < judge < never
//   強制 (enforced)  その範囲を sandbox 等で機械的に強制できるか（できないなら「約束」にすぎない）
//
// すべて純関数。server / store には依存させない（テストから表で叩けるようにするため）。

export const SCOPES = ['none', 'readonly', 'workspace', 'full'];
export const AUTONOMIES = ['ask', 'judge', 'never'];

// 宣言が無い（古い形の）モードの既定。**弱い側に倒す**。
// 知らないものを強いと見なすと、宣言を書き忘れたモードが黙って権限を広げてしまう。
const FALLBACK = { scope: 'workspace', autonomy: 'ask' };

export const scopeRank = (scope) => SCOPES.indexOf(scope);
export const autonomyRank = (autonomy) => AUTONOMIES.indexOf(autonomy);

/** modes() の 1 エントリから軸の位置を取り出す。未宣言・不明な値は既定へ落とす。 */
export function modePosition(entry) {
  return {
    scope: SCOPES.includes(entry?.scope) ? entry.scope : FALLBACK.scope,
    autonomy: AUTONOMIES.includes(entry?.autonomy) ? entry.autonomy : FALLBACK.autonomy,
    enforced: entry?.enforced === true,
  };
}

/**
 * 強さの比較。範囲を先に見て、同じなら自律で比べる。
 *
 * どちらが強いとも言えない組み合わせ（作業ディレクトリ・毎回聞く と
 * 読むだけ・迷ったら聞く）では、**範囲を保ったまま自律だけ下げる**。
 * 自律を優先すると子が読むだけになり、書き込みを含む依頼がそもそも果たせない。
 * 承認待ちで止まるのは人間が気づいて解ける（子の会話で承認する）が、範囲が足りないのは解けない。
 */
const compare = (a, b) => (scopeRank(a.scope) - scopeRank(b.scope)) || (autonomyRank(a.autonomy) - autonomyRank(b.autonomy));

/**
 * この位置の親から子タスクを始めてよいか。
 * 範囲が none / readonly の親は、自分では触れないものを子に触らせることになるので断る
 * （異なるエンジンの子による権限の拡大を防ぐ）。
 */
export function canDelegate(entry) {
  return scopeRank(modePosition(entry).scope) > scopeRank('readonly');
}

/**
 * 委任先の承認モードを決める。「親の強さまでは継ぐ、それを超えない」。
 *
 * @param parentMode  親のモード id
 * @param parentModes 親のバックエンドの modes()
 * @param childModes  委任先のバックエンドの modes()
 * @returns { mode, escalation, reason } escalation が true なら、委任した瞬間に1回だけ親の会話で聞く
 */
export function resolveDelegatedMode({ parentMode, parentModes, childModes }) {
  const entries = Object.entries(childModes ?? {}).map(([id, entry]) => [id, modePosition(entry)]);
  if (!entries.length) return { mode: null, escalation: false, reason: 'no-modes' };

  const limit = modePosition((parentModes ?? {})[parentMode]);
  const within = entries.filter(([, p]) => scopeRank(p.scope) <= scopeRank(limit.scope) && autonomyRank(p.autonomy) <= autonomyRank(limit.autonomy));

  // 上限に収まるものが1つも無い。いちばん弱いものを選び、その1回だけ人に聞く
  // （コマンドごとに聞かれるのとは負担が違う）。
  if (!within.length) return { mode: [...entries].sort(([, a], [, b]) => compare(a, b))[0][0], escalation: true, reason: 'over-limit' };

  // 収まるものの中でいちばん強いものを継ぐ。同じ強さなら先に宣言されたほう
  // （＝そのエージェントが既定に近いものとして並べた側）。sort は安定なのでそれで決まる。
  const [mode, position] = [...within].sort(([, a], [, b]) => compare(b, a))[0];

  // 範囲を機械的に強制できないエンジンに「誰にも聞かずに動く」を渡すと、
  // 宣言した範囲を超えても誰も気づけない。親自身が無制限でない限りは聞く。
  if (position.autonomy === 'never' && !position.enforced && scopeRank(limit.scope) < scopeRank('full'))
    return { mode, escalation: true, reason: 'unenforced-never' };

  return { mode, escalation: false, reason: 'within-limit' };
}
