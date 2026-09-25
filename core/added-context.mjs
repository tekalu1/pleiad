// Pleiad が入れる既定のコンテキスト（docs/context-runtime.md「Pleiad が入れる指示」、ADR 0023）。今は委譲の指示 1 つ。
// 指示ファイル・Skills・外部 MCP の担当（ADR 0014）によらず、ply_agents を持つ会話へ毎ターン渡す（core/server.mjs の runTurn が
// ply_agents の instructions の後ろに足し、Claude は append、Codex は developerInstructions で受け取る）。文面の元は辞書だけ。
// 中身は会話ごとに機械的に決める: 依頼元の会話には 1〜3（委譲先の自動選択が無効なら 3 を除く）、委譲された子の会話には
// 「さらに委譲しない」だけ。入れるかどうかは prefs.json の addedContext（既定で入れる）。
import { agentT } from './i18n.mjs';

export const ADDED_ITEMS = ['delegation'];

/** 保存の形 { delegation: boolean }。無い・壊れた値は既定（入れる） */
export function normalizeAddedContext(raw) {
  return { delegation: raw?.delegation !== false };
}

/** 依頼元の会話に入れる文。routing は委譲先の自動選択が有効か */
export function delegationParentText(locale, { routing = true } = {}) {
  const lines = [agentT(locale, 'guide.lead'), `- ${agentT(locale, 'guide.delegate')}`, `- ${agentT(locale, 'guide.main')}`];
  if (routing) lines.push(`- ${agentT(locale, 'guide.route')}`);
  return lines.join('\n');
}
/** 委譲された子の会話に入れる文 */
export const delegationChildText = locale => agentT(locale, 'guide.child');

/**
 * このターンに入れる委譲の指示。ply_agents を持たないバックエンド（antigravity）では null（記録もしない）。
 * 入れないときは variant: null と理由（off: 設定で切った / readOnly: 読み取り・計画モードで委譲できない）。
 * 子の会話は読み取りのモードでも「さらに委譲しない」を入れる（害が無く、委譲できないことと食い違わない）
 */
export function delegationGuide({ locale, enabled, child, routing, supported, canDelegate }) {
  if (!supported) return null;
  if (!enabled) return { id: 'delegation', variant: null, reason: 'off' };
  if (child) return { id: 'delegation', variant: 'child', text: delegationChildText(locale) };
  if (!canDelegate) return { id: 'delegation', variant: null, reason: 'readOnly' };
  return { id: 'delegation', variant: routing ? 'parent' : 'parentManual', text: delegationParentText(locale, { routing }) };
}

/** ply_agents の instructions の後ろに足す。入れないときは元のまま（同じバイト列にしてプロンプトのキャッシュを外さない） */
export function withAdded(instructions, items) {
  const texts = (items ?? []).map(i => i?.text).filter(Boolean);
  return texts.length ? [instructions, ...texts].filter(Boolean).join('\n\n') : instructions;
}
