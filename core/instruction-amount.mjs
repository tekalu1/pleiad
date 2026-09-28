// 毎ターン最初に読み込まれる指示のうち、Pleiad が足した文の量（ADR 0056「① 量を見せる」、docs/design.md「指示の量」）。
// 会話の右パネルの「指示の量」の面が、自分で書いた指示（記録の行の tokens）と並べて出す。
// 数えるのは、このターンで実際にエージェントへ渡した文だけ。数え方は画面と同じ estimateTokens（実際のトークナイザーではない）
import { estimateTokens } from '../web/token-estimate.mjs';

/** 内訳の並び（画面の並び）。Visualize の説明・Skills の一覧・委譲ツールの説明・Pleiad の指示・コンテキストの案内・ブラウザーの説明 */
export const PLY_PARTS = ['visualize', 'skills', 'agents', 'added', 'guide', 'browser'];

/**
 * 渡し方はバックエンドで違う（core/backends/*.mjs の runTurn）:
 *   - ply_agents を受け取るもの（capabilities.plyAgents。Claude・Codex）: 指示欄に ply_context の prompt・Visualize の説明・ブラウザーの説明・
 *     ply_agents の instructions（その後ろに Pleiad の指示）
 *   - 受け取らないもの（antigravity）: ply_context の prompt・ブラウザーの説明・Pleiad の指示だけ。Visualize と ply_agents は渡さない
 * context は ply_context の内訳（contextTools の sections。ply_context を開かないターンは null）、agents は Pleiad の指示を足す前の
 * ply_agents の instructions、added は Pleiad の指示の記録（入れた項目だけ text がある）。
 * 戻り: [{ id, tokens }]。渡さなかった（0 の）ものは載せない
 */
export function plyParts({ plyAgents = false, context = null, visualize = null, browser = null, agents = null, added = null } = {}) {
  const text = {
    visualize: plyAgents ? visualize : null,
    skills: context?.skills,
    agents: plyAgents ? agents : null,
    added: (added ?? []).map(a => a?.text).filter(Boolean).join('\n\n'),
    guide: context?.guide,
    browser,
  };
  return PLY_PARTS.map(id => ({ id, tokens: estimateTokens(text[id]) })).filter(p => p.tokens > 0);
}
