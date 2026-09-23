// utilityProcess（core/server.mjs）からの「サーバーのある PC で開く」依頼を main の shell で実行する。
// 相手は core/os-open.mjs の parentPortOpener。許可範囲（作業ディレクトリ・添付・生成画像）と接続元の判定はサーバーが済ませている。
// main は範囲を知らないので、ここでは形だけを確かめ直す: 絶対パス・UNC でない・実在・「開く」は HTML のファイルだけ。
//   { type:'os-open', id, action:'reveal'|'open', path } -> { type:'os-open', id, ok, error? }
const path = require('node:path');
const fs = require('node:fs');

const OPENABLE = /\.html?$/i;

/** 依頼を確かめる。通らなければ例外（文面は画面に出る） */
function checkRequest(message, { stat = fs.statSync } = {}) {
  const file = message?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\u0000-\u001f]/.test(file)) throw new Error('このパスは開けません。');
  if (message.action !== 'reveal' && message.action !== 'open') throw new Error('unknown action');
  let info;
  try { info = stat(file); } catch { throw new Error('ファイルが見つかりません。'); }
  const directory = info.isDirectory();
  if (!directory && !info.isFile()) throw new Error('ファイルまたはフォルダーを選んでください。');
  if (message.action === 'open' && (directory || !OPENABLE.test(file))) throw new Error('ブラウザーで開けるのは HTML だけです。');
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
        if (error) throw new Error(String(error).slice(0, 200));
      }
      return { ...reply, ok: true };
    } catch (e) {
      return { ...reply, ok: false, error: String(e?.message ?? '開けませんでした').slice(0, 200) };
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
