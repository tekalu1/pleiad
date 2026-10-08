'use strict';
// macOS のアプリの特定（ADR 0173 §5）。ヘルパーが返す事実（pid・bundleId・bundlePath・executable・name）を AppInfo にする。
// id は `bundle:<バンドル ID>`、バンドルの無いプロセスは `exe:<実行ファイルのパス>`。elevated は常に false（macOS に UIPI に当たる仕組みは無い）。
// 名前での検索（findApp）の点数の付け方は apps.cjs（Windows）と同じ形。
const path = require('node:path');
const { ComputerError } = require('./errors.cjs');

const SELF_BUNDLE_ID = 'jp.ply.desktop';
const LAUNCH_TIMEOUT_MS = 12_000;

const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().trim();
const appBase = p => (p ? path.posix.basename(p).replace(/\.app$/i, '').toLowerCase() : '');

/** 実行ファイルのパス（…/Pleiad.app/Contents/MacOS/Pleiad）→ .app のパス。.app の外なら null */
function bundleOf(executable) {
  const match = /^(.*?\.app)(?:\/|$)/.exec(String(executable ?? ''));
  return match ? match[1] : null;
}

/**
 * @param {object} deps
 * @param {{ call(op: string, args?: object, options?: object): Promise<object> }} deps.helper
 * @param {number} [deps.selfPid] Pleiad の main の pid（オーバーレイの窓の持ち主）
 * @param {string} [deps.selfExe] Pleiad の実行ファイル（process.execPath）
 */
function createMacApps({ helper, selfPid = process.pid, selfExe = process.execPath, selfBundleId = SELF_BUNDLE_ID }) {
  const selfApp = bundleOf(selfExe);

  /** Pleiad 自身か: 同じ pid・Pleiad の .app の中・Pleiad のバンドル ID（Electron の Helper は jp.ply.desktop.helper など） */
  function isSelf(raw) {
    if (raw.pid === selfPid) return true;
    if (raw.bundleId && (raw.bundleId === selfBundleId || raw.bundleId.startsWith(`${selfBundleId}.`))) return true;
    if (selfApp) {
      if (raw.bundlePath === selfApp) return true;
      if (raw.executable && raw.executable.startsWith(`${selfApp}/`)) return true;
    }
    return false;
  }

  /** ヘルパーの答え（{ pid, bundleId?, bundlePath?, executable?, name? }）→ AppInfo。特定できなければ null */
  function toAppInfo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const bundlePath = raw.bundlePath ?? bundleOf(raw.executable);
    const appPath = bundlePath ?? raw.executable ?? null;
    if (!raw.bundleId && !appPath) return null;
    const kind = raw.bundleId ? 'bundle' : 'exe';
    return {
      id: raw.bundleId ? `bundle:${raw.bundleId}` : `exe:${appPath}`,
      kind,
      name: raw.name || (bundlePath ? path.posix.basename(bundlePath, '.app') : appPath ? path.posix.basename(appPath) : raw.bundleId),
      ...(appPath ? { path: appPath } : {}),
      ...(raw.bundleId ? { bundleId: raw.bundleId } : {}),
      ...(Number.isInteger(raw.pid) ? { pid: raw.pid } : {}),
      elevated: false,
      self: isSelf({ ...raw, bundlePath }),
    };
  }

  const appAt = async (x, y) => toAppInfo((await helper.call('appAt', { x, y, excludePid: selfPid })).app);
  const foreground = async () => toAppInfo((await helper.call('foreground', {})).app);

  async function listApps() {
    const data = await helper.call('apps', {});
    const running = (data.running ?? []).map(toAppInfo).filter(Boolean);
    const known = new Set(running.map(a => a.id));
    const installed = [];
    for (const entry of data.installed ?? []) {
      const app = toAppInfo(entry);
      if (app && !known.has(app.id)) { known.add(app.id); installed.push(app); }
    }
    return { running, installed };
  }

  function score(app, query) {
    const name = norm(app.name), base = appBase(app.path), bundleId = norm(app.bundleId);
    const q = query.replace(/\.app$/i, '');
    if (q === name || q === base || q === bundleId || query === norm(app.id)) return 100;
    if (name.startsWith(q)) return 80;
    if (base && base.startsWith(q)) return 75;
    if (name.includes(q)) return 60;
    if (base && base.includes(q)) return 55;
    if (bundleId && bundleId.includes(q)) return 40;
    return 0;
  }

  /** 動いているものと決まったフォルダーの .app から、名前（表示名・.app の名前・バンドル ID）に当たるものを強い順に */
  async function findApp(name) {
    const query = norm(name);
    if (!query) return [];
    const { running, installed } = await listApps();
    const candidates = [...running.map(app => ({ app, bonus: 5 })), ...installed.map(app => ({ app, bonus: 0 }))];
    return candidates
      .map(({ app, bonus }) => ({ app, score: score(app, query) + (score(app, query) ? bonus : 0) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(c => c.app);
  }

  function launchPath(app) {
    if (!app || typeof app !== 'object') throw new ComputerError('not_found', 'no app');
    if (app.kind !== 'bundle' && app.kind !== 'exe') throw new ComputerError('not_found', 'unknown app kind');
    const bundlePath = app.kind === 'bundle' ? app.path : bundleOf(app.path);
    if (!bundlePath || !path.posix.isAbsolute(bundlePath) || !/\.app$/i.test(bundlePath) || /[\u0000-\u001f]/.test(bundlePath)) {
      throw new ComputerError('not_found', `application not found: ${app.path ?? ''}`);
    }
    return bundlePath;
  }

  /** @returns {Promise<{ started: boolean, alreadyRunning: boolean, app: object }>} */
  async function launch(app) {
    const bundlePath = launchPath(app);
    const { running } = await listApps();
    const hit = running.find(a => a.id === app.id);
    if (hit) {
      let foregrounded = false;
      try { foregrounded = !!(await helper.call('activate', { pid: hit.pid })).activated; } catch { /* 前に出せなくても動いている */ }
      return { started: false, alreadyRunning: true, foregrounded, app: hit };
    }
    const data = await helper.call('launch', { path: bundlePath }, { timeout: LAUNCH_TIMEOUT_MS });
    return { started: true, alreadyRunning: false, app: toAppInfo(data.app) ?? app };
  }

  return { appAt, foreground, inspectAt: appAt, inspectForeground: foreground, findApp, launch, isSelf, toAppInfo, listApps };
}

module.exports = { createMacApps, bundleOf, SELF_BUNDLE_ID };
