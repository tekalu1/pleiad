'use strict';
// core へ返すエラーの code（docs/computer-use.md「core と main」の error.code）。

const CODES = new Set(['locked', 'uipi', 'self', 'windows_key', 'stopped', 'outside', 'not_found', 'timeout', 'unsupported', 'failed',
  // macOS（ADR 0173）: 画面収録・アクセシビリティの許可が無い / 安全な入力（パスワードの欄）の間 / Spotlight などを呼ぶ組み合わせ
  'permission', 'secure_input', 'system_key',
  // 押す直前に、点の下の窓が core の判定したアプリと別になっていた
  'target_changed']);

class ComputerError extends Error {
  /** @param {string} code CODES のどれか。知らない値は failed に倒す */
  constructor(code, message, extra) {
    super(message);
    this.name = 'ComputerError';
    this.code = CODES.has(code) ? code : 'failed';
    if (extra) Object.assign(this, extra);
  }
}

module.exports = { ComputerError, CODES };
