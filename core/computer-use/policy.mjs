// アプリの承認の判定（docs/computer-use.md「判定の順」、ADR 0071）。純粋な関数だけ。
import { scopeRank, autonomyRank } from '../modes.mjs';
import { isForbiddenApp, isHighRiskApp } from './apps.mjs';
import { computerUsePrefs } from '../../web/computer-prefs.mjs';

/**
 * prefs.computerUse を、足りない項目を既定で埋めた形にする。形が崩れていても落とさない。
 * 設定の画面と同じ検査（web/computer-prefs.mjs）を通す。常に許可の 1 行は { id, name, kind } が揃ったものだけ読む
 */
export const normalizeComputerUse = value => computerUsePrefs({ computerUse: value });

/** 会話の承認モードが確認なし（範囲 full かつ 自律 never）か。modePosition の形（{ scope, autonomy }）を受ける */
export const isUnattendedMode = mode => Boolean(mode) && scopeRank(mode.scope) >= scopeRank('full') && autonomyRank(mode.autonomy) >= autonomyRank('never');

/**
 * アプリを操作してよいかを決める。
 * 'allow' 聞かずに許可 / 'ask' 承認カードを出す / 'ask-high' 警告付きで出す / 'forbidden' 禁止（カードは出さない）/ 'denied' このターンで拒否済み。
 * 順: 禁止 > このターンの拒否 > 確認なし（Antigravity は常に）> すべて許可 > 常に許可・この会話で許可 > 聞く。
 * `enabled: false` の会話には MCP を渡さないので、ここでは見ない（橋が unsupported で返す）
 */
export function decideApp({ app, prefs, sessionApps = [], deniedThisTurn = new Set(), mode, agent } = {}) {
  if (!app || isForbiddenApp(app)) return 'forbidden';
  if (deniedThisTurn.has?.(app.id)) return 'denied';
  // Antigravity は承認モードが yolo しか無いので、アプリの承認も聞かない（2026-10-01 に決めた）
  if (agent === 'antigravity' || isUnattendedMode(mode)) return 'allow';
  const cu = normalizeComputerUse(prefs?.computerUse ?? prefs);
  if (cu.allowAllApps) return 'allow';
  const ids = new Set(sessionApps);
  if (ids.has(app.id) || cu.alwaysAllowed.some(a => a.id === app.id)) return 'allow';
  return isHighRiskApp(app) ? 'ask-high' : 'ask';
}

/** 確認なし（bypass）かすべて許可で、聞かずに通した判定か。印の行の grant（'bypass' | 'all'）に使う。それ以外は null */
export function autoGrantKind({ prefs, mode, agent, app, sessionApps = [] } = {}) {
  if (agent === 'antigravity' || isUnattendedMode(mode)) return 'bypass';
  const cu = normalizeComputerUse(prefs?.computerUse ?? prefs);
  if (!cu.allowAllApps) return null;
  const ids = new Set(sessionApps);
  if (ids.has(app?.id) || cu.alwaysAllowed.some(a => a.id === app?.id)) return null;
  return 'all';
}
