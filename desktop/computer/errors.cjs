'use strict';
// core へ返すエラーの code（docs/computer-use.md「core と main」の error.code）。

const CODES = new Set(['locked', 'uipi', 'self', 'windows_key', 'stopped', 'outside', 'not_found', 'timeout', 'unsupported', 'failed']);

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
