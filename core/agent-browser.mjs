import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import { previewPolicy } from '../web/browser-confirm-policy.mjs';
import { profileIds, defaultProfile } from '../web/browser-profiles.mjs';

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

// 内蔵ブラウザーの中継（desktop/browser-relay.cjs）の URL: 待ち受けのポートは 1 つ、会話ごとの鍵（24 バイトの 16 進）
const RELAY_URL = /^ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([a-f0-9]{48})$/;
const relayUrl = (port, key) => `ws://127.0.0.1:${port}/devtools/browser/${key}`;
const RELAY_MAX = 500;      // 持つ中継の写し（会話の数）
const TABS_MAX = 500, PROFILES_MAX = 2000;

/** 空いているポートを 1 つ選ぶ（取って離す。戻った main が同じポートを取れなければ、別のポートで立てて agent-browser-endpoint-moved で知らせる） */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/**
 * main が報告した内蔵ブラウザーのタブの写し（{ tabs: [{ sessionId, profile, url, selected }], profiles: [{ sessionId, profile }] }）の形を整える。
 * 戻った main がタブを開き直すのに使う。http(s) の URL だけ（file: のタブ・空のタブは戻さない）
 */
export function cleanTabState(message) {
  const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
  const tabs = [], profiles = [];
  for (const tab of Array.isArray(message?.tabs) ? message.tabs : []) {
    const url = text(tab?.url, 4096), profile = text(tab?.profile, 64), sessionId = tab?.sessionId == null ? null : text(tab.sessionId, 200);
    if (!url || !profile || !/^https?:\/\//i.test(url) || (tab.sessionId != null && !sessionId)) continue;
    tabs.push({ sessionId, profile, url, selected: tab.selected === true });
    if (tabs.length >= TABS_MAX) break;
  }
  for (const row of Array.isArray(message?.profiles) ? message.profiles : []) {
    const profile = text(row?.profile, 64), sessionId = row?.sessionId == null ? null : text(row.sessionId, 200);
    if (!profile || (row.sessionId != null && !sessionId)) continue;
    profiles.push({ sessionId, profile });
    if (profiles.length >= PROFILES_MAX) break;
  }
  return { tabs, profiles };
}

/**
 * main への口 port の上の、内蔵ブラウザーの橋（サーバー側）。
 * main が付け直す口（名前付きパイプ。port.resumable）では、main が居ない間の扱いを持つ（docs/zero-downtime-update/design.md §7.2・plan.md 1-5）:
 *   - 会話ごとの中継の URL（ポートと鍵）と、main が報告したタブの写しを持つ。付け直した main が browser-restore-request で引き、
 *     同じポート・鍵で中継を立て直す（タブを先に開き直してから待ち受ける。agent-browser の常駐は同じ URL なら次の呼び出しで戻る）
 *   - endpoint は、main が居ない間は写しで答える（新しい会話の鍵はここで決める。戻った main が同じ値で立てる）。ポートを一度も知らなければ空きポートをここで選ぶ。
 *     選べなかったときは戻るまで待つ（connectWaitMs）
 *   - ポートが取れずに別のポートで立った（agent-browser-endpoint-moved）ときは、会話ごとの設定ファイルの cdp を書き直す
 * @param dataDir 設定ファイル（agent-browser.json）の置き場。無ければ書き直さない
 */
export function parentPortBrowser(port, { timeoutMs = 10_000, connectWaitMs = 30_000, dataDir = null, pickPort = pickFreePort } = {}) {
  if (!port) return null;
  const pending = new Map();
  const configIds = new Map();
  const relays = new Map();       // 会話の id -> 鍵（main が答えた URL の写し。使った順に末尾）
  let relayPort = null;           // 中継の待ち受けのポート（main が答えた URL から。一度も答えが無ければ main が居ない間にここで選ぶ）
  let portPick = null;
  let tabState = { tabs: [], profiles: [] };   // main が報告した、内蔵ブラウザーのタブの写し
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
    if (message?.type === 'browser-state-report') { tabState = cleanTabState(message); return; }
    if (message?.type === 'browser-restore-request') {
      port.postMessage({ type: 'browser-restore', ...tabState, relay: relayPort != null && relays.size ? { port: relayPort, entries: [...relays].map(([sessionId, key]) => ({ sessionId, key })) } : null });
      for (const entry of pending.values()) post(entry);   // 新しい main の橋ができる前に送って落ちた依頼を送り直す
      return;
    }
    if (message?.type === 'agent-browser-endpoint-moved') { moved(message.port); return; }
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
    if (message.ok) { remember(item.sessionId, message.url); item.resolve(message.url); }
    else item.reject(new Error(message.error || 'browser unavailable'));
  });
  const requestOf = entry => ({ type: 'agent-browser-endpoint', id: entry.id, sessionId: entry.sessionId, unlock: entry.unlock, ...(entry.profile ? { profile: entry.profile } : {}) });
  /** main へ送る。送れたら答えを待つ（timeoutMs）。口が切れていれば false */
  function post(entry) {
    if (port.postMessage(requestOf(entry)) === false) return false;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => lapse(entry), timeoutMs);
    return true;
  }
  const settle = (entry, error, url) => {
    if (!pending.delete(entry.id)) return;
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(url);
  };
  /** 答えが来ない・送れない。main が居ない（付け直す口）なら写しで答えるか戻るまで待ち、そうでなければ失敗 */
  function lapse(entry) {
    if (!pending.has(entry.id)) return;
    if (port.resumable && port.connected === false && (answerFromCopy(entry) || awaitMain(entry))) return;
    settle(entry, new Error('browser relay timeout'));
  }
  /**
   * main が居ない間の endpoint の答え。写しの鍵（無ければここで決めた鍵）の URL を返す。ポートを一度も知らなければ、空きポートを選んでから答える（非同期。
   * 選べなければ戻るまで待つ）。答える（または答える手配をした）ときは true
   */
  function answerFromCopy(entry) {
    if (relayPort == null) {
      portPick ??= Promise.resolve().then(pickPort).then(value => { relayPort ??= value; return relayPort; }, () => { portPick = null; return null; });
      portPick.then(value => { if (pending.has(entry.id)) { if (value == null) awaitMain(entry); else answerFromCopy(entry); } });
      return true;
    }
    const key = relays.get(entry.sessionId) ?? crypto.randomBytes(24).toString('hex');
    keep(entry.sessionId, key);
    settle(entry, null, relayUrl(relayPort, key));
    return true;
  }
  /** 戻るまで待つ（最初に頼んだ時から connectWaitMs）。戻れば connect と browser-restore-request で送り直される */
  function awaitMain(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => settle(entry, new Error('browser relay timeout')), Math.max(0, entry.since + connectWaitMs - Date.now()));
    return true;
  }
  function keep(sessionId, key) {
    relays.delete(sessionId); relays.set(sessionId, key);
    if (relays.size > RELAY_MAX) relays.delete(relays.keys().next().value);
  }
  function remember(sessionId, url) {
    const match = RELAY_URL.exec(String(url));
    if (!match) return;
    relayPort = Number(match[1]);
    keep(sessionId, match[2]);
  }
  /** 戻った main が、ポートを取れずに別のポートで中継を立てた。持っている URL のポートを替え、会話ごとの設定ファイルの cdp も書き直す */
  function moved(value) {
    const nextPort = Number(value);
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) return;
    relayPort = nextPort;
    if (!dataDir) return;
    for (const [sessionId, key] of relays) {
      // 設定ファイルがある会話だけ（agent-browser を使った会話）。ターンの途中でも次の呼び出しから効く（stage1-0.md §3）
      const file = browserConfigFile(dataDir, configIds.get(sessionId) ?? sessionId);
      fs.access(file).then(() => fs.writeFile(file, JSON.stringify({ cdp: relayUrl(relayPort, key) }), { mode: 0o600 })).catch(() => {});
    }
  }
  // main が付け直す口（名前付きパイプ）: 切れた・つながった。送ったのに答えが来ないまま切れた依頼は、写しで答えるか戻るまで待つ。つながったら送り直す
  if (port.resumable) {
    port.on('disconnect', () => {
      for (const controller of approvals.values()) controller.abort();   // 切れた main の窓に出ていた確認は答えようがない
      for (const entry of [...pending.values()]) if (!answerFromCopy(entry)) awaitMain(entry);
    });
    port.on('connect', () => { for (const entry of pending.values()) post(entry); });
  }
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
      const entry = { id: `ab${++next}`, sessionId, unlock, profile, resolve, reject, timer: null, since: Date.now() };
      pending.set(entry.id, entry);
      if (!post(entry)) lapse(entry);
    }); },
    rebind(from, to) {
      configIds.set(to, configIds.get(from) ?? from);
      if (relays.has(from)) { keep(to, relays.get(from)); relays.delete(from); }
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
  const file = browserConfigFile(dataDir, configSessionId);
  const dir = path.dirname(file);
  const session = `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;
  const socketDir = browserSocketDirectory(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ cdp: url }), { mode: 0o600 });
  return { AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: '' };
}

export function browserInstruction(env, locale, translate) {
  return env ? translate(locale, 'browser.instructions') : null;
}
