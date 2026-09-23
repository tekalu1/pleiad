// utilityProcess（core/server.mjs）からの暗号化の依頼に、main プロセスの safeStorage で答える。
// 相手は core/secret-store.mjs の parentPortCipher。秘密の値はメッセージの中だけを通り、ログには出さない。
//
// Linux で鍵束が無いと safeStorage は basic_text（固定の鍵）に落ちる。暗号化したように見えて実質は平文なので、
// その場合は「使えない」と答え、サーバー側は 0600 の平文に切り替えて UI に「暗号化されていない」と出す。

function encryptionState(safeStorage, platform) {
  if (!safeStorage?.isEncryptionAvailable?.()) return { available: false, backend: 'none', reason: 'OS の暗号化機能（safeStorage）が使えません' };
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    if (backend === 'basic_text' || backend === 'unknown') return { available: false, backend, reason: 'OS の鍵束が見つからないため、暗号化できません（basic_text）' };
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
      return { ...reply, ok: false, error: message?.op === 'decrypt' ? '秘密情報を復号できませんでした（別のユーザー・別の PC で暗号化された可能性があります）' : String(e?.message ?? '暗号化できませんでした').slice(0, 200) };
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

/**
 * main プロセスで直接 safeStorage を使う暗号器（core/secret-store.mjs の cipher の形: status / encrypt / decrypt）。
 * リモートの端末の資格情報（core/remote/device.mjs の createRemoteDevice の cipher）に渡す。
 * 暗号化できない（Linux の basic_text など）ときは status().encrypted が false になり、置き場は 0600 の平文になる。
 */
function safeStorageCipher({ safeStorage, platform = process.platform }) {
  const handle = createSecretHandler({ safeStorage, platform });
  const call = (op, value) => {
    const r = handle({ id: 0, op, value });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return {
    async status() {
      const s = call('status');
      return { encrypted: Boolean(s.available), backend: s.backend, ...(s.available ? {} : { reason: s.reason }) };
    },
    async encrypt(value) { return call('encrypt', value); },
    async decrypt(value) { return call('decrypt', value); },
  };
}

module.exports = { attachSecretBridge, createSecretHandler, encryptionState, openableAuthUrl, safeStorageCipher };
