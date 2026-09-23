// utilityProcess（core/server.mjs）からの暗号化の依頼に、main プロセスの safeStorage で答える。
// 理由・エラーの文は画面（設定のコンテキストの「暗号化されていない」）まで届くので、main の言語で出す（desktop/i18n.cjs）
// 相手は core/secret-store.mjs の parentPortCipher。秘密の値はメッセージの中だけを通り、ログには出さない。
//
// Linux で鍵束が無いと safeStorage は basic_text（固定の鍵）に落ちる。暗号化したように見えて実質は平文なので、
// その場合は「使えない」と答え、サーバー側は 0600 の平文に切り替えて UI に「暗号化されていない」と出す。
const { t } = require('./i18n.cjs');

function encryptionState(safeStorage, platform) {
  if (!safeStorage?.isEncryptionAvailable?.()) return { available: false, backend: 'none', reason: t('secrets.unavailable') };
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    if (backend === 'basic_text' || backend === 'unknown') return { available: false, backend, reason: t('secrets.noKeyring') };
    return { available: true, backend };
  }
  return { available: true, backend: platform === 'win32' ? 'dpapi' : platform === 'darwin' ? 'keychain' : platform };
}

/** { type:'secret', id, op, value } を受けて、返すメッセージを作る（送るのは呼び出し側） */
function createSecretHandler({ safeStorage, platform = process.platform }) {
  return function handle(message) {
    const reply = { type: 'secret', id: message?.id };
    try {
      const state = encryptionState(safeStorage, platform);
      if (message.op === 'status') return { ...reply, ok: true, value: state };
      if (!state.available) throw new Error(state.reason);
      if (typeof message.value !== 'string') throw new Error('invalid value');
      if (message.op === 'encrypt') return { ...reply, ok: true, value: safeStorage.encryptString(message.value).toString('base64') };
      if (message.op === 'decrypt') return { ...reply, ok: true, value: safeStorage.decryptString(Buffer.from(message.value, 'base64')) };
      throw new Error('unknown operation');
    } catch (e) {
      // 例外の文面に値が混じらないよう、固定の文にする
      return { ...reply, ok: false, error: message?.op === 'decrypt' ? t('secrets.decryptFailed') : String(e?.message ?? t('secrets.encryptFailed')).slice(0, 200) };
    }
  };
}

/**
 * OAuth の同意画面など、サーバーから頼まれた URL を既定のブラウザで開いてよいか。
 * https と、ループバックの http（手元で動かす認可サーバー）だけを通す。
 */
function openableAuthUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.href;
  } catch {}
  return null;
}

/**
 * utilityProcess（サーバー）からの依頼を main で受ける配線。desktop/main.cjs と、実機の往復を確かめるスモーク
 * （tests/desktop/safe-storage-smoke.cjs）が同じものを使う。
 *   { type:'secret' }        safeStorage で暗号化・復号して返す
 *   { type:'open-external' } OAuth の同意画面を既定のブラウザで開く（https とループバックの http だけ）
 */
function attachSecretBridge(worker, { safeStorage, openExternal, platform = process.platform }) {
  const secrets = createSecretHandler({ safeStorage, platform });
  worker.on('message', message => {
    if (message?.type === 'secret') worker.postMessage(secrets(message));
    if (message?.type === 'open-external' && openExternal) { const url = openableAuthUrl(message.url); if (url) openExternal(url); }
  });
}

module.exports = { attachSecretBridge, createSecretHandler, encryptionState, openableAuthUrl };
