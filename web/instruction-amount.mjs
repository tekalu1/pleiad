// 「指示の量」の数（会話の右パネル。ADR 0056「① 量を見せる」、docs/design.md「指示の量」）。DOM を使わない。
// 自分で書いた指示（ユーザー／この場所と親フォルダー）と Pleiad が足した分を合わせ、目安は自分で書いた分にだけ当てる。
// 目安の値は prefs.json の instructionBudget（設定 › プラグインの「指示」。サーバーも同じ範囲で確かめる）

export const DEFAULT_BUDGET = 5000;
export const MIN_BUDGET = 100;
export const MAX_BUDGET = 1_000_000;
/** 保存した目安。無い・壊れているときは既定 */
export const budgetOf = prefs => {
  const v = prefs?.instructionBudget;
  return Number.isInteger(v) && v >= MIN_BUDGET && v <= MAX_BUDGET ? v : DEFAULT_BUDGET;
};
/** 行の出どころ。足した場所で見つかったものは、足した段（ユーザー／作業場所）の側に数える */
export const sideOf = row => (row.scope ?? row.origins?.[0]?.scope) === 'user' ? 'user' : 'dir';

/**
 * rows: 自分で書いた指示の行（{ scope, tokens }）。parts: Pleiad が足した分（[{ id, tokens }]。core/instruction-amount.mjs）。
 * 戻り: { user, dir, own, ply, total, budget, scale, ratio }
 *   scale は棒の全長に当てる数（合計か目安の大きい方。目安の線が棒の中に収まる）
 *   ratio は自分で書いた分が目安の何倍か（超えていなければ 0。小数 1 桁、超えていれば 1.1 以上）
 */
export function instructionAmount({ rows = [], parts = [], budget = DEFAULT_BUDGET } = {}) {
  let user = 0, dir = 0;
  for (const row of rows) {
    const n = Number(row?.tokens) || 0;
    if (sideOf(row) === 'user') user += n; else dir += n;
  }
  const ply = (parts ?? []).reduce((n, p) => n + (Number(p?.tokens) || 0), 0);
  const own = user + dir, total = own + ply;
  const ratio = own > budget ? Math.max(1.1, Math.round(own / budget * 10) / 10) : 0;
  return { user, dir, own, ply, total, budget, scale: Math.max(total, budget), ratio };
}
