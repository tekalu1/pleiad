// 設定 › リモートと常駐（docs/remote.md §6.1・§6.3、issue #13 の画面側）。
//   - 画面の小さな部品（web/remote.mjs）: 確認コードの区切り・残り時間・QR の点・状態の一行・端末の行
//   - 常駐の設定（core/remote/resident.mjs）: 既定・丸め・保存・main へ送る状態
//   - main の常駐（desktop/resident.cjs）: トレイの出し入れ・スリープの抑止・窓を閉じたときの扱い（Electron は差し替える）
//   - サーバー: RemoteStatus.resident と setRemoteResident（fake のサーバーを別プロセスで立てる）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCode, remaining, qrPath, connectionLine, deviceLine, platformName } from '../../web/remote.mjs';
import { normalizeResident, residentSignal, createResidentPrefs, DEFAULT_RESIDENT } from '../../core/remote/resident.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { createResident, sleepWanted, keepRunning } = require('../../desktop/resident.cjs');

export const name = 'remote-settings';
export const title = '設定 › リモートの部品と、ホストとしての常駐（トレイ・スリープ）';

/** Electron の Tray / Menu / powerSaveBlocker と窓の身代わり */
function fakes() {
  const log = [];
  let next = 0;
  const started = new Set();
  class Tray {
    constructor(icon) { this.icon = icon; this.handlers = {}; log.push('tray'); Tray.live = this; }
    on(name, fn) { this.handlers[name] = fn; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { log.push('tray-destroy'); if (Tray.live === this) Tray.live = null; }
  }
  const Menu = { buildFromTemplate: items => ({ items }) };
  const powerSaveBlocker = {
    start(type) { const id = ++next; started.add(id); log.push(`block:${type}`); return id; },
    stop(id) { started.delete(id); log.push('unblock'); },
    isStarted: id => started.has(id),
  };
  const window = { visible: true, minimized: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; }, show() { this.visible = true; log.push('show'); }, focus() {}, hide() { this.visible = false; } };
  return { Tray, Menu, powerSaveBlocker, window, log, started };
}

export default async function (t) {
  // ---- 画面の部品
  t.ok('確認コードは 3 桁ずつ', formatCode('482193') === '482 193' && formatCode('12') === '12' && formatCode(null) === '');
  const now = Date.parse('2026-09-23T10:00:00Z');
  t.ok('残り時間は m:ss、過ぎたら 0:00', remaining('2026-09-23T10:04:32Z', now) === '4:32' && remaining('2026-09-23T09:59:00Z', now) === '0:00' && remaining('bad', now) === '0:00');
  const payload = 'pleiad://pair?v=1&r=https%3A%2F%2Frelay.example.com&h=abcdefghijklmnopqrstuvwxyz&k=' + 'A'.repeat(43) + '&s=' + 'B'.repeat(43) + '&n=desktop-home';
  const qr = qrPath(payload);
  // 余白 4 マスの内側の左上に位置合わせの模様（7×7 の外周）がある
  const cells = new Set([...qr.d.matchAll(/M(\d+) (\d+)/g)].map(m => `${m[1]},${m[2]}`));
  const finder = [0, 1, 2, 3, 4, 5, 6].every(i => cells.has(`${4 + i},4`) && cells.has(`4,${4 + i}`) && cells.has(`${4 + i},10`) && cells.has(`10,${4 + i}`));
  t.ok('QR は余白込みの正方形で、左上に位置合わせの模様がある', qr.size >= 29 + 8 && (qr.size - 8 - 17) % 4 === 0 && finder && !cells.has('5,5'), String(qr.size));
  t.ok('長い文字列ほど大きい型になる', qrPath('x').size < qr.size);
  t.ok('無効なら「リモートは無効です」', connectionLine({ enabled: false, connection: { state: 'disabled' } }).text === 'リモートは無効です');
  t.ok('つながっていれば端末の接続数も言う', connectionLine({ connection: { state: 'connected' }, devices: [{ connected: true }, { connected: false }] }).text === '中継につながっています · 端末 1 台が接続中');
  const failed = connectionLine({ connection: { state: 'error', error: { code: 'config', message: '中継の URL を確かめてください' } } });
  t.ok('つながらないときは理由を添えて強い字', failed.strong && failed.text === '中継につながりません · 中継の URL を確かめてください', failed.text);
  const retry = connectionLine({ connection: { state: 'retrying', error: { message: 'x' }, retryAt: '2026-09-23T10:00:30Z' } }, now);
  t.ok('つなぎ直しを待つ間は次に試す時刻も出す', retry.strong && retry.text.startsWith('中継につながりません · x（') && retry.text.endsWith('にもう一度試します）'), retry.text);
  t.ok('端末の種類は名前にし、知らない値はそのまま', platformName('android') === 'Android' && platformName('ios') === 'iPhone' && platformName('toaster') === 'toaster');
  const line = deviceLine({ platform: 'desktop', createdAt: '2026-09-20T01:00:00Z', lastSeenAt: new Date(now - 180_000).toISOString() }, now);
  t.ok('端末の行: 種類 · 追加した日 · 最後に使った時刻', /^デスクトップ · 追加 2026\/9\/2\d · 最後に使った 3分前$/.test(line), line);
  t.ok('まだ使っていない端末', deviceLine({ platform: 'android', createdAt: null, lastSeenAt: null }, now) === 'Android · まだ使っていません');

  // ---- 常駐の設定
  t.ok('既定は「窓を閉じても続ける」「作業中だけ防ぐ」', DEFAULT_RESIDENT.keepRunning === true && DEFAULT_RESIDENT.sleep === 'working');
  t.ok('知らない値は既定に丸める', JSON.stringify(normalizeResident({ keepRunning: 'yes', sleep: 'never' })) === JSON.stringify(DEFAULT_RESIDENT)
    && normalizeResident({ keepRunning: false, sleep: 'off' }).sleep === 'off');
  const status = { enabled: true, connection: { state: 'connected' }, devices: [{ connected: true }, { connected: true }, { connected: false }] };
  const idle = residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [], permissions: [], count: 0 }, locale: 'ja' });
  t.ok('main へ送る状態: リモート・接続中の端末・中継の状態', idle.remote && idle.devices === 2 && idle.relay === 'connected' && !idle.working && idle.locale === 'ja', JSON.stringify(idle));
  const waiting = residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [], permissions: [{ relay: false }, { relay: true }], count: 1 } });
  t.ok('承認待ちがあれば作業中（中継の複製は数えない）', waiting.working && waiting.waiting === 1 && waiting.running === 0);
  t.ok('ターンが走っていれば作業中', residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [{}], permissions: [], count: 1 } }).working);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-resident-')));
  try {
    const prefs = createResidentPrefs({ dataDir: scratch });
    await prefs.loaded;
    t.ok('ファイルが無ければ既定', prefs.get().keepRunning === true && prefs.get().sleep === 'working');
    await prefs.set({ sleep: 'always' });
    await prefs.set({ keepRunning: false });
    const again = createResidentPrefs({ dataDir: scratch });
    await again.loaded;
    t.ok('保存して読み直せる（続けて変えても両方残る）', again.get().keepRunning === false && again.get().sleep === 'always', JSON.stringify(again.get()));
    let threw = false;
    try { prefs.set({ sleep: 'sometimes' }); } catch { threw = true; }
    t.ok('知らないスリープの規則は受け付けない', threw);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- main の常駐
  const matrix = [['working', false, false], ['working', true, true], ['always', false, true], ['off', true, false]];
  t.ok('スリープ: 作業中だけ / リモートが有効な間 / 防がない', matrix.every(([sleep, working, want]) => sleepWanted({ remote: true, sleep, working }) === want)
    && !sleepWanted({ remote: false, sleep: 'always', working: true }));
  t.ok('窓を閉じても続けるのは、リモートが有効で設定がオンのときだけ', keepRunning({ remote: true, keepRunning: true }) && !keepRunning({ remote: false, keepRunning: true }) && !keepRunning({ remote: true, keepRunning: false }));

  const f = fakes();
  let quits = 0;
  const r = createResident({ Tray: f.Tray, Menu: f.Menu, powerSaveBlocker: f.powerSaveBlocker, icon: 'icon.png', getWindow: () => f.window, quit: () => { quits++; }, platform: 'win32' });
  r.update({ remote: false, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 0, relay: 'disabled', locale: 'ja' });
  t.ok('リモートが無効ならトレイも抑止も無く、窓を閉じれば今までどおり終わる', !r.hasTray && !r.blocking && !r.keepOnClose());
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 1, relay: 'connected', locale: 'ja' });
  t.ok('リモートを有効にするとトレイに残り、窓を閉じても続ける', r.hasTray && r.keepOnClose() && !r.blocking);
  const items = f.Tray.live.menu.items;
  t.ok('トレイのメニュー: 状態・開く・終了', items[0].label === '中継 つながっている · 接続中の端末 1 · 実行中 0' && items[0].enabled === false
    && items[2].label === 'Pleiad を開く' && items[3].label === '終了', items.map(i => i.label).join(' / '));
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: true, running: 1, devices: 1, relay: 'connected', locale: 'en' });
  t.ok('作業中はスリープを防ぐ（prevent-app-suspension）', r.blocking && f.log.includes('block:prevent-app-suspension'));
  t.ok('トレイの文言は言語に従う', f.Tray.live.menu.items[0].label === 'Relay connected · Devices online 1 · Running 1', f.Tray.live.menu.items[0].label);
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 1, relay: 'connected', locale: 'en' });
  t.ok('作業が終われば抑止をやめる', !r.blocking && f.started.size === 0);
  f.window.hide();
  f.Tray.live.handlers.click();
  t.ok('トレイを押すと窓を出す', f.window.visible);
  f.window.hide();
  f.Tray.live.menu.items[3].click();
  t.ok('「終了」は窓を出してから main の確認付きの終了へ', quits === 1 && f.window.visible);
  f.window.hide();
  r.update({ remote: false, keepRunning: true, sleep: 'always', working: true, running: 0, devices: 0, relay: 'disabled', locale: 'en' });
  t.ok('リモートを無効にするとトレイを消し、隠れていた窓を出し直す', !r.hasTray && f.window.visible && !r.blocking);
  r.update({ remote: true, keepRunning: false, sleep: 'always', working: false, running: 0, devices: 0, relay: 'connected', locale: 'en' });
  t.ok('続ける設定がオフでも「常に防ぐ」は効く', !r.hasTray && !r.keepOnClose() && r.blocking);
  r.dispose();
  t.ok('終了時に抑止を解く', !r.blocking && f.started.size === 0);

  const dicts = Object.fromEntries(await Promise.all(['ja', 'en'].map(async l => [l, JSON.parse(await fs.readFile(new URL(`../../web/locales/${l}/desktop.json`, import.meta.url), 'utf8'))])));
  t.ok('トレイの中継の状態はすべての状態に訳がある', ['disabled', 'connecting', 'connected', 'retrying', 'error'].every(s => dicts.ja.resident.relay[s] && dicts.en.resident.relay[s]));

  // ---- サーバー
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-settings-')));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const s0 = await c.cmd('remoteStatus');
    t.ok('RemoteStatus に常駐の設定が載る（npm start のホストでは使わない）', s0.resident?.available === false && s0.resident.keepRunning === true && s0.resident.sleep === 'working', JSON.stringify(s0.resident));
    const from = c.mark();
    const s1 = await c.cmd('setRemoteResident', { sleep: 'off', keepRunning: false });
    t.ok('setRemoteResident で変えられ、状態を丸ごと返す', s1.resident.sleep === 'off' && s1.resident.keepRunning === false && s1.connection?.state === 'disabled');
    const ev = await c.waitFor(e => e.type === 'remoteStatus' && e.status.resident?.sleep === 'off', { from, ms: 5000 }).catch(() => null);
    t.ok('変えるとほかの画面にも remoteStatus が届く', Boolean(ev));
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'resident.json'), 'utf8'));
    t.ok('設定は <data>/remote/resident.json に残る', saved.sleep === 'off' && saved.keepRunning === false);
    const bad = await c.cmd('setRemoteResident', { sleep: 'sometimes' }).then(() => null, e => e);
    t.ok('知らない規則は断る', Boolean(bad));
    t.ok('常駐の設定を変えても中継の設定は触らない', (await c.cmd('remoteStatus')).enabled === false);
  } finally {
    c.close?.();
    await server.stop?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
