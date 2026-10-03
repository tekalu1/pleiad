// 内蔵ブラウザーのプロフィール（docs/inapp-browser.md「プロフィール」、ADR 0078）のサーバー側。
//   - 会話の今のプロフィールの正本は会話のメタ（sessions.json の browserProfile）。新しい会話は作るときに決め、持たない会話（この機能より前の会話）は
//     初めて引いたときに「新しい会話のプロフィール」の規則で決めて保存する。消えたプロフィールを指していれば規則で決め直す
//   - 作業フォルダーで最後に使ったものは prefs の browserLastProfiles（store.rememberBrowserProfile）
//   - ply_browser: エージェントがプロフィールの一覧を読み、会話の今のプロフィールを切り替える MCP（core/agent-bridge.mjs と同じ型。会話ごとに Bearer の付いた HTTP）。
//     内蔵ブラウザーを渡すターン（デスクトップ版で中継がある）にだけ渡す
import crypto from 'node:crypto';
import { agentT } from './i18n.mjs';
import { profileList, profileForNew, hasProfile, defaultProfile, profileName, folderKey, validProfileId } from '../web/browser-profiles.mjs';

export const BROWSER_MCP_PATH = '/mcp/browser';
export const BROWSER_SERVER = 'ply_browser';
export const BROWSER_TOOL_NAMES = ['list_browser_profiles', 'use_browser_profile'];

/**
 * @param getPrefs store.getPrefs
 * @param getSession store.get（無い会話は { history: [] }）
 * @param setSessionData store.setSessionData
 * @param rememberLast store.rememberBrowserProfile（フォルダーの鍵, id）
 */
export function createBrowserProfiles({ getPrefs, getSession, setSessionData, rememberLast, platform = process.platform }) {
  const exists = meta => Boolean(meta && (meta.backend || meta.cwd || meta.createdAt));
  return {
    /** 会話の今のプロフィール。sessionId が無ければ（会話を開いていない）既定。persist なら決めた値を会話に残す */
    async resolve(sessionId, { persist = true } = {}) {
      const prefs = await getPrefs();
      if (!sessionId) return defaultProfile(prefs);
      const meta = await getSession(sessionId);
      if (hasProfile(prefs, meta?.browserProfile)) return meta.browserProfile;
      const profile = profileForNew(prefs, meta?.cwd ?? null, platform);
      if (persist && exists(meta)) await setSessionData(sessionId, 'browserProfile', profile, { durable: true }).catch(() => {});
      return profile;
    },
    /** 新しい会話のプロフィール（元の会話があればそのプロフィールを継ぐ） */
    async forNew(cwd, source = null) {
      const prefs = await getPrefs();
      if (hasProfile(prefs, source?.browserProfile)) return source.browserProfile;
      return profileForNew(prefs, cwd, platform);
    },
    /** 会話の今のプロフィールを替えて残す。作業フォルダーの「最後に使ったもの」も替える。知らない id なら false */
    async set(sessionId, profile, cwd) {
      const prefs = await getPrefs();
      if (!validProfileId(profile) || !hasProfile(prefs, profile)) return false;
      if (sessionId) await setSessionData(sessionId, 'browserProfile', profile, { durable: true });
      const key = folderKey(cwd, platform);
      if (key) await rememberLast(key, profile);
      return true;
    },
    /** 画面とエージェントに見せる名前。名前を付けていないメインは mainName */
    async label(profile, mainName) {
      const row = profileList(await getPrefs()).find(p => p.id === profile);
      return profileName(row ?? { id: profile }, mainName);
    },
  };
}

const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
// i18n-dynamic: agent:browserProfiles.tools.
export const browserTools = locale => [
  tool('list_browser_profiles', agentT(locale, 'browserProfiles.tools.list_browser_profiles'), {}),
  tool('use_browser_profile', agentT(locale, 'browserProfiles.tools.use_browser_profile'), { profile: { type: 'string' } }, ['profile']),
];

/** エージェントが書いた profile（id か名前）を一覧の行にする。名前は大文字と小文字・前後の空白を区別しない */
export function findProfile(prefs, value, mainName) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const rows = profileList(prefs);
  const want = value.trim();
  return rows.find(row => row.id === want) ?? rows.find(row => profileName(row, mainName).toLowerCase() === want.toLowerCase()) ?? null;
}

/**
 * ply_browser の口。call(owner, name, args, { locale }) がツールの本体（core/server.mjs）。
 * 会話ごとに open し、橋は会話の id が決まっても使い回す（agy は会話のあいだ同じトークンを使う）
 */
export function createBrowserBridge({ call }) {
  const bindings = new Map();
  return {
    open({ origin, owner, locale }) {
      const token = crypto.randomBytes(32).toString('hex');
      bindings.set(token, { owner, locale });
      return { url: origin + BROWSER_MCP_PATH, headers: { Authorization: `Bearer ${token}` }, close: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const binding = bindings.get(token);
      if (!binding) return reply(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return reply(405);
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403); } catch { return reply(403); }
      }
      let m;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64000) return reply(413); chunks.push(chunk); }
        m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply(400);
      if (m.id === undefined) return reply(202);
      const { owner, locale } = binding;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: BROWSER_SERVER, version: '1.0.0' } };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: browserTools(locale) };
      else if (m.method === 'tools/call') {
        try {
          const definition = browserTools(locale).find(t => t.name === m.params?.name);
          const args = m.params?.arguments ?? {};
          if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(definition.inputSchema.properties, k))) throw new Error(agentT(locale, 'browserProfiles.invalidTool'));
          const data = await call(owner, definition.name, args, { locale });
          result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (e) { result = { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
      } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
