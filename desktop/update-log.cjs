const fs = require('node:fs/promises');
const path = require('node:path');

// 更新（electron-updater）の記録をファイルに残す。遅い・失敗したときに、差分の取得が効いたか
// （「Full: … To download: …」「Cannot download differentially」）や、どの URL から取ったかを後から確かめるため。
// 記録には GitHub のトークンや、配信の URL の署名（?sig=…&jwt=…）が混ざりうるので、書く前に伏せる
const MAX_BYTES = 1024 * 1024;

function redact(text) {
  return String(text)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/\b(token|bearer)\s+[A-Za-z0-9_.~+/=-]{16,}/gi, '$1 [redacted]')
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^"',}\r\n]+/gi, '$1[redacted]')
    // URL の問い合わせ部分（署名付きの一時 URL の鍵）は丸ごと伏せる
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/g, '$1?[redacted]');
}

/** electron-updater の logger（info・warn・error・debug） */
function createUpdateLog(file, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  let queue = Promise.resolve();
  const write = level => (...args) => {
    const text = args.map(a => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const line = `${now().toISOString()} ${level} ${redact(text)}\n`;
    queue = queue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // 大きくなったら 1 世代だけ残して新しく始める
      const size = await fs.stat(file).then(s => s.size, () => 0);
      if (size > maxBytes) await fs.rename(file, `${file}.old`).catch(() => {});
      await fs.appendFile(file, line, 'utf8');
    }).catch(() => {});
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), flush: () => queue };
}

module.exports = { createUpdateLog, redact };
