import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { previewPolicy } from '../web/browser-confirm-policy.mjs';
import { profileIds, defaultProfile } from '../web/browser-profiles.mjs';

export function browserSocketDirectory(dir, platform = process.platform) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);
  // Use workspace-write's default temporary roots without adding sandbox grants.
  if (platform === 'win32') return path.join(os.tmpdir(), `ply-ab-${hash}`);
  // macOS TMPDIR can exceed agent-browser's 103-byte Unix socket path limit.
  return path.join('/tmp', `ply-ab-${os.userInfo().uid}`, hash);
}

export function parentPortBrowser(port, { timeoutMs = 10_000 } = {}) {
  if (!port) return null;
  const pending = new Map();
  const configIds = new Map();
  let next = 0;
  let authorize = async () => ({ allow: false });
  let resolveProfile = async () => null;
  let confirmationEnabled = false;
  // main に知らせるプロフィールの設定（使える id と既定。ADR 0078）
  let profileState = { profiles: ['main'], defaultProfile: 'main' };
  // 外部の読み込みの確認（内蔵ブラウザーの file: のタブに効かせる。ADR 0079）
  let policyMessage = { type: 'browser-load-policy', confirm: false, origins: [] };
  const approvals = new Map();
  port.on('message', event => {
    const message = event?.data ?? event;
    if (message?.type === 'browser-load-policy-request') { port.postMessage(policyMessage); return; }
    if (message?.type === 'agent-browser-prefs-request') { port.postMessage({ type: 'agent-browser-prefs', enabled: confirmationEnabled, ...profileState }); return; }
    // main がまだ覚えていない会話の今のプロフィールを引く（画面の会話の切り替え・画面の転送）
    if (message?.type === 'browser-profile-resolve') {
      Promise.resolve().then(() => resolveProfile(message.sessionId ?? null)).catch(() => null)
        .then(profile => port.postMessage({ type: 'browser-profile-resolve', id: message.id, profile: profile ?? null }));
      return;
    }
    if (message?.type === 'agent-browser-authorize-cancel') { approvals.get(message.id)?.abort(); return; }
    if (message?.type === 'agent-browser-authorize') {
      const controller = new AbortController(); approvals.set(message.id, controller);
      Promise.resolve().then(() => authorize(message, controller.signal)).then(answer => {
        port.postMessage({ type: 'agent-browser-authorize', id: message.id, ...answer });
      }, () => port.postMessage({ type: 'agent-browser-authorize', id: message.id, allow: false })).finally(() => approvals.delete(message.id));
      return;
    }
    if (message?.type !== 'agent-browser-endpoint') return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.url);
    else item.reject(new Error(message.error || 'browser unavailable'));
  });
  return {
    configureAuthorization(handler) { authorize = handler; },
    /** 「外部の読み込みの前に確認」と、常に許可した https の出どころ（main が内蔵ブラウザーの file: のタブで止める） */
    loadPolicy(prefs) {
      const { confirm, origins } = previewPolicy(prefs);
      policyMessage = { type: 'browser-load-policy', confirm, origins };
      port.postMessage(policyMessage);
    },
    configureProfiles(handler) { resolveProfile = handler; },
    endTurn(sessionId) { port.postMessage({ type: 'agent-browser-turn-ended', sessionId }); },
    prefs(prefs) {
      confirmationEnabled = prefs.confirmAgentSites === true;
      profileState = { profiles: profileIds(prefs), defaultProfile: defaultProfile(prefs) };
      port.postMessage({ type: 'agent-browser-prefs', enabled: confirmationEnabled, ...profileState });
    },
    /** 会話の今のプロフィールが替わったことを main に知らせる。agent は切り替えたエージェントの名前（人が替えたときは付けない） */
    profile(sessionId, profile, agent = null) { port.postMessage({ type: 'agent-browser-profile', sessionId, profile, ...(agent ? { agent } : {}) }); },
    endpoint(sessionId, { unlock = false, profile = null } = {}) { return new Promise((resolve, reject) => {
      const id = `ab${++next}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('browser relay timeout')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ type: 'agent-browser-endpoint', id, sessionId, unlock, ...(profile ? { profile } : {}) });
    }); },
    rebind(from, to) {
      configIds.set(to, configIds.get(from) ?? from);
      port.postMessage({ type: 'agent-browser-rebind', from, to });
    },
    configSessionId(sessionId) { return configIds.get(sessionId) ?? sessionId; },
  };
}

export async function browserEnvironment({ bridge, dataDir, sessionId, unlock = false, profile = null }) {
  if (!bridge || !sessionId) return null;
  const url = await bridge.endpoint(sessionId, { unlock, profile });
  // Keep the shell config path and agent-browser namespace stable after a new thread gets its native ID.
  const configSessionId = bridge.configSessionId?.(sessionId) ?? sessionId;
  const dir = path.join(dataDir, 'agent-browser', crypto.createHash('sha256').update(configSessionId).digest('hex'));
  const session = `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;
  const socketDir = browserSocketDirectory(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agent-browser.json');
  await fs.writeFile(file, JSON.stringify({ cdp: url }), { mode: 0o600 });
  return { AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: '' };
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
