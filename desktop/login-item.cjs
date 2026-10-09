// OS にサインインしたら Pleiad を起動する設定（docs/desktop-releases.md「サインインで起動」、ADR 0175）。
// 持ち主は OS（Windows は HKCU\...\Run、macOS はログイン項目）。Pleiad は設定を別に覚えず、画面の表示も毎回 OS から読む
// （設定アプリ・タスクマネージャー・レジストリの削除で外されたら、画面もオフになる）。
//
// 登録するのは版に依らない起動用の exe（process.execPath = $INSTDIR\Ply.exe）と --hidden。
//   - main は更新（無停止の引き継ぎ ADR 0167 を含む）の後も、インストーラーが置いた $INSTDIR\Ply.exe から起動する。
//     版ごとの実行場所（%LOCALAPPDATA%\agent-host-runtime\app\<版>\…）で走るのはサーバーだけで、main の exe ではない
//   - なので更新しても登録は無効にならず、書き直しも要らない。それでも入れ先を変えた再インストールなどで古いパスが残ったら、
//     起動のたびに reconcile が今の exe へ直す（登録が無い人には何も書かない）
// Microsoft Store の版（MSIX）は Run を使えない（スタートアップはパッケージの宣言で決まる）ので対象外。開発起動は electron.exe を登録してしまうので対象外。
// Linux は Electron の API が無いので対象外。

/** 自動起動で上がったことを main に知らせる引数。窓を前面に出さず静かに起動する */
const HIDDEN_ARG = '--hidden';

/** argv に HIDDEN_ARG があるか（完全一致。--hidden-x のような似た引数は当てない） */
function launchedHidden(argv) {
  return Array.isArray(argv) && argv.includes(HIDDEN_ARG);
}

const samePath = (a, b) => String(a ?? '').replace(/\//g, '\\').toLowerCase() === String(b ?? '').replace(/\//g, '\\').toLowerCase();
const sameArgs = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);

class LoginItemError extends Error {
  constructor(code, message) { super(message); this.name = 'LoginItemError'; this.code = code; }
}

/**
 * @param deps.app            electron の app（試験では偽物。setLoginItemSettings / getLoginItemSettings / isPackaged）
 * @param deps.platform       process.platform
 * @param deps.execPath       起動用の exe（Store 版では stableLauncher が App Execution Alias を返すが、Store 版はそもそも対象外）
 * @param deps.appUserModelId Windows の Run の値の名前（Electron は name を省くと AUMID を使い、読む側に name の指定が無い）
 * @param deps.store          Microsoft Store の版か
 */
function createLoginItem({ app, platform = process.platform, execPath = process.execPath, appUserModelId = null, store = false } = {}) {
  const reason = !app?.setLoginItemSettings || !app?.getLoginItemSettings ? 'api'
    : store ? 'store'
    : platform !== 'win32' && platform !== 'darwin' ? 'platform'
    : !app.isPackaged ? 'dev'
    : null;
  const win = platform === 'win32';
  const args = [HIDDEN_ARG];
  /** Windows は path と args を照合に使う（読む側も同じ値を渡す）。macOS には無い */
  const target = win ? { path: execPath, args } : {};

  /** Windows の Run にある自分の値（name が AUMID のもの）。user の登録だけを自分のものとして扱う */
  const mine = state => (state?.launchItems ?? []).filter(item => item?.scope === 'user' && (!appUserModelId || item.name === appUserModelId));

  function read() {
    const state = app.getLoginItemSettings(win ? { path: execPath, args } : {});
    if (!win) return { enabled: state.openAtLogin === true, blocked: state.status === 'requires-approval' };
    const exact = state.openAtLogin === true;
    // Run に今の exe と --hidden の登録があっても、タスクマネージャー・Windows の設定で無効にされていれば起動しない
    const approved = mine(state).some(item => samePath(item.path, execPath) && sameArgs(item.args, args) && item.enabled !== false);
    return { enabled: exact && approved, blocked: exact && !approved };
  }

  return {
    HIDDEN_ARG,
    /** { supported, reason?, enabled, blocked }。enabled は OS の実際の状態 */
    info() {
      if (reason) return { supported: false, reason, enabled: false, blocked: false };
      try { return { supported: true, ...read() }; } catch { return { supported: true, enabled: false, blocked: false }; }
    },
    /** 登録する・外す。戻り値は登録の後に OS から読み直した info()。使えない構成は LoginItemError('unsupported') */
    set(enabled) {
      if (reason) throw new LoginItemError('unsupported', `launch at login is not available (${reason})`);
      if (typeof enabled !== 'boolean') throw new LoginItemError('invalid', 'enabled must be a boolean');
      app.setLoginItemSettings({ openAtLogin: enabled, ...target });
      return this.info();
    },
    /**
     * 起動のたびに呼ぶ。自分の登録が今の exe・引数と違う（入れ先を変えた・古いパスが残った）なら、今のものへ書き直す。
     * 登録が無ければ何も書かない。タスクマネージャーで無効にされた登録は、無効のまま直す。書き直したら true
     */
    reconcile() {
      if (reason || !win) return false;
      try {
        const state = app.getLoginItemSettings({ path: execPath, args });
        const items = mine(state);
        if (!items.length || items.some(item => samePath(item.path, execPath) && sameArgs(item.args, args))) return false;
        app.setLoginItemSettings({ openAtLogin: true, path: execPath, args, enabled: items.every(item => item.enabled !== false) });
        return true;
      } catch { return false; }
    },
    /** 自動起動で上がったか。Windows は引数、macOS は OS が教える（wasOpenedAtLogin） */
    launchedHidden(argv) {
      if (launchedHidden(argv)) return true;
      if (platform !== 'darwin' || reason) return false;
      try { return app.getLoginItemSettings().wasOpenedAtLogin === true; } catch { return false; }
    },
  };
}

/**
 * サーバーからの { type:'login-item', id, action:'get'|'set', enabled } に答える（core/login-item.mjs が相手）。
 * ply_control の設定（launchAtLogin）と、リモートの窓からの変更が通る道。ローカルの窓は preload の IPC で同じ loginItem を呼ぶ
 */
function attachLoginItem(worker, { loginItem }) {
  worker.on('message', message => {
    if (message?.type !== 'login-item') return;
    const reply = { type: 'login-item', id: message.id };
    try {
      if (message.action === 'get') worker.postMessage({ ...reply, ok: true, state: loginItem.info() });
      else if (message.action === 'set') worker.postMessage({ ...reply, ok: true, state: loginItem.set(message.enabled) });
      else worker.postMessage({ ...reply, ok: false, code: 'invalid' });
    } catch (error) {
      worker.postMessage({ ...reply, ok: false, code: error?.code ?? 'failed' });
    }
  });
}

module.exports = { createLoginItem, attachLoginItem, launchedHidden, HIDDEN_ARG, LoginItemError };
