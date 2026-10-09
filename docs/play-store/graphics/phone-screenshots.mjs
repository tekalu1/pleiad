// Google Play のスマートフォンのスクリーンショット（1080×1920、9:16）を撮る。
// 実行: node docs/play-store/graphics/phone-screenshots.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
//
// 写すものはすべて作り物で、実データには触れない:
//   - 殻の画面（mobile/www。ホストの一覧・ペアリング・通知の設定）は、その場の静的サーバーで配り、ネイティブのプラグイン（PleiadRemote）を
//     ページの中の偽物に差し替える。ホスト名・中継の URL・確認コードは下の DEMO の値
//   - ホストの画面（web/）は、本物のサーバーを fake バックエンド・一時のデータ置き場・空きポートで立てる（tests/lib/server.mjs）。
//     会話は下の CONVERSATIONS の台本（AGENT_HOST_FAKE_VOICE_REPLY。本文が when と同じ発言に steps の台本で返す）。LLM は呼ばない。
//     作業場所は temporary/play-store-demo/<名前>（利用者名を含むパスを写さない）。window.plyRemote を入れて、モバイル版の殻から開いた形にする
// headless の Chromium（405×720、deviceScaleFactor 8/3）で開き、CDP の Page.captureScreenshot で撮る。前面の窓には触れない。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../tests/lib/server.mjs';
import { open } from '../../../tests/lib/ws-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const WWW = path.join(ROOT, 'mobile', 'www');

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64/chrome-headless-shell.exe');
}

// 1080×1920（Play の推奨の 9:16・短い辺 1080 px）
const VIEW = { width: 405, height: 720 };
const SCALE = 8 / 3;

const DEMO = {
  hosts: [
    { hostId: 'demo-host-1', hostName: 'desktop-home', state: 'connected', ago: 3 * 60_000 },
    { hostId: 'demo-host-2', hostName: 'laptop', state: 'closed', ago: 26 * 3600_000 },
  ],
  newHost: 'studio-pc',
  relay: 'wss://relay.example.com',
  code: '482193',
};

// 会話（古い順に作る。一覧は新しい順）。prompt が最初の発言、steps が返事の台本
const CONVERSATIONS = [
  { folder: 'notes-app', title: 'README を整える', prompt: 'README のセットアップの手順を、今の package.json に合わせて書き直して',
    steps: [
      { tool: 'Read', input: { file_path: 'README.md' }, result: '# notes-app\n…', ms: 50 },
      { tool: 'Read', input: { file_path: 'package.json' }, result: '{ "scripts": { … } }', ms: 50 },
      { tool: 'Edit', input: { file_path: 'README.md', old_string: 'npm run serve', new_string: 'npm run dev' }, result: 'ok', ms: 50 },
      { text: 'README の「セットアップ」を直しました。\n\n- 起動のコマンドを `npm run dev` に\n- Node の版を 22 以上に\n- 環境変数の例を `.env.example` へ移した旨を追記' },
    ] },
  { folder: 'notes-app', title: 'ログの出力を見直す', prompt: 'サーバーのログが多すぎるので、起動時のログを整理して',
    steps: [
      { tool: 'Grep', input: { pattern: 'console.log', path: 'src' }, result: 'src/server.ts:12\nsrc/server.ts:40', ms: 50 },
      { text: '起動時の 6 行を 1 行にまとめ、詳しい出力は `DEBUG=1` のときだけ出すようにしました。' },
    ] },
  { folder: 'web-shop', title: '画像の読み込みを速くする', prompt: '商品一覧の画像を遅延読み込みにして', script: 'slow' },
  { folder: 'web-shop', title: 'テストを直す', prompt: 'カートの合計のテストが落ちているので直して',
    steps: [
      { tool: 'Read', input: { file_path: 'src/cart.test.ts' }, result: 'expect(total).toBe(1200)', ms: 50 },
      { tool: 'Edit', input: { file_path: 'src/cart.ts', old_string: 'Math.floor(sum * rate)', new_string: 'Math.round(sum * rate)' }, result: 'ok', ms: 50 },
      { text: '税の計算が切り捨てになっていたので、四捨五入に直しました。テストを流して確かめます。' },
      { tool: 'Bash', input: { command: 'npm test -- cart', description: 'カートのテストを流す' }, ask: true, result: 'PASS src/cart.test.ts', ms: 50 },
      { text: 'テストが通りました。' },
    ] },
];
const APPROVAL = 'テストを直す';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-play-shots-')));
const demoRoot = path.join(ROOT, 'temporary', 'play-store-demo');
for (const c of CONVERSATIONS) fs.mkdirSync(path.join(demoRoot, c.folder), { recursive: true });
const replies = path.join(scratch, 'replies.json');
fs.writeFileSync(replies, JSON.stringify(CONVERSATIONS.map((c) => (c.script ? { when: c.prompt, script: c.script } : { when: c.prompt, steps: c.steps })), null, 2));

// 殻の画面を配る静的サーバー
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const shellServer = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
  const file = path.join(WWW, rel);
  if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => shellServer.listen(0, '127.0.0.1', r));
const SHELL_URL = `http://127.0.0.1:${shellServer.address().port}/`;

const server = await startServer({
  // ホームを作り物の置き場にする（新しい会話の既定の場所やパスの表示が、利用者のホームを指さない）
  env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_FAKE_VOICE_REPLY: replies, USERPROFILE: demoRoot, HOME: demoRoot },
  dataDir: path.join(scratch, 'data'), timeoutMs: 60_000,
});
const HOST_URL = `http://127.0.0.1:${server.port}/?token=${server.token}`;
const admin = await open({ port: server.port, token: server.token });
const browser = await chromium.launch({ executablePath: chromiumPath() });
const shots = [];

async function newPage(init, arg) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  if (init) await page.addInitScript(init, arg);
  return page;
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  // 試験用のバックエンドの名前（Fake (test)）は、一般の呼び名に置き換えて写す
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes('Fake (test)')) n.nodeValue = n.nodeValue.replaceAll('Fake (test)', 'エージェント');
  });
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...VIEW, scale: SCALE } });   // clip の scale が無いと CSS の画素（405×720）で撮られる
  const file = path.join(HERE, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  // 本物の利用者名・パスが写っていないか（見えている字で確かめる。title の吹き出しは写らない）
  const text = await page.evaluate(() => document.body.innerText);
  const leak = [os.userInfo().username, os.hostname(), 'Users\\', '/Users/', 'AppData', ROOT].find((s) => s && text.includes(s));
  if (leak) { const i = text.indexOf(leak); throw new Error(`${name}: 画面に実在の名前・パスが出ている: ${JSON.stringify(text.slice(Math.max(0, i - 80), i + 80))}`); }
  shots.push(path.relative(ROOT, file));
}

/** 殻のネイティブのプラグイン（PleiadRemote）の偽物 */
function fakeShell(demo) {
  const listeners = {};
  const now = Date.now();
  const hosts = demo.hosts.map((h) => ({ hostId: h.hostId, hostName: h.hostName, state: h.state, pairedAt: now - 30 * 86400_000, lastConnectedAt: now - h.ago }));
  const PleiadRemote = {
    addListener(name, fn) { (listeners[name] ||= []).push(fn); return Promise.resolve({ remove() {} }); },
    list: async () => ({ hosts }),
    info: async () => ({ encrypted: true }),
    takePairLink: async () => ({ payload: null }),
    parse: async () => ({ hostId: 'demo-host-3', hostName: demo.newHost, relayUrl: demo.relay, known: false }),
    pair: () => { setTimeout(() => (listeners.pairCode || []).forEach((fn) => fn({ code: demo.code })), 300); return new Promise(() => {}); },
    cancelPair: async () => {},
    open: async () => {},
    notifyState: async () => ({ enabled: true, permission: 'granted', settings: { enabled: true, reply: true, failed: true, done: true, lockNames: false, skipPc: true } }),
  };
  window.Capacitor = { Plugins: { PleiadRemote } };
}

try {
  // ── 殻: ホストの一覧 ──
  let page = await newPage(fakeShell, DEMO);
  await page.goto(SHELL_URL);
  await page.locator('#hosts .host').nth(1).waitFor();
  await shot(page, 'phone-01-hosts');

  // ── 殻: ペアリングの確認コード ──
  await page.locator('#add').click();
  await page.locator('#code').fill('pleiad://pair?demo');
  await page.locator('#usePaste').click();
  await page.waitForFunction(() => document.getElementById('waitCode').textContent.trim().length === 7);
  await shot(page, 'phone-02-pairing-code');
  await page.context().close();

  // ── ホスト: 会話を作る ──
  await admin.cmd('authLogin', { backend: 'fake' }).catch(() => {});
  let approvalId = null;
  for (const c of CONVERSATIONS) {
    const cwd = path.join(demoRoot, c.folder);
    const { sessionId } = await admin.cmd('newSession', { backend: 'fake', cwd });
    await admin.cmd('setTitle', { sessionId, title: c.title });
    const from = admin.mark();
    admin.cmd('runTurn', { sessionId, cwd, prompt: c.prompt }).catch(() => {});
    if (c.title === APPROVAL) { approvalId = sessionId; await admin.waitFor((e) => e.type === 'permission', { from, ms: 30_000 }); }
    else if (c.script === 'slow') await admin.waitFor((e) => e.type === 'activity' || e.type === 'text.delta', { from, ms: 30_000 }).catch(() => {});
    else await admin.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 30_000 });
  }

  // ── ホスト: 承認を待っている会話・会話の一覧 ──
  // 開いている会話を承認待ちの会話にしておく（無いと、ホームのフォルダーで「新しいセッション」の下書きを開く）
  const remote = ({ hostName, current }) => {
    const status = { state: 'connected', connectedAt: Date.now() };
    window.plyRemote = { hostId: 'demo-host-1', hostName, shell: 'mobile', status: () => status, onStatus() {}, backToHosts() {} };
    try { localStorage.setItem('agent-host-current', current); } catch {}
  };
  page = await newPage(remote, { hostName: DEMO.hosts[0].hostName, current: approvalId });
  await page.goto(HOST_URL);
  await page.getByRole('button', { name: 'あとで', exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.getByText('承認を待っている', { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await shot(page, 'phone-04-approval');
  await page.locator('#openSidebar').click();
  await page.locator(`.row[data-session="${approvalId}"]`).waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'phone-03-conversations');
  await page.context().close();

  // ── 殻: 通知の設定 ──
  page = await newPage(fakeShell, DEMO);
  await page.goto(SHELL_URL);
  await page.locator('#notifyOpen').click();
  await page.waitForFunction(() => document.querySelector('#notify .sw[data-opt="enabled"]').getAttribute('aria-checked') === 'true');
  await shot(page, 'phone-05-notification-settings');
  await page.context().close();

  for (const s of shots) console.log(`wrote ${s}`);
} finally {
  await browser.close().catch(() => {});
  admin.close();
  await server.stop().catch(() => {});
  shellServer.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
