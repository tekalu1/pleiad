import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createLoginItem, attachLoginItem, HIDDEN_ARG, launchedHidden } = require('../../desktop/login-item.cjs');

export const name = 'desktop-login-item';
export const title = 'OS にサインインしたら Pleiad を起動する設定: 登録するパス・引数、OS の実際の状態、静かな起動';

const INSTALLED = 'C:\\Users\\u\\AppData\\Local\\Programs\\Pleiad\\Ply.exe';
const AUMID = 'jp.ply.desktop';

/** 偽の electron.app。登録の呼び出しの引数を溜め、レジストリの Run の代わりの表を持つ（本物の OS には何も書かない） */
function fakeApp({ execPath = INSTALLED, items = [], disabled = false } = {}) {
  const calls = { set: [], get: [] };
  const app = {
    isPackaged: true,
    calls,
    table: { items },
    setLoginItemSettings(settings) {
      calls.set.push(settings);
      const path = settings.path ?? execPath;
      const args = settings.args ?? [];
      app.table.items = app.table.items.filter(item => item.name !== AUMID);
      if (settings.openAtLogin) app.table.items.push({ name: AUMID, path, args, scope: 'user', enabled: disabled ? false : settings.enabled !== false });
    },
    getLoginItemSettings(options = {}) {
      calls.get.push(options);
      const path = options.path ?? execPath;
      const args = options.args ?? [];
      const mine = app.table.items.filter(item => item.name === AUMID);
      const exact = mine.some(item => item.path === path && item.args.join('\u0000') === args.join('\u0000'));
      return { openAtLogin: exact, executableWillLaunchAtLogin: mine.some(item => item.path === path && item.enabled), wasOpenedAtLogin: false, launchItems: app.table.items };
    },
  };
  return app;
}

export default async function(t) {
  // 登録するのは版に依らないインストーラーの起動用の exe と --hidden。set の引数をそのまま確かめる
  {
    const app = fakeApp();
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    t.ok('インストール版の Windows は使える', item.info().supported === true);
    t.ok('最初はオフ（既定）', item.info().enabled === false);
    const after = item.set(true);
    t.ok('オンにすると Windows の Run に版に依らない起動用の exe と --hidden を登録する',
      app.calls.set.length === 1 && app.calls.set[0].openAtLogin === true && app.calls.set[0].path === INSTALLED
        && JSON.stringify(app.calls.set[0].args) === JSON.stringify([HIDDEN_ARG]) && HIDDEN_ARG === '--hidden', JSON.stringify(app.calls.set));
    t.ok('登録した後の状態は OS から読んだ値（オン）', after.enabled === true && item.info().enabled === true);
    t.ok('読むときも同じパスと引数で照合する', app.calls.get.every(call => call.path === INSTALLED && JSON.stringify(call.args) === JSON.stringify([HIDDEN_ARG])));
    t.ok('登録のパスに版ごとの実行場所（agent-host-runtime）を含まない', !/agent-host-runtime/i.test(app.calls.set[0].path));
    item.set(false);
    t.ok('オフにすると登録を外す（同じパスと引数で）', app.calls.set[1].openAtLogin === false && app.calls.set[1].path === INSTALLED && item.info().enabled === false);
    // ほかの道（設定アプリ・タスクマネージャー・レジストリの削除）で外されたら画面もオフになる
    item.set(true);
    app.table.items = [];
    t.ok('ほかの道で外されたら、読み直した状態もオフ', item.info().enabled === false);
  }
  // タスクマネージャー／Windows の設定で無効にされた登録は、オンのまま「OS に止められている」と分かる
  {
    const app = fakeApp({ disabled: true });
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    item.set(true);
    const state = item.info();
    t.ok('Run にあるが OS 側で無効なら enabled は false・blocked は true', state.enabled === false && state.blocked === true, JSON.stringify(state));
  }
  // 更新・再インストールで入れ先が変わった／古い版のパスが残った登録は、起動のときに今のパスへ直す
  {
    const stale = { name: AUMID, path: 'C:\\Users\\u\\AppData\\Local\\agent-host-runtime\\app\\0.13.0-beta.2-abcd\\Ply.exe', args: ['--hidden'], scope: 'user', enabled: true };
    const app = fakeApp({ items: [stale] });
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    t.ok('古いパスの登録だけがあるとき、状態は オフ（今の exe では起動しない）', item.info().enabled === false);
    t.ok('reconcile は古いパスの登録を今の exe へ書き直す', item.reconcile() === true
      && app.calls.set.length === 1 && app.calls.set[0].path === INSTALLED && app.calls.set[0].openAtLogin === true && app.calls.set[0].enabled === true, JSON.stringify(app.calls.set));
    t.ok('書き直した後は 1 件だけで、今のパス', app.table.items.length === 1 && app.table.items[0].path === INSTALLED);
    t.ok('もう一度 reconcile しても書かない（正しい登録には触らない）', item.reconcile() === false && app.calls.set.length === 1);
  }
  {
    // タスクマネージャーで無効にした古いパスの登録は、直しても無効のまま（利用者の選択を戻さない）
    const app = fakeApp({ items: [{ name: AUMID, path: 'D:\old\Ply.exe', args: ['--hidden'], scope: 'user', enabled: false }] });
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    item.reconcile();
    t.ok('無効にされていた古い登録は、直しても無効のまま', app.calls.set[0]?.enabled === false && app.calls.set[0].path === INSTALLED, JSON.stringify(app.calls.set));
  }
  {
    const app = fakeApp();
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    t.ok('登録が無い人には reconcile は何も書かない（勝手にオンにしない）', item.reconcile() === false && app.calls.set.length === 0);
    const machine = fakeApp({ items: [{ name: AUMID, path: 'D:\\old\\Ply.exe', args: [], scope: 'machine', enabled: true }] });
    t.ok('全ユーザー（machine）の登録は触らない', createLoginItem({ app: machine, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false }).reconcile() === false && machine.calls.set.length === 0);
  }
  // 使えない構成: 開発起動・Store の MSIX・Linux。呼んでも登録しない
  for (const [label, options] of [
    ['開発起動（electron.exe）', { packaged: false }],
    ['Microsoft Store の版', { store: true }],
    ['Linux', { platform: 'linux' }],
  ]) {
    const app = fakeApp();
    if ('packaged' in options) app.isPackaged = options.packaged;
    const item = createLoginItem({ app, platform: options.platform ?? 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: options.store ?? false });
    const info = item.info();
    t.ok(`${label}: supported は false で理由を持つ`, info.supported === false && typeof info.reason === 'string' && info.enabled === false, JSON.stringify(info));
    let threw = false;
    try { item.set(true); } catch { threw = true; }
    t.ok(`${label}: オンにしようとしても登録しない`, threw && app.calls.set.length === 0 && item.reconcile() === false);
  }
  // macOS: 同じ API。path / args は渡さない（Windows の引数）。隠し起動は wasOpenedAtLogin で分かる
  {
    const calls = [];
    const app = { isPackaged: true, setLoginItemSettings: s => calls.push(s), getLoginItemSettings: () => ({ openAtLogin: true, status: 'enabled', wasOpenedAtLogin: true }) };
    const item = createLoginItem({ app, platform: 'darwin', execPath: '/Applications/Pleiad.app/Contents/MacOS/Pleiad', appUserModelId: AUMID, store: false });
    item.set(true);
    t.ok('macOS は openAtLogin だけを渡す', calls.length === 1 && calls[0].openAtLogin === true && !('path' in calls[0]) && !('args' in calls[0]), JSON.stringify(calls));
    t.ok('macOS は OS が返した状態を読む', item.info().enabled === true && item.info().supported === true);
    t.ok('macOS の隠し起動は wasOpenedAtLogin で分かる', item.launchedHidden([]) === true);
  }
  // 静かな起動の判定（引数）
  t.ok('--hidden があれば静かな起動', launchedHidden(['C:\\Ply.exe', '--hidden']) === true);
  t.ok('--hidden が無ければ普通の起動', launchedHidden(['C:\\Ply.exe']) === false && launchedHidden(undefined) === false);
  t.ok('似た引数（--hidden-x）は静かな起動にしない', launchedHidden(['Ply.exe', '--hidden-x']) === false);

  // サーバーからの依頼（ply_control の設定）を受けて main が答える橋
  {
    const app = fakeApp();
    const item = createLoginItem({ app, platform: 'win32', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    const worker = new EventEmitter();
    const sent = [];
    worker.postMessage = message => sent.push(message);
    attachLoginItem(worker, { loginItem: item });
    worker.emit('message', { type: 'login-item', id: 'l1', action: 'get' });
    worker.emit('message', { type: 'login-item', id: 'l2', action: 'set', enabled: true });
    worker.emit('message', { type: 'login-item', id: 'l3', action: 'set', enabled: 'yes' });
    worker.emit('message', { type: 'login-item', id: 'l4', action: 'unknown' });
    worker.emit('message', { type: 'other', id: 'x' });
    t.ok('get に状態で答える', sent[0]?.id === 'l1' && sent[0].ok === true && sent[0].state.enabled === false && sent[0].state.supported === true, JSON.stringify(sent[0]));
    t.ok('set でオンにして新しい状態を返す', sent[1]?.id === 'l2' && sent[1].ok === true && sent[1].state.enabled === true && app.calls.set.length === 1);
    t.ok('真偽でない値は断り、登録しない', sent[2]?.ok === false && app.calls.set.length === 1, JSON.stringify(sent[2]));
    t.ok('知らない action は断る', sent[3]?.ok === false);
    t.ok('関係ない知らせには答えない', sent.length === 4);
    const unsupported = createLoginItem({ app: fakeApp(), platform: 'linux', execPath: INSTALLED, appUserModelId: AUMID, store: false });
    const w2 = new EventEmitter(); const sent2 = []; w2.postMessage = m => sent2.push(m);
    attachLoginItem(w2, { loginItem: unsupported });
    w2.emit('message', { type: 'login-item', id: 'u1', action: 'set', enabled: true });
    t.ok('使えない構成への set は ok:false と code で返す（例外にしない）', sent2[0]?.ok === false && sent2[0].code === 'unsupported', JSON.stringify(sent2[0]));
  }
}
