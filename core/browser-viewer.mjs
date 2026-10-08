import { previewPolicy } from '../web/browser-confirm-policy.mjs';
import { cleanTabState } from './agent-browser.mjs';

/**
 * main への口 port の上の、内蔵ブラウザー（ビューア）の橋（サーバー側）。エージェントの操作は無く、人が見るための物だけを運ぶ。
 *   - 読み込みの方針: 外部の読み込みの前に確認と、常に許可した https の出どころ（main が内蔵ブラウザーの file: のタブで止める。ADR 0079）
 *   - タブの写し: main が報告した内蔵ブラウザーのタブを持ち、付け直した main（無停止の更新）が browser-restore-request で引く
 */
export function parentPortViewer(port) {
  if (!port) return null;
  let tabState = { tabs: [] };
  let policyMessage = { type: 'browser-load-policy', confirm: false, origins: [] };
  port.on('message', event => {
    const message = event?.data ?? event;
    if (message?.type === 'browser-load-policy-request') { port.postMessage(policyMessage); return; }
    if (message?.type === 'browser-state-report') { tabState = cleanTabState(message); return; }
    if (message?.type === 'browser-restore-request') port.postMessage({ type: 'browser-restore', ...tabState, relay: null });
  });
  return {
    loadPolicy(prefs) {
      const { confirm, origins } = previewPolicy(prefs);
      policyMessage = { type: 'browser-load-policy', confirm, origins };
      port.postMessage(policyMessage);
    },
  };
}
