// デスクトップ版の端末（docs/remote.md §7。issue #14）の、Electron を起こさずに確かめられる部分。
//   - 窓ごとのオリジンの表（desktop/window-trust.cjs）: 送り元の窓・本体フレーム・オリジン・窓の種類
//   - リモートの窓の部品（desktop/remote-windows.cjs）: partition・名前・引数の往復（秘密を入れない）・帯の色・重ねアイコン
//   - preload の出し分け: リモートの窓に同じ PC のブリッジ（chooseFolder・update・openRemoteHosts）を出さない
//   - ほかのホストにつなぐ窓（desktop/remote-hosts-view.cjs）の辞書と行
//   - 画面のバッジ（web/remote-badge.mjs）: plyRemote の有無・状態の添え書き・再試行・この窓を閉じる
//   - 本体の文言（desktop/i18n.cjs）: desktop の辞書を言語ごとに引く
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { N } from '../lib/dom-stub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createWindowTrust, originOf } = require('../../desktop/window-trust.cjs');
const rw = require('../../desktop/remote-windows.cjs');
const view = require('../../desktop/remote-hosts-view.cjs');
const desktopI18n = require('../../desktop/i18n.cjs');

export const name = 'desktop-remote';
export const title = 'デスクトップ版の端末: 窓ごとの信頼・preload の出し分け・リモートの印';

const HOST_ID = 'abcdefghijklmnopqrstuvwxyz';   // base32（小文字）の 26 字

/** preload を偽の electron で走らせ、exposeInMainWorld に渡ったものと送った口を集める */
function runPreload(file, argv = []) {
  const exposed = {}, sent = [], invoked = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: {
      send: (ch, ...a) => sent.push([ch, ...a]),
      invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve(null); },
      on: () => {}, removeListener: () => {},
    },
  };
  const code = fs.readFileSync(path.join(ROOT, 'desktop', file), 'utf8');
  vm.runInNewContext(code, {
    require: m => { if (m === 'electron') return electron; throw new Error(`preload は ${m} を読めない（sandbox）`); },
    process: { argv, platform: 'win32' }, decodeURIComponent, JSON,
  }, { filename: file });
  return { exposed, sent, invoked };
}

function fakeWindow(url) {
  const mainFrame = { url };
  const contents = { mainFrame };
  const handlers = {};
  return { webContents: contents, isDestroyed: () => false, once: (ev, fn) => { handlers[ev] = fn; }, fire: ev => handlers[ev]?.(), frame: mainFrame };
}

export default async function (t) {
  // ---------------------------------------------------------------- 窓ごとのオリジンの表
  {
    const trust = createWindowTrust();
    const local = fakeWindow('http://127.0.0.1:7420/');
    const remote = fakeWindow('http://127.0.0.1:51001/?token=x');
    const hostsFile = 'file:///C:/app/desktop/remote-hosts.html';
    const hosts = fakeWindow(hostsFile);
    trust.register(local, { kind: 'local', origin: 'http://127.0.0.1:7420' });
    trust.register(remote, { kind: 'remote', origin: 'http://127.0.0.1:51001', hostId: HOST_ID });
    trust.register(hosts, { kind: 'hosts', origin: hostsFile });
    const main = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
    t.ok('ローカルの窓はローカルの口を通る', trust.find(main(local), ['local'])?.kind === 'local');
    t.ok('リモートの窓からローカルの口（choose-folder・update）は通らない', trust.find(main(remote), ['local']) === null);
    t.ok('リモートの窓はリモートの口を通り、どのホストか分かる', trust.find(main(remote), ['remote'])?.hostId === HOST_ID);
    t.ok('ローカルの窓からリモート・同梱の窓の口は通らない', trust.find(main(local), ['remote', 'hosts']) === null);
    t.ok('同梱の窓は同じファイルだけ（# や ? は無視）', trust.find({ sender: hosts.webContents, senderFrame: Object.assign(hosts.frame, { url: hostsFile + '#x' }) }, ['hosts'])?.kind === 'hosts');
    hosts.frame.url = 'file:///C:/other.html';
    t.ok('同梱の窓が別のファイルに移っていたら通らない', trust.find(main(hosts), ['hosts']) === null);
    remote.frame.url = 'http://127.0.0.1:51002/';
    t.ok('リモートの窓が別のポート（別のオリジン）に移っていたら通らない', trust.find(main(remote), ['remote']) === null);
    remote.frame.url = 'http://127.0.0.1:51001/x';
    const sub = { sender: remote.webContents, senderFrame: { url: 'http://127.0.0.1:51001/' } };
    t.ok('埋め込みの枠（本体フレームでない）からは通らない', trust.find(sub, ['remote']) === null);
    t.ok('表に無い送り元は通らない', trust.find({ sender: {}, senderFrame: {} }, ['local', 'remote', 'hosts']) === null);
    remote.frame.url = 'http://evil.example/';
    let threw = false; try { trust.check(main(remote), ['remote']); } catch { threw = true; }
    t.ok('check は通らなければ例外', threw);
    remote.fire('closed');
    t.ok('閉じた窓は表から消える', trust.find(main(remote), ['remote']) === null && trust.entries('remote').length === 0);
    t.ok('originOf: http はオリジン、file は ? と # を除いた URL、ほかは null',
      originOf('http://127.0.0.1:1/a?b') === 'http://127.0.0.1:1' && originOf('file:///a/b.html?x#y') === 'file:///a/b.html' && originOf('javascript:alert(1)') === null);
  }

  // ---------------------------------------------------------------- リモートの窓の部品
  {
    t.ok('partition はホストごと（persist:remote-<hostId>）', rw.partitionFor(HOST_ID) === `persist:remote-${HOST_ID}`);
    let threw = false; try { rw.partitionFor('../x'); } catch { threw = true; }
    t.ok('hostId の形でなければ partition を作らない', threw);
    t.ok('名前は 付けた名前 → ホストの名乗り → hostId の頭',
      rw.displayName({ label: 'home', hostName: 'desk' }) === 'home' && rw.displayName({ hostName: 'desk' }) === 'desk' && rw.displayName({ hostId: HOST_ID }) === HOST_ID.slice(0, 8));
    t.ok('中継はホスト名だけを出す', rw.relayLabel('https://relay.example.net/path?x') === 'relay.example.net' && rw.relayLabel('nope') === '');
    t.ok('確認コードは 3 桁ずつ', rw.formatCode('482193') === '482 193' && rw.formatCode(12) === '12');
    {
      // 帯は塗らない（2026-09-23）。画面が色を送るまでの一瞬も、ローカルの窓と同じ脇の面（tokens.css の --surface-0 / --ink）
      const tokens = fs.readFileSync(path.join(ROOT, 'web/tokens.css'), 'utf8');
      const light = /--surface-0:(#[0-9a-f]{6})/i.exec(tokens)?.[1], ink = /--ink:(#[0-9a-f]{6})/i.exec(tokens)?.[1];
      t.ok('リモートの窓の帯の既定の色は脇の面（塗りの --fill-primary ではない）', rw.REMOTE_BAR.light.color === light && rw.REMOTE_BAR.light.symbolColor === ink
        && rw.REMOTE_BAR.dark.color === '#121318' && !/3a499e|5665cd/i.test(JSON.stringify(rw.REMOTE_BAR)), JSON.stringify(rw.REMOTE_BAR));
    }
    t.ok('帯の色は #rrggbb の 2 つだけ', rw.validTitleBarColors({ color: '#3a499e', symbolColor: '#F4F5FF' })?.color === '#3a499e'
      && rw.validTitleBarColors({ color: 'red', symbolColor: '#fff' }) === null && rw.validTitleBarColors(null) === null);
    const arg = rw.encodeRemoteArg({ hostId: HOST_ID, hostName: 'desk — ホーム', relay: 'relay.example.net', device: 'thinkpad', token: 'SECRET', url: 'http://127.0.0.1:1/?token=SECRET' });
    t.ok('preload への引数に秘密（トークン・URL）を入れない', !arg.includes('SECRET'));
    const back = rw.decodeRemoteArg(['electron', arg]);
    t.ok('引数は往復する（ホスト名の日本語も）', back?.hostId === HOST_ID && back.hostName === 'desk — ホーム' && back.shell === 'desktop');
    t.ok('hostId の形でない引数は捨てる', rw.decodeRemoteArg([rw.encodeRemoteArg({ hostId: 'X' })]) === null && rw.decodeRemoteArg(['--ply-remote=%E0']) === null);
    const st = rw.publicStatus({ state: 'offline', since: 1, retryAt: 2, closeCode: 1006, port: 5, hostName: 'desk', url: 'x' }, 9);
    t.ok('画面へ渡す状態に内部のもの（port・URL）を入れない', st.state === 'offline' && st.connectedAt === 9 && !('port' in st) && !('url' in st));
    t.ok('状態が無ければ接続中', rw.publicStatus(null).state === 'connecting');
    const row = rw.hostRow({ hostId: HOST_ID, hostName: 'desk', label: '', relayUrl: 'https://r.example/', state: 'closed', revokedAt: '2026-01-01', deviceId: 'd1', port: 3 });
    t.ok('一覧の行: 取り消し済みは revoked、deviceId・port は出さない', row.state === 'revoked' && !('deviceId' in row) && !('port' in row) && row.relay === 'r.example');
    t.ok('ジャンプリストの引数でほかのホストにつなぐ窓を開く', rw.wantsHostsWindow(['x', rw.HOSTS_ARG]) && !rw.wantsHostsWindow(['x']) && !rw.wantsHostsWindow(null));
    const bmp = rw.drawOverlayBitmap(32);
    const px = (x, y) => [...bmp.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    const blue = [...Array(32 * 32).keys()].some(i => bmp[i * 4 + 3] === 255 && bmp[i * 4] > bmp[i * 4 + 2] + 40);
    t.ok('重ねアイコン: 32×32 の BGRA、角は透明・中は不透明、塗りの色の矢印がある',
      bmp.length === 32 * 32 * 4 && px(0, 0)[3] === 0 && px(16, 16)[3] === 255 && blue);
  }

  // ---------------------------------------------------------------- preload の出し分け
  {
    const info = { hostId: HOST_ID, hostName: 'desk', relay: 'relay.example.net', device: 'thinkpad' };
    const remote = runPreload('remote-preload.cjs', ['electron', rw.encodeRemoteArg(info)]);
    const pd = remote.exposed.plyDesktop, pr = remote.exposed.plyRemote;
    t.ok('リモートの窓: plyRemote にホストの名前（引数の読み方は decodeRemoteArg と同じ）', pr?.hostId === HOST_ID && pr.hostName === 'desk' && pr.relay === 'relay.example.net' && pr.shell === 'desktop');
    t.ok('リモートの窓: 同じ PC のブリッジ（chooseFolder・update・onUpdate・openRemoteHosts）を出さない',
      pd && !('chooseFolder' in pd) && !('update' in pd) && !('onUpdate' in pd) && !('openRemoteHosts' in pd));
    t.ok('リモートの窓: 窓の枠・帯の色・完了通知は出す', pd.platform === 'win32' && typeof pd.setTitleBar === 'function' && typeof pd.notifyCompletion === 'function' && typeof pd.onNotificationClick === 'function');
    pd.setTitleBar({ color: '#3a499e', symbolColor: '#f4f5ff' });
    pd.notifyCompletion({ sessionId: 's' });
    pr.closeWindow(); pr.retry(); pr.status();
    t.ok('リモートの窓の IPC はリモート用の口だけ',
      remote.sent.map(s => s[0]).join() === 'ply:remote-title-bar,ply:remote-close'
      && remote.invoked.map(s => s[0]).join() === 'ply:remote-notify-completion,ply:remote-retry,ply:remote-status');
    t.ok('引数が無い・壊れた窓には何も出さない',
      Object.keys(runPreload('remote-preload.cjs', []).exposed).length === 0
      && Object.keys(runPreload('remote-preload.cjs', ['--ply-remote={bad']).exposed).length === 0
      && Object.keys(runPreload('remote-preload.cjs', [rw.encodeRemoteArg({ hostId: 'NOPE' })]).exposed).length === 0);
    const local = runPreload('preload.cjs');
    t.ok('ローカルの窓: 同じ PC のブリッジとほかのホストにつなぐ窓を出し、plyRemote は出さない',
      typeof local.exposed.plyDesktop?.chooseFolder === 'function' && typeof local.exposed.plyDesktop.update === 'function'
      && typeof local.exposed.plyDesktop.openRemoteHosts === 'function' && !('plyRemote' in local.exposed));
    local.exposed.plyDesktop.openRemoteHosts();
    t.ok('ほかのホストにつなぐ窓を開く口', local.invoked.at(-1)?.[0] === 'ply:open-remote-hosts');
    const hosts = runPreload('remote-hosts-preload.cjs');
    t.ok('同梱の窓: plyHosts だけ（plyDesktop・plyRemote は無い）', Object.keys(hosts.exposed).join() === 'plyHosts'
      && ['init', 'list', 'pair', 'cancelPair', 'open', 'rename', 'remove', 'onCode', 'onChange'].every(k => typeof hosts.exposed.plyHosts[k] === 'function'));
  }

  // ---------------------------------------------------------------- ほかのホストにつなぐ窓
  {
    const tr = view.translator({ remote: { hosts: { open: '開く', lastConnected: '最後につないだ時刻 {{when}}', state: { connected: 'オンライン', revoked: '取り消されました', closed: '閉じています' }, windowOpen: '窓を開いています', neverConnected: 'まだ' } } });
    t.ok('辞書: 道で引き、desktop: を外し、差し込みを埋め、無ければキー',
      tr('remote.hosts.open') === '開く' && tr('desktop:remote.hosts.open') === '開く' && tr('remote.hosts.lastConnected', { when: 'X' }) === '最後につないだ時刻 X' && tr('remote.nope') === 'remote.nope');
    const on = view.hostLine({ hostId: HOST_ID, name: 'desk', state: 'connected', windowOpen: true }, tr, String);
    const off = view.hostLine({ hostId: HOST_ID, name: 'desk', state: 'closed', lastConnectedAt: 'T' }, tr, String);
    const rv = view.hostLine({ hostId: HOST_ID, name: '', state: 'revoked' }, tr, String);
    t.ok('行: オンラインは丸と文字、窓を開いていればそれも', on.dot === 'on' && on.detail === 'オンライン · 窓を開いています' && on.canOpen);
    t.ok('行: 閉じているホストは中抜きと最後につないだ時刻', off.dot === 'off' && off.detail === '閉じています · 最後につないだ時刻 T');
    t.ok('行: 取り消されたホストは開けない（名前が無ければ hostId）', !rv.canOpen && rv.revoked && rv.name === HOST_ID && rv.detail === '取り消されました');
  }

  // ---------------------------------------------------------------- 画面のバッジ
  {
    const { setupRemoteBadge, badgeView, remoteInfo } = await import('../../web/remote-badge.mjs');
    const mkDoc = () => {
      const html = new N('html'), body = new N('body'), bar = new N('div');
      bar.className = 'titlebar';
      bar.after = (...n) => { const i = body.children.indexOf(bar); for (const c of n) c.parent = body; body.children.splice(i + 1, 0, ...n); };
      body.append(bar);
      const listeners = {};
      return { documentElement: html, body, querySelector: s => body.querySelector(s), addEventListener: (ty, fn) => { (listeners[ty] ??= []).push(fn); }, fire: (ty, e) => (listeners[ty] ?? []).forEach(f => f(e)) };
    };
    t.ok('plyRemote が無ければ描かない（ローカルの窓・ブラウザー版）', setupRemoteBadge({ remote: undefined, doc: mkDoc() }) === null && remoteInfo({}) === null);
    let statusListener = null, closed = 0, retried = 0;
    const remote = { hostId: HOST_ID, hostName: 'desktop-home', relay: 'relay.example.net', device: 'thinkpad', shell: 'desktop',
      status: () => Promise.resolve({ state: 'connected', connectedAt: Date.UTC(2026, 8, 23, 3, 1) }), onStatus: fn => { statusListener = fn; },
      closeWindow: () => { closed++; }, retry: () => { retried++; } };
    const doc = mkDoc();
    const ui = setupRemoteBadge({ remote, doc });
    await new Promise(r => setTimeout(r, 0));
    t.ok('html に .remote を付ける', doc.documentElement.classList.contains('remote'));
    t.ok('バッジは帯の直後（押せる要素。帯は aria-hidden のまま）', doc.body.children[1] === ui.badge && doc.body.children[2] === ui.pop);
    t.ok('バッジ: 「リモート: desktop-home」、つながっている間は状態を添えない', ui.badge.textContent === 'リモート:desktop-home' && ui.badge.getAttribute('aria-expanded') === 'false', ui.badge.textContent);
    t.ok('バッジの title にホスト名', String(ui.badge.attrs.title).includes('desktop-home'));
    t.ok('面: ホスト名・状態・中継・つないだ時刻・この端末', ['desktop-home', '接続中', 'relay.example.net', 'thinkpad'].every(s => ui.pop.textContent.includes(s)) && ui.pop.textContent.includes('つないだ時刻'));
    const [retryBtn, closeBtn] = ui.pop.querySelector('.acts').children;
    t.ok('つながっている間は再試行を出さない', retryBtn.hidden === true);
    ui.badge.onclick({ stopPropagation() {} });
    t.ok('押すと面が開く', ui.pop.hidden === false && ui.badge.getAttribute('aria-expanded') === 'true');
    doc.fire('keydown', { key: 'Escape' });
    t.ok('Esc で閉じる', ui.pop.hidden === true);
    statusListener({ state: 'host-offline' });
    t.ok('ホストがオフライン: バッジに状態を添え、面に再試行', ui.badge.textContent.includes('ホストがオフライン') && retryBtn.hidden === false && ui.badge.attrs['data-state'] === 'host-offline');
    retryBtn.onclick(); closeBtn.onclick();
    t.ok('再試行・この窓を閉じるは plyRemote へ', retried === 1 && closed === 1);
    statusListener({ state: 'revoked' });
    t.ok('取り消し: 再試行は出さない（本体が読み直して案内を出す）', retryBtn.hidden === true && ui.badge.textContent.includes('取り消されました'));
    t.ok('知らない状態は接続中として扱う', badgeView(remoteInfo(remote), { state: 'weird' }).state === 'connected');

    // モバイル版の殻（docs/remote.md §8.2）: 上端のホスト名の帯。押すとホスト一覧へ（面は出さない）
    let backs = 0;
    const mdoc = mkDoc();
    const mobile = setupRemoteBadge({ remote: { hostId: HOST_ID, hostName: 'desktop-home', shell: 'mobile' }, doc: mdoc, back: () => { backs++; } });
    t.ok('モバイル: html に .remote と .remote-mobile', mdoc.documentElement.classList.contains('remote') && mdoc.documentElement.classList.contains('remote-mobile'));
    t.ok('モバイル: 帯は body の先頭、面は作らない', mdoc.body.children[0] === mobile.bar && mobile.pop === null && mobile.bar.children[0] === mobile.badge);
    t.ok('モバイル: 帯にホスト名、読み上げは「ホスト一覧に戻る」', mobile.badge.textContent === 'desktop-home' && String(mobile.badge.attrs['aria-label']).startsWith('ホスト一覧に戻る'), mobile.badge.textContent);
    mobile.badge.onclick();
    await new Promise(r => setTimeout(r, 0));
    t.ok('モバイル: 押すと backToHosts', backs === 1);
    let viaRemote = 0;
    const m2 = setupRemoteBadge({ remote: { hostId: HOST_ID, shell: 'mobile', backToHosts: () => { viaRemote++; } }, doc: mkDoc(), back: () => { backs++; } });
    m2.badge.onclick();
    await new Promise(r => setTimeout(r, 0));
    t.ok('モバイル: plyRemote.backToHosts があればそちら（名前が無ければ hostId の頭）', viaRemote === 1 && backs === 1 && m2.badge.textContent === HOST_ID.slice(0, 8));
    // 塗りなしの H1 配置（2026-09-23）: タイトルの列があれば、タイトルの下に差しの青の添え字「⇄ ホスト名」も置く（700px 以下で見せる）
    const tdoc = mkDoc();
    const col = new N('div');
    col.className = 'title-col';
    tdoc.body.append(col);
    let subBacks = 0;
    const withSub = setupRemoteBadge({ remote: { hostId: HOST_ID, hostName: 'desktop-home', shell: 'mobile', status: () => Promise.resolve({ state: 'host-offline' }) }, doc: tdoc, back: () => { subBacks++; } });
    await new Promise(r => setTimeout(r, 0));
    t.ok('モバイル: タイトルの列の中に添え字（ホスト名と状態）', withSub.sub && col.children.includes(withSub.sub) && withSub.sub.textContent.includes('desktop-home') && withSub.sub.textContent.includes('ホストがオフライン'), withSub.sub?.textContent);
    t.ok('モバイル: 添え字の読み上げは帯のバッジと同じ「ホスト一覧に戻る: …」', String(withSub.sub.attrs['aria-label']).startsWith('ホスト一覧に戻る') && withSub.sub.attrs['aria-label'] === withSub.badge.attrs['aria-label']);
    withSub.sub.onclick();
    await new Promise(r => setTimeout(r, 0));
    t.ok('モバイル: 添え字を押してもホスト一覧へ', subBacks === 1);
    t.ok('モバイル: タイトルの列が無ければ添え字は作らない', mobile.sub === null);
  }

  // ---------------------------------------------------------------- 本体の文言
  {
    try {
      await desktopI18n.initDesktopI18n({ env: { AGENT_HOST_LOCALE: 'en' } });
      const en = desktopI18n.t('remote.windowTitle', { host: 'desk' });
      const enBundle = desktopI18n.bundle();
      await desktopI18n.initDesktopI18n({ env: { AGENT_HOST_LOCALE: 'ja' } });
      const ja = desktopI18n.t('remote.windowTitle', { host: 'desk' });
      t.ok('OS の窓タイトルは言語ごと', en === 'Pleiad — Remote: desk' && ja === 'Pleiad — リモート: desk', `${en} / ${ja}`);
      t.ok('同梱の窓へ渡す辞書は desktop の名前空間を丸ごと', enBundle.lang === 'en' && enBundle.strings.remote?.hosts?.open === 'Open');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-desktop-i18n-'));
      try {
        fs.writeFileSync(path.join(tmp, 'prefs.json'), JSON.stringify({ locale: 'en' }));
        t.ok('画面の言語の設定（prefs.json）を読む', desktopI18n.savedLocaleSetting({ AGENT_HOST_DATA: tmp }) === 'en' && desktopI18n.savedLocaleSetting({ AGENT_HOST_DATA: path.join(tmp, 'none') }) === 'auto');
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    } finally {
      // ほかの試験はサーバーの言語を日本語の前提で見る（tests/run.mjs）
      await desktopI18n.initDesktopI18n({ env: { AGENT_HOST_LOCALE: process.env.AGENT_HOST_LOCALE || 'ja' } });
    }
  }
}
