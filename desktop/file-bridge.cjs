// utilityProcess（core/server.mjs）からの「サーバーのある PC で開く」依頼を main の shell で実行する。
// 相手は core/os-open.mjs の parentPortOpener。許可範囲（作業ディレクトリ・添付・生成画像）と接続元の判定はサーバーが済ませている。
// main は範囲を知らないので、ここでは形だけを確かめ直す: 絶対パス・UNC でない・実在・「開く」は HTML のファイルだけ。
//   { type:'os-open', id, action:'reveal'|'open', path } -> { type:'os-open', id, ok, code?, detail? }
// 本体は画面の言語を知らないので、失敗は code で返し、文言はサーバーが辞書から引く（core/os-open.mjs の bridgeError）。
const path = require('node:path');
const fs = require('node:fs');

const OPENABLE = /\.html?$/i;

const failure = (code, detail) => Object.assign(new Error(detail || code), { code });

/** 依頼を確かめる。通らなければ code 付きの例外 */
function checkRequest(message, { stat = fs.statSync } = {}) {
  const file = message?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\u0000-\u001f]/.test(file)) throw failure('invalid-path');
  if (message.action !== 'reveal' && message.action !== 'open') throw failure('invalid-path', 'unknown action');
  let info;
  try { info = stat(file); } catch { throw failure('not-found'); }
  const directory = info.isDirectory();
  if (!directory && !info.isFile()) throw failure('not-file');
  if (message.action === 'open' && (directory || !OPENABLE.test(file))) throw failure('html-only');
  return { action: message.action, file, directory };
}

/** 依頼を受けて返すメッセージを作る（送るのは呼び出し側） */
function createFileHandler({ shell, stat }) {
  return async function handle(message) {
    const reply = { type: 'os-open', id: message?.id };
    try {
      const { action, file, directory } = checkRequest(message, { stat });
      if (action === 'reveal' && !directory) shell.showItemInFolder(file);
      else {
        // フォルダーはその中を開き、HTML は既定のブラウザーで開く。失敗は文字列で返ってくる
        const error = await shell.openPath(file);
        if (error) throw failure('open-failed', String(error).slice(0, 200));
      }
      return { ...reply, ok: true };
    } catch (e) {
      return { ...reply, ok: false, code: e?.code ?? 'open-failed', detail: String(e?.message ?? '').slice(0, 200) };
    }
  };
}

function attachFileBridge(worker, { shell }) {
  const handle = createFileHandler({ shell });
  worker.on('message', async message => {
    if (message?.type === 'os-open') worker.postMessage(await handle(message));
  });
}

module.exports = { attachFileBridge, createFileHandler, checkRequest };
