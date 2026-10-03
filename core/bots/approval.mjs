// 承認モードの強さの比べ方（bot が別の bot を起こすときの確認。ADR 0109）。範囲（scope）・自律（autonomy）のどちらかが上なら強い。
// modes() の 1 エントリ（core/modes.mjs の宣言）を渡す。宣言が無いものは弱い側に倒す（modePosition）。
import { modePosition, scopeRank, autonomyRank } from '../modes.mjs';

/** target の承認モードが subject より強いか。どちらかの軸が上なら真（片方が下でも、上の軸があれば強い） */
export function strongerMode(target, subject) {
  const t = modePosition(target), s = modePosition(subject);
  return scopeRank(t.scope) > scopeRank(s.scope) || autonomyRank(t.autonomy) > autonomyRank(s.autonomy);
}

/** 作業場所に書けて毎回聞く（既定の弱いモード）より強いか。新しい bot の承認カードの「弱くない」の判定 */
export const looserThanDefault = (entry) => strongerMode(entry, { scope: 'workspace', autonomy: 'ask' });
