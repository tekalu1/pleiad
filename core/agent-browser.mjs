import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export function browserSocketDirectory(dir, platform = process.platform) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);
  // Use workspace-write's default temporary roots without adding sandbox grants.
  if (platform === 'win32') return path.join(os.tmpdir(), `ply-ab-${hash}`);
  // macOS TMPDIR can exceed agent-browser's 103-byte Unix socket path limit.
  return path.join('/tmp', `ply-ab-${os.userInfo().uid}`, hash);
}

/** 会話ごとの agent-browser の設定ファイル（{ cdp }）の場所。会話の id（ネイティブの id に替わった後も最初の id）から決まる */
export function browserConfigFile(dataDir, configSessionId) {
  return path.join(dataDir, 'agent-browser', crypto.createHash('sha256').update(configSessionId).digest('hex'), 'agent-browser.json');
}

const TABS_MAX = 500;

/**
 * main が報告した内蔵ブラウザーのタブの写し（{ tabs: [{ sessionId, url, selected }] }）の形を整える。
 * 戻った main がタブを開き直すのに使う（core/browser-viewer.mjs）。http(s) の URL だけ（file: のタブ・空のタブは戻さない）
 */
export function cleanTabState(message) {
  const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
  const tabs = [];
  for (const tab of Array.isArray(message?.tabs) ? message.tabs : []) {
    const url = text(tab?.url, 4096), sessionId = tab?.sessionId == null ? null : text(tab.sessionId, 200);
    if (!url || !/^https?:\/\//i.test(url) || (tab.sessionId != null && !sessionId)) continue;
    tabs.push({ sessionId, url, selected: tab.selected === true });
    if (tabs.length >= TABS_MAX) break;
  }
  return { tabs };
}

/**
 * エージェントのブラウザーの道は PC の Chrome の中継（core/chrome/relay.mjs）だけ。Chrome の中継を browserEnvironment の bridge の形にする。endpoint は parentPort の往復なしで core の中継から取る。
 * pinTab: agent-browser を自分のタブに縛る（AGENT_BROWSER_PIN_TAB=1。無いと最初の open が「アクティブなタブ」を書き換えうる。ADR 0148）
 */
export function chromeRelayBrowser(relay) {
  const configIds = new Map();
  return {
    pinTab: true,
    endpoint: (sessionId, options) => relay.endpoint(sessionId, options),
    rebind(from, to) { configIds.set(to, configIds.get(from) ?? from); relay.rebind(from, to); },
    configSessionId: sessionId => configIds.get(sessionId) ?? sessionId,
    endTurn: sessionId => relay.endTurn(sessionId),
  };
}

export async function browserEnvironment({ bridge, dataDir, sessionId, unlock = false }) {
  if (!bridge || !sessionId) return null;
  const url = await bridge.endpoint(sessionId, { unlock });
  // Keep the shell config path and agent-browser namespace stable after a new thread gets its native ID.
  const configSessionId = bridge.configSessionId?.(sessionId) ?? sessionId;
  const file = browserConfigFile(dataDir, configSessionId);
  const dir = path.dirname(file);
  const session = `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;
  const socketDir = browserSocketDirectory(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ cdp: url }), { mode: 0o600 });
  return { AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: '', ...(bridge.pinTab ? { AGENT_BROWSER_PIN_TAB: '1' } : {}) };
}

/** 会話を消したときに、その会話の agent-browser の設定とソケットの置き場を消す（sessions.delete。ADR 0147） */
export async function forgetBrowserEnvironment({ bridge, dataDir, sessionId }) {
  if (!sessionId) return;
  const configSessionId = bridge?.configSessionId?.(sessionId) ?? sessionId;
  const dir = path.join(dataDir, 'agent-browser', crypto.createHash('sha256').update(configSessionId).digest('hex'));
  await fs.rm(browserSocketDirectory(dir), { recursive: true, force: true });
  await fs.rm(dir, { recursive: true, force: true });
}

export function browserInstruction(env, locale, translate) {
  return env ? translate(locale, 'browser.instructions') : null;
}
