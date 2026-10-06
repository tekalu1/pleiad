// 試験用のインストール版（build-installers.mjs で作った PleiadZdTest）を、本物のインストーラー・electron-updater・NSIS で動かす部品。
// 利用者のインストール版には触れない（lib.mjs の assertIsolated が、使う前に名前・場所・ポートが重ならないことを確かめる）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { assertIsolated, cleanEnv, isAlive, processesUnder, ps, repoRoot, sleep, ZD, zdPaths } from './lib.mjs';
import { open as openWs } from '../../../tests/lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const runtimeLib = require('../../../desktop/runtime.cjs');
const { readManifest } = require('../../../desktop/runtime-manifest.cjs');

export { sleep, ZD, processesUnder, isAlive, assertIsolated, ps };
export const BUILDS = path.join(repoRoot, 'temporary', 'zd17');
export const FEED = path.join(BUILDS, 'feed');
export const TOKEN = 'zdtest-fixed-token-5f3a9c71d2e84b60';
// CDP の待ち受けは毎回 OS が選ぶ（"0"）。固定すると、main の Chromium が持つ待ち受けのソケットを detached のサーバーが継承し、古い main が終わっても掴んだままで、新しい main が同じポートを取れない（2026-10-06 に実測）。ポートは userData の DevToolsActivePort
export const DEBUG_PORT = '0';
export const paths = zdPaths(ZD.home);
export const exePath = path.join(ZD.installDir, ZD.exe);
export const VERSIONS = { A: '0.10.2', B: '0.10.3', C: '0.10.4', D: '0.10.5', E: '0.10.6', F: '0.10.7' };
export const installerOf = variant => path.join(BUILDS, variant, `${ZD.productName}-${VERSIONS[variant]}.exe`);

export function writeConfig(extra = {}) {
  fs.mkdirSync(ZD.home, { recursive: true });
  const config = { debugPort: DEBUG_PORT, port: ZD.port, ...extra, env: { AGENT_HOST_TOKEN: TOKEN, AGENT_HOST_BACKENDS: 'fake', ...extra.env } };
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2));
  return config;
}

export class Timeline {
  constructor() { this.start = Date.now(); this.lines = []; }
  mark(label, detail = '') {
    const line = `+${((Date.now() - this.start) / 1000).toFixed(1).padStart(6)}s ${label}${detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`;
    this.lines.push(line);
    console.log(line);
    return Date.now() - this.start;
  }
}

/** 試験用のアプリのプロセス（実行ファイルが $INSTDIR の下）。main は --type が無いもの */
export function appProcesses() {
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${ZD.installDir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }`);
  return r.out.split(/\r?\n/).filter(Boolean).map(line => { const [pid, parent, ...rest] = line.split('|'); const cmd = rest.join('|'); return { pid: Number(pid), parent: Number(parent), cmd, main: !/--type=/.test(cmd) }; });
}
export const mainPids = () => appProcesses().filter(p => p.main).map(p => p.pid);

export function isInstalled() { return fs.existsSync(exePath); }
export function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ZD.installDir, 'resources', 'app', 'package.json'), 'utf8')).version; } catch { return null; }
}

export function install(variant) {
  assertIsolated();
  const started = Date.now();
  const r = spawnSync(installerOf(variant), ['/S', '/currentuser'], { stdio: 'ignore', timeout: 600000 });
  if (r.status !== 0) throw new Error(`installer ${variant} exited ${r.status}`);
  return Date.now() - started;
}

export function uninstall() {
  assertIsolated();
  const uninstaller = path.join(ZD.installDir, `Uninstall ${ZD.productName}.exe`);
  if (!fs.existsSync(uninstaller)) return 0;
  const started = Date.now();
  spawnSync(uninstaller, ['/S', '/currentuser'], { stdio: 'ignore', timeout: 300000 });
  // アンインストーラーは一時の場所へ自分を写して起動し直し、元はすぐ戻る。インストール先が消えるのを待つ
  const until = Date.now() + 120000;
  while (fs.existsSync(path.join(ZD.installDir, ZD.exe)) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  return Date.now() - started;
}

/** 試験用の置き場（データ・実行場所・userData・記録）を空にする。設定（config.json）は残す。アプリが動いていないときだけ */
export function resetHome() {
  assertIsolated();
  for (const dir of [paths.data, paths.runtime, paths.userData]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.rmSync(path.join(ZD.home, 'entry.log'), { force: true });
}

/** 利用者の操作（ショートカットを押す）に近い起動: 環境変数は試験用に洗ったものだけ */
export function startMain(extraEnv = {}) {
  const child = spawn(exePath, [], { cwd: ZD.installDir, detached: true, stdio: 'ignore', env: cleanEnv(extraEnv), windowsHide: false });
  child.unref();
  return child.pid;
}

/** main だけを止める（タスクマネージャーで main の行を「タスクの終了」するのに近い。木ごとは止めない） */
export function killMain(pid) { ps(`Stop-Process -Id ${pid} -Force`); }

export const readControl = () => { try { return JSON.parse(fs.readFileSync(path.join(paths.data, 'control.json'), 'utf8')); } catch { return null; } };
export const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export async function waitFor(fn, { ms = 60000, every = 500, what = 'condition' } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what} (${ms} ms)`);
    await sleep(every);
  }
}

/** 更新の配信元に variant の latest.yml・インストーラー・blockmap だけを置く */
export function feedUse(variant) {
  fs.rmSync(FEED, { recursive: true, force: true });
  fs.mkdirSync(FEED, { recursive: true });
  const dir = path.join(BUILDS, variant);
  for (const file of fs.readdirSync(dir)) if (/^(latest\.yml|.*\.exe|.*\.exe\.blockmap)$/.test(file) && !/__uninstaller/.test(file)) fs.copyFileSync(path.join(dir, file), path.join(FEED, file));
}

export function startFeed() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const file = path.join(FEED, path.basename(decodeURIComponent(req.url.split('?')[0])));
    hits.push(`${req.method} ${req.url}`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const stat = fs.statSync(file);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise(resolve => server.listen(ZD.feedPort, '127.0.0.1', () => resolve({ hits, close: () => new Promise(done => server.close(done)) })));
}

/** 画面（Electron の窓）への CDP。entry.cjs の debugPort。page は origin で選ぶ */
export async function cdp(match = () => true) {
  const port = Number(fs.readFileSync(path.join(paths.userData, 'DevToolsActivePort'), 'utf8').split(String.fromCharCode(10))[0]);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const page = list.find(item => item.type === 'page' && match(item));
  if (!page) throw new Error(`no page: ${JSON.stringify(list.map(item => item.url))}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0; const pending = new Map(); const listeners = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else listeners.forEach(fn => fn(m));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  return {
    page, send, on: fn => listeners.push(fn), close: () => ws.close(),
    eval: async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    screenshot: async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
  };
}
export const originMatch = port => item => item.url.startsWith(`http://127.0.0.1:${port}/`);

export const wsOpenServer = async (control = readControl()) => openWs({ port: new URL(control.origin).port, token: TOKEN });

export function copyLogs(dest) {
  fs.mkdirSync(dest, { recursive: true });
  const copy = (from, name) => { try { fs.copyFileSync(from, path.join(dest, name)); } catch { /* 無ければ飛ばす */ } };
  copy(path.join(ZD.home, 'entry.log'), 'entry.log');
  copy(path.join(paths.userData, 'logs', 'updater.log'), 'updater.log');
  copy(path.join(paths.runtime, 'logs', 'server.log'), 'server.log');
  copy(path.join(paths.data, 'control.json'), 'control.json');
}

export const sessionsOf = async client => (await client.cmd('listSessions', {})) ?? [];

/** 試験用のアプリが動いていれば止め（アンインストール前）、アンインストール・置き場の掃除・再インストール・設定の書き込みをする */
export async function freshInstall({ variant = 'A', feed = 'B', config = {}, tl = new Timeline() } = {}) {
  assertIsolated();
  for (const p of appProcesses()) killMain(p.pid);
  const server = readControl();
  if (server?.pid && isAlive(server.pid)) ps(`Stop-Process -Id ${server.pid} -Force`);
  for (const p of processesUnder([paths.runtime])) ps(`Stop-Process -Id ${p.pid} -Force`);
  await sleep(1500);
  if (isInstalled()) tl.mark('uninstall', `${uninstall()} ms`);
  resetHome();
  // 夜の整理（メモリの学習。本物のエージェントを呼び、利用者の会話の履歴から記憶を作る）は、試験の最中に走らせない（試験用のデータ置き場の設定で止める）
  fs.mkdirSync(paths.data, { recursive: true });
  fs.writeFileSync(path.join(paths.data, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));
  const written = writeConfig(config);
  tl.mark('install', `${variant} ${install(variant)} ms`);
  const tree = await verifyInstalledTree();
  tl.mark('installed tree matches manifest', { ok: tree.ok, missing: tree.missing?.length ?? 0, sizeMismatch: tree.sizeMismatch?.length ?? 0 });
  if (!tree.ok) throw new Error(`the installed tree does not match its manifest: ${JSON.stringify(tree).slice(0, 400)}`);
  feedUse(feed);
  return written;
}

/** main を起こして、サーバーの ready（control.json）と窓を待つ。{ control, page } */
export async function bootApp(tl, { page = true, ui = true } = {}) {
  const pid = startMain();
  tl.mark('main started', { pid });
  const control = await waitFor(() => { const c = readControl(); return c?.origin && isAlive(c.pid) ? c : null; }, { ms: 90000, what: 'control.json' });
  tl.mark('server ready', { pid: control.pid, origin: control.origin, appVersion: control.appVersion });
  const view = page ? await waitFor(() => cdp(originMatch(new URL(control.origin).port)).catch(() => null), { ms: 60000, what: 'window' }) : null;
  if (view) tl.mark('window', view.page.url.replace(/token=[^&]+/, 'token=…'));
  if (view && ui) {
    // main の boot() が終わるのを待つ（updates.json は更新の部品が初期化された後に書かれる）。窓の読み込み中に CDP で読み直すと loadURL が失敗し、boot() が途中で止まる
    await waitFor(() => fs.existsSync(path.join(paths.userData, 'updates.json')), { ms: 60000, every: 500, what: 'main boot (updates.json)' });
    // fake にログインして、最初の案内の枠を閉じる（枠が待ちの表示などの上に重なって写らないように）
    const client = await wsOpenServer(control);
    await client.cmd('authLogin', { backend: 'fake' }).catch(() => {});
    client.close();
    await view.send('Page.reload');
    await sleep(3000);
    await view.eval(`document.querySelector('#closeOnboarding')?.click()`).catch(() => {});
    await sleep(500);
  }
  return { mainPid: pid, control, page: view };
}

export const FAKE_TURN = (ms, extra = []) => `steps:${JSON.stringify({ steps: [{ tool: 'Bash', input: {}, result: 'ok', ms }, ...extra, { text: 'done' }] })}`;

/** インストールされた resources\app が、配布物の manifest と一致するか（NSIS が黙って落としたファイルが無いか） */
export async function verifyInstalledTree() {
  const appDir = path.join(ZD.installDir, 'resources', 'app');
  return runtimeLib.verifyTree(appDir, await readManifest(appDir), { deep: false });
}

/** 窓を PrintWindow で撮る（printwindow.ps1。前面の窓を奪わない）。CDP が使えない更新後の main の画面を見る */
export function shot(pid, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'printwindow.ps1');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-ProcessId', String(pid), '-Out', file], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').trim();
}

/** CDP の窓が見つかるまで ms 待つ。見つからなければ null（更新後の main で開かない場合がある） */
export async function tryCdp(port, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const view = await cdp(originMatch(port)).catch(() => null);
    if (view) return view;
    if (Date.now() > until) return null;
    await sleep(1000);
  }
}

/** main のログ（userData の logs\updater.log）の行のうち、パターンに合うもの */
export function updaterLog(pattern) {
  try { return fs.readFileSync(path.join(paths.userData, 'logs', 'updater.log'), 'utf8').split(/\r?\n/).filter(line => pattern.test(line)); } catch { return []; }
}

/** 画面で承認に答える（会話の行を開いて「許可」を押す）。押せたら true。画面を持たない・承認の札が無ければ false */
export async function allowInUi(view, sessionId) {
  const expression = `(async () => {
    const row = document.querySelector('[data-session="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    if (!row) return 'no row';
    row.click();
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const button = [...document.querySelectorAll('button.btn-primary')].find(b => b.textContent.trim() === ${JSON.stringify('許可')} && !b.disabled);
      if (button) { button.click(); return 'clicked'; }
    }
    return 'no button';
  })()`;
  return view.eval(expression).catch(error => `error ${error.message}`);
}

/** 入力欄（#prompt。Markdown の編集欄）に字を書く。書いた後の欄の字を返す */
export async function typeDraft(view, text) {
  await view.eval(`(() => { const p = document.querySelector('#prompt'); const target = p.querySelector('[contenteditable="true"]') ?? p; target.focus(); return true; })()`);
  await view.send('Input.insertText', { text });
  return view.eval(`document.querySelector('#prompt')?.innerText ?? ''`);
}
