'use strict';
// 入力デスクトップの判定（docs/computer-use.md の `locked`）。Default 以外はロック画面か UAC の安全なデスクトップ。

function createDesktopState({ win32 }) {
  /** @returns {{ locked: boolean, name: string|null }} */
  function check() {
    const { name, error } = win32.inputDesktop();
    if (name !== null) return { locked: name.toLowerCase() !== 'default', name };
    // 開けないのはロック画面（Winlogon）で起きる。アクセス拒否以外の失敗は、確かめられないだけなので止めない
    return { locked: error === win32.ERROR_ACCESS_DENIED, name: null };
  }
  return { check };
}

module.exports = { createDesktopState };
