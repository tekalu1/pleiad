// 窓ごとのオリジンの表（docs/remote.md §7.3「trusted() の窓ごと化」）。
// IPC の送り元が「登録した窓の本体フレーム」で、その窓に決めたオリジンの画面であることを確かめる。
//   local:  ローカルのサーバーの画面（http://127.0.0.1:<p>）。フォルダーの選択・更新などの同じ PC のブリッジを使える
//   remote: ホストの画面を端末内プロキシ（http://127.0.0.1:<ホストごとのポート>）から読む窓。帯・通知・接続の状態だけ
//   hosts:  アプリに同梱の「ほかのホストにつなぐ」窓（file:）。ペアリングと窓を開く操作
// 窓の種類ごとに IPC の口を分けたうえで、口ごとに受け付ける種類をここで限る（リモートの窓から choose-folder は通らない）。

/** 照合に使う形。http(s) はオリジン、file: は検索と # を除いた URL（同じファイルだけ） */
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') { u.search = ''; u.hash = ''; return u.href; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {}
  return null;
}

function createWindowTrust() {
  const table = new Map();   // webContents -> { kind, origin, window, ...data }

  return {
    /** 窓を表に載せる。窓が閉じたら消える。origin は URL でもオリジンでもよい */
    register(window, { kind, origin, ...data }) {
      const contents = window.webContents;
      const entry = { kind, origin: originOf(origin), window, ...data };
      table.set(contents, entry);
      window.once('closed', () => table.delete(contents));
      return entry;
    },
    /** 載せた窓の情報を差し替える（プロキシのポートが変わったときなど） */
    update(window, patch) {
      const entry = table.get(window.webContents);
      if (!entry) return null;
      Object.assign(entry, patch, patch.origin ? { origin: originOf(patch.origin) } : {});
      return entry;
    },
    /** 送り元を確かめて表の行を返す。通らなければ例外 */
    check(event, kinds) {
      const entry = table.get(event?.sender);
      let ok = Boolean(entry) && kinds.includes(entry.kind) && !entry.window.isDestroyed?.()
        && event.senderFrame && event.senderFrame === event.sender.mainFrame;
      if (ok) ok = originOf(event.senderFrame.url) === entry.origin && entry.origin !== null;
      if (!ok) throw new Error('Invalid sender');
      return entry;
    },
    /** 例外にせず行か null */
    find(event, kinds) { try { return this.check(event, kinds); } catch { return null; } },
    entries(kind) { return [...table.values()].filter(e => !kind || e.kind === kind); },
  };
}

module.exports = { createWindowTrust, originOf };
