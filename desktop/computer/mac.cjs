'use strict';
// darwin の部品（ADR 0173）。win32.cjs の表の代わりに、service.cjs が使う backend（input・capture・apps・desktop・cursor・listDisplays）を作る。
// 座標は CoreGraphics のグローバル座標（point）。Electron の screen（mac では DIP = point）と CGEvent と CGDisplayBounds が同じ値で話す。
// 撮影・入力・アプリはヘルパー（mac-helper.cjs）に頼む。許可（TCC）が無いと言われたら、OS の確認を頼み、システム設定のペインを開く。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ComputerError } = require('./errors.cjs');
const { createHelperClient } = require('./mac-helper.cjs');
const { createMacInput } = require('./mac-input.cjs');
const { createMacApps } = require('./mac-apps.cjs');
const { fitScale } = require('./capture.cjs');
const { pickDisplay } = require('./displays.cjs');

const HELPER_NAME = 'pleiad-computer-helper';
const PERMISSION_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
const PERMISSION_OPEN_INTERVAL_MS = 60_000;

/** ヘルパーの置き場所の候補（パッケージは Contents/Helpers、ソースからは Swift のビルドの出力） */
function helperCandidates({ resourcesPath = process.resourcesPath, isPackaged = false, dir = __dirname } = {}) {
  const list = [];
  if (isPackaged && resourcesPath) list.push(path.join(resourcesPath, '..', 'Helpers', HELPER_NAME));
  const mac = path.join(dir, 'mac');
  list.push(path.join(mac, 'dist', HELPER_NAME), path.join(mac, '.build', 'apple', 'Products', 'Release', HELPER_NAME), path.join(mac, '.build', 'release', HELPER_NAME));
  return list;
}

/** Electron の screen → displays.cjs の listDisplays と同じ形（主ディスプレイが 1、残りは左から右・上から下）。bounds は point */
function listMacDisplays(screen) {
  const primaryId = screen.getPrimaryDisplay?.()?.id;
  const all = screen.getAllDisplays().map(d => ({ d, primary: d.id === primaryId }));
  all.sort((a, b) => (b.primary - a.primary) || (a.d.bounds.x - b.d.bounds.x) || (a.d.bounds.y - b.d.bounds.y));
  return all.map(({ d, primary }, i) => ({
    id: String(d.id),
    index: i + 1,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scale: Math.round((d.scaleFactor || 1) * 10000) / 10000,
    primary,
  }));
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * 撮る範囲（point）と出力の画素の大きさ。実の画素（point × scale）を上限まで縮める（upscale なら上限まで拡大）。
 * 結果の scale は「出力の画素 / point」で、core の toPhysical がそのまま使える（ADR 0173 §8）
 */
function planCapture(args, display) {
  const limits = { maxPixels: args.maxPixels ?? 1_200_000, maxEdge: args.maxEdge ?? 1568, quality: args.quality ?? 75 };
  if (!(limits.maxPixels > 0) || !(limits.maxEdge > 0)) throw new ComputerError('failed', 'maxPixels and maxEdge must be positive');
  const region = args.region;
  if (region && !(['x', 'y', 'width', 'height'].every(k => Number.isFinite(region[k])) && region.width > 0 && region.height > 0)) throw new ComputerError('failed', 'region must be { x, y, width, height }');
  const wanted = region ? intersect({ x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) }, display.bounds) : display.bounds;
  if (!wanted) throw new ComputerError('outside', 'region is outside the display');
  const pixelWidth = wanted.width * display.scale, pixelHeight = wanted.height * display.scale;
  const factor = fitScale(pixelWidth, pixelHeight, { ...limits, upscale: !!args.upscale });
  const width = Math.max(1, Math.floor(pixelWidth * factor));
  const height = Math.max(1, Math.floor(pixelHeight * factor));
  return { wanted, width, height, scale: width / wanted.width, quality: Math.min(100, Math.max(1, Math.round(limits.quality))) };
}

function createMacCapture({ helper, selfPid = process.pid }) {
  async function screenshot(args, { displays, displaysVersion }) {
    const display = pickDisplay(displays, args.display);
    if (!display) throw new ComputerError('outside', `display ${args.display} does not exist`);
    const plan = planCapture(args, display);
    const data = await helper.call('capture', {
      display: Number(display.id), rect: plan.wanted, width: plan.width, height: plan.height, quality: plan.quality, gray: !!args.gray, excludePid: selfPid,
    });
    const origin = { x: plan.wanted.x, y: plan.wanted.y };
    if (args.gray) return { gray: new Uint8Array(Buffer.from(String(data.gray ?? ''), 'base64')), width: data.width, height: data.height, scale: plan.scale, origin, displaysVersion };
    return { jpeg: new Uint8Array(Buffer.from(String(data.jpeg ?? ''), 'base64')), width: data.width, height: data.height, scale: plan.scale, origin, displaysVersion };
  }
  return { screenshot };
}

/** ロック・ログイン窓（desktop-state.cjs と同じ面。check は Promise を返す） */
function createMacDesktopState({ helper }) {
  return {
    async check() {
      const state = await helper.call('session', {});
      return { locked: !!state.locked, name: null, secureInput: !!state.secureInput };
    },
  };
}

/**
 * 許可（TCC）が無いと言われたときの後始末（ADR 0173 §6）: OS の確認を頼み、システム設定のペインを開き、次の頼みの前にヘルパーを起こし直す。
 * 開くのは、同じ許可について 60 秒に 1 回まで
 */
function withPermissionPrompt(client, { openExternal = () => {}, now = Date.now, log = () => {} }) {
  const lastOpened = new Map();
  let restart = false;
  async function onPermission(which) {
    restart = true;
    const pane = PERMISSION_PANES[which];
    if (!pane) return;
    if (now() - (lastOpened.get(which) ?? -Infinity) < PERMISSION_OPEN_INTERVAL_MS) return;
    lastOpened.set(which, now());
    // OS の確認は人の返事を待つことがある。エージェントへ返す permission は待たせない。
    Promise.resolve(client.call('request', { permission: which })).catch(error => log(`permission request failed: ${error.message}`));
    try { await openExternal(pane); } catch (error) { log(`could not open System Settings: ${error.message}`); }
  }
  return {
    async call(op, args, options) {
      if (restart) { restart = false; client.stop(); } // 許可した後の結果は、起こし直したヘルパーでないと新しくならない
      try { return await client.call(op, args, options); } catch (error) {
        if (error?.code === 'permission') await onPermission(error.permission);
        throw error;
      }
    },
    stop: () => client.stop(),
  };
}

/**
 * service.cjs の backend を作る。darwin でない・ヘルパーが無いときは reason 付きで投げる（platform / native）
 * @param {object} deps
 * @param {{ getAllDisplays(), getPrimaryDisplay(), getCursorScreenPoint() }} deps.screen Electron の screen
 */
function loadMac({ screen, openExternal, escape = null, isPackaged = false, resourcesPath = process.resourcesPath, platform = process.platform,
  osRelease = os.release(), exists = fs.existsSync, spawn, selfPid = process.pid, selfExe = process.execPath, sleep, log = () => {}, helperPath = null } = {}) {
  if (platform !== 'darwin') throw Object.assign(new Error('not macOS'), { reason: 'platform' });
  if (Number.parseInt(osRelease, 10) < 23) throw Object.assign(new Error('computer use requires macOS 14 or later'), { reason: 'platform' });
  if (!screen) throw Object.assign(new Error('screen is not available'), { reason: 'native' });
  const command = helperPath ?? helperCandidates({ resourcesPath, isPackaged }).find(p => exists(p));
  if (!command) throw Object.assign(new Error(`${HELPER_NAME} was not found (build desktop/computer/mac)`), { reason: 'native' });
  const client = createHelperClient({ command, ...(spawn ? { spawn } : {}), log });
  const helper = withPermissionPrompt(client, { openExternal, log });
  return {
    platform: 'darwin',
    command,
    helper,
    input: createMacInput({ helper, escape, log, ...(sleep ? { sleep } : {}) }),
    capture: createMacCapture({ helper, selfPid }),
    apps: createMacApps({ helper, selfPid, selfExe }),
    desktop: createMacDesktopState({ helper }),
    cursor: () => { const p = screen.getCursorScreenPoint(); return { x: p.x, y: p.y }; },
    listDisplays: () => listMacDisplays(screen),
    selfElevated: false,
    dispose: () => client.stop(),
  };
}

module.exports = { loadMac, listMacDisplays, planCapture, createMacCapture, withPermissionPrompt, helperCandidates, PERMISSION_PANES, HELPER_NAME };
