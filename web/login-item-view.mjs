// サインイン時の起動（設定 › リモート › 常駐。ADR 0175）の表示の決め方。state は preload の plyDesktop.loginItem.get() の戻り
// （OS の登録を読み直した { supported, reason?, enabled, blocked }）。DOM は web/remote.mjs が持つ。

/**
 * @param state       { supported, enabled, blocked } か、読めていないとき null / undefined
 * @param remoteEnabled リモートの受付（ホスト）がオンか。オンでサインイン時の起動がオフなら、1 行すすめる
 * @returns {{ visible:boolean, checked:boolean, blocked:boolean, recommend:boolean }}
 */
export function loginItemView(state, { remoteEnabled = false } = {}) {
  if (!state?.supported) return { visible: false, checked: false, blocked: false, recommend: false };
  const checked = state.enabled === true;
  const blocked = state.blocked === true;
  return { visible: true, checked, blocked, recommend: remoteEnabled === true && !checked && !blocked };
}
