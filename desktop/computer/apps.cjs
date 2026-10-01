'use strict';
// アプリ（exe・AUMID）の特定。点の下の窓・前面の窓 → プロセス → AppInfo（docs/computer-use.md の AppInfo）。
// 名前での検索（findApp）と起動（launch）もここ。実行ファイルの識別は Codex の computer_use の考え方（AUMID か実行ファイル）に倣う。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ComputerError } = require('./errors.cjs');

const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const DESCRIPTION_CACHE_MAX = 300;
const START_APPS_TTL_MS = 5 * 60_000;
const LAUNCH_WAIT_MS = 8000;
const PARENTS_TTL_MS = 5000;

const normalizePath = p => p.toLowerCase().replace(/\\/g, '/');
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().trim();
const exeBase = p => (p ? path.win32.basename(p).replace(/\.exe$/i, '').toLowerCase() : '');

/** Get-StartApps の AppID にある既知のフォルダー（GUID）の展開先 */
function knownFolders(env) {
  const windir = env.SystemRoot || env.windir || 'C:\\Windows';
  const x64 = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  return {
    '1ac14e77-02e7-4e5d-b744-2eb1ae5198b7': path.win32.join(windir, 'System32'),
    'd65231b0-b2f1-4857-a4ce-a8e7c6ea7d27': path.win32.join(windir, 'SysWOW64'),
    'f38bf404-1d43-42f2-9305-67de0b28fc23': windir,
    '905e63b6-c1bf-494e-b29c-65b732d3d21a': env.ProgramFiles || x64,
    '6d809377-6af0-444b-8957-a3773f02200e': x64,
    '7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e': env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'f1b32785-6fba-4fcf-9d55-7b8e7f157091': env.LOCALAPPDATA || '',
    '3eb685db-65f9-4cf6-a03a-e3ef65729f3d': env.APPDATA || '',
    '62ab5d82-fdc1-4dc3-a9dd-070d1d495d97': env.ProgramData || 'C:\\ProgramData',
  };
}

/** スタートメニューのアプリの一覧（Get-StartApps）。COM を使わずに済ませる。失敗したら空 */
function defaultListStartApps() {
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve([]);
        try {
          const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '[]');
          resolve((Array.isArray(parsed) ? parsed : [parsed]).filter(e => e?.Name && e?.AppID).map(e => ({ name: String(e.Name), appId: String(e.AppID) })));
        } catch { resolve([]); }
      });
  });
}

function createApps({ win32, selfPid = process.pid, selfExe = process.execPath, listStartApps = defaultListStartApps, env = process.env,
  exists = fs.existsSync, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  const descriptions = new Map(); // exe のパス → FileDescription（無ければ ''）
  let startCache = null;
  const folders = knownFolders(env);

  async function describe(exePath) {
    const key = exePath.toLowerCase();
    if (descriptions.has(key)) return descriptions.get(key);
    let text = '';
    try { text = (await win32.fileDescription(exePath)) || ''; } catch { /* 読めない（アクセス拒否など）。名前は窓のタイトルへ */ }
    if (descriptions.size >= DESCRIPTION_CACHE_MAX) descriptions.delete(descriptions.keys().next().value);
    descriptions.set(key, text);
    return text;
  }

  // pid → 親の pid は取るのに 40ms ほどかかるので、短く使い回す（知らない pid が来たら取り直す）
  let parentsCache = null;
  const parentMap = fresh => {
    if (fresh || !parentsCache || now() - parentsCache.at > PARENTS_TTL_MS) parentsCache = { at: now(), map: win32.processParents() };
    return parentsCache.map;
  };

  /** Pleiad 自身か: 同じ pid・同じ exe・Pleiad の子孫のプロセス */
  function isSelf(pid, exePath) {
    if (pid === selfPid) return true;
    if (exePath && selfExe && exePath.toLowerCase() === selfExe.toLowerCase()) return true;
    for (const fresh of [false, true]) {
      const parents = parentMap(fresh);
      if (!parents.has(pid)) { if (fresh) return false; continue; }
      for (let cur = pid, hops = 0; cur && hops < 32; hops++) {
        const parent = parents.get(cur);
        if (!parent || parent === cur) return false;
        if (parent === selfPid) return true;
        cur = parent;
      }
      return false;
    }
    return false;
  }

  /** 窓の持ち主のプロセス。UWP は ApplicationFrameHost の枠の中の窓が本物のプロセス */
  function resolveProcess(hwnd) {
    const info = win32.windowInfo(hwnd);
    let pid = info.pid;
    let exePath = pid ? win32.processPath(pid) : null;
    if (exePath && path.win32.basename(exePath).toLowerCase() === 'applicationframehost.exe') {
      for (const child of win32.childWindows(hwnd)) {
        const childPid = win32.windowInfo(child).pid;
        if (childPid && childPid !== pid) { pid = childPid; exePath = win32.processPath(pid) ?? exePath; break; }
      }
    }
    return { info, pid, path: exePath, aumid: pid ? win32.processAumid(pid) : null };
  }

  /** 入力の前の判定に使う軽い版（名前の取得をしない） */
  function inspect(hwnd) {
    if (!hwnd) return null;
    const p = resolveProcess(hwnd);
    if (!p.pid) return null;
    return { pid: p.pid, path: p.path, elevated: win32.processElevated(p.pid) ?? true, self: isSelf(p.pid, p.path) };
  }

  async function appFromHwnd(hwnd) {
    if (!hwnd) return null;
    const p = resolveProcess(hwnd);
    if (!p.pid || (!p.path && !p.aumid)) return null;
    const description = p.path ? await describe(p.path) : '';
    return {
      id: p.aumid ? `aumid:${p.aumid}` : `exe:${normalizePath(p.path)}`,
      kind: p.aumid ? 'aumid' : 'exe',
      name: description || p.info.title || (p.path ? path.win32.basename(p.path, path.win32.extname(p.path)) : p.aumid),
      ...(p.path ? { path: p.path } : {}),
      ...(p.aumid ? { aumid: p.aumid } : {}),
      pid: p.pid,
      elevated: win32.processElevated(p.pid) ?? true,
      self: isSelf(p.pid, p.path),
    };
  }

  const clickThrough = info => (info.exStyle & WS_EX_TRANSPARENT) !== 0 && (info.exStyle & WS_EX_LAYERED) !== 0;

  /** 点の下にあって、クリックを受け取る最上位の窓（クリックを通す窓は飛ばす） */
  function rootWindowAt(x, y) {
    const hit = win32.windowAt(x, y);
    const root = hit ? (win32.rootOf(hit) || hit) : 0;
    if (root && !clickThrough(win32.windowInfo(root))) return root;
    for (const hwnd of win32.topLevelWindows()) { // Z 順の上から、点を含む窓を探す
      const info = win32.windowInfo(hwnd);
      if (!info.visible || info.cloaked || info.iconic || clickThrough(info) || !info.rect) continue;
      const r = info.rect;
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return hwnd;
    }
    return root;
  }

  const appAt = (x, y) => appFromHwnd(rootWindowAt(x, y));
  const foreground = () => { const hwnd = win32.foreground(); return appFromHwnd(hwnd ? (win32.rootOf(hwnd) || hwnd) : 0); };
  const inspectAt = (x, y) => inspect(rootWindowAt(x, y));
  const inspectForeground = () => { const hwnd = win32.foreground(); return inspect(hwnd ? (win32.rootOf(hwnd) || hwnd) : 0); };

  /** 見えていて名前のある最上位の窓ごとのアプリ（Z 順の上が先）。_hwnd は前に出すときの窓 */
  async function runningApps() {
    const found = new Map();
    for (const hwnd of win32.topLevelWindows()) {
      const info = win32.windowInfo(hwnd);
      if (!info.visible || info.cloaked || !info.title || (info.exStyle & WS_EX_TOOLWINDOW)) continue;
      const app = await appFromHwnd(hwnd);
      if (app && !found.has(app.id)) found.set(app.id, { ...app, _hwnd: hwnd });
    }
    return [...found.values()];
  }

  function startEntry({ name, appId }) {
    let exePath = null;
    const guid = /^\{([0-9a-f-]{36})\}\\(.+)$/i.exec(appId);
    if (guid && folders[guid[1].toLowerCase()]) exePath = path.win32.join(folders[guid[1].toLowerCase()], guid[2]);
    else if (/^[a-z]:\\/i.test(appId)) exePath = appId;
    if (exePath && /\.exe$/i.test(exePath)) {
      return { id: `exe:${normalizePath(exePath)}`, kind: 'exe', name, path: exePath, elevated: false, self: !!selfExe && exePath.toLowerCase() === selfExe.toLowerCase() };
    }
    return { id: `aumid:${appId}`, kind: 'aumid', name, aumid: appId, elevated: false, self: false };
  }

  async function startApps() {
    if (!startCache || now() - startCache.at > START_APPS_TTL_MS) {
      let entries = [];
      try { entries = await listStartApps(); } catch { /* 空のまま */ }
      startCache = { at: now(), apps: entries.map(startEntry) };
    }
    return startCache.apps;
  }

  function score(app, query) {
    const name = norm(app.name), base = exeBase(app.path), aumid = norm(app.aumid);
    const q = query.replace(/\.exe$/i, '');
    if (q === name || q === base || q === aumid || query === norm(app.id)) return 100;
    if (name.startsWith(q)) return 80;
    if (base && base.startsWith(q)) return 75;
    if (name.includes(q)) return 60;
    if (base && base.includes(q)) return 55;
    if (aumid && aumid.includes(q)) return 40;
    return 0;
  }

  const publicApp = ({ _hwnd, ...app }) => app;

  /** 動いているものとスタートメニューのアプリから、名前（表示名・exe 名・AUMID）に当たるものを強い順に */
  async function findApp(name) {
    const query = norm(name);
    if (!query) return [];
    const running = await runningApps();
    const known = new Set(running.map(a => a.id));
    const candidates = [...running.map(a => ({ app: a, bonus: 5 })), ...(await startApps()).filter(a => !known.has(a.id)).map(a => ({ app: a, bonus: 0 }))];
    return candidates
      .map(({ app, bonus }) => ({ app, score: score(app, query) + (score(app, query) ? bonus : 0) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(c => publicApp(c.app));
  }

  function launchTarget(app) {
    if (!app || typeof app !== 'object') throw new ComputerError('not_found', 'no app');
    if (app.kind === 'aumid') {
      if (!app.aumid || /[\u0000-\u001f"<>|]/.test(app.aumid)) throw new ComputerError('not_found', 'invalid AUMID');
      return { target: `shell:AppsFolder\\${app.aumid}`, dir: null };
    }
    if (app.kind === 'exe') {
      if (!app.path || !/\.exe$/i.test(app.path) || !path.win32.isAbsolute(app.path) || !exists(app.path)) throw new ComputerError('not_found', `executable not found: ${app.path ?? ''}`);
      return { target: app.path, dir: path.win32.dirname(app.path) };
    }
    throw new ComputerError('not_found', 'unknown app kind');
  }

  /** @returns {Promise<{ started: boolean, alreadyRunning: boolean, app: object }>} */
  async function launch(app) {
    const { target, dir } = launchTarget(app);
    const running = (await runningApps()).find(a => a.id === app.id);
    if (running) {
      let foregrounded = false;
      try { foregrounded = win32.activate(running._hwnd); } catch { /* 前に出せなくても動いている */ }
      return { started: false, alreadyRunning: true, foregrounded, app: publicApp(running) };
    }
    const opened = await win32.shellOpen(target, dir);
    if (!opened.ok) throw new ComputerError(opened.code === 2 || opened.code === 3 ? 'not_found' : 'failed', `ShellExecute failed (${opened.code})`);
    for (let waited = 0; waited < LAUNCH_WAIT_MS; waited += 250) { // 窓が出るまで待つ（出ない常駐アプリもある）
      await sleep(250);
      const hit = (await runningApps()).find(a => a.id === app.id);
      if (hit) return { started: true, alreadyRunning: false, app: publicApp(hit) };
    }
    return { started: true, alreadyRunning: false, app };
  }

  return { appAt, foreground, inspectAt, inspectForeground, inspect, findApp, launch, isSelf, runningApps };
}

module.exports = { createApps, defaultListStartApps, normalizePath };
