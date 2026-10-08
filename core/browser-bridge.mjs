// ply_browser: エージェントのブラウザー操作のための MCP の口（core/agent-bridge.mjs と同じ型。会話ごとに Bearer の付いた HTTP）。
// エージェントのブラウザー（PC の Chrome の専用の窓。ADR 0148）を渡すターン（デスクトップ版で中継がある）にだけ渡す。
// hand_to_user・close_browser_window と、useProfiles で登録するプロフィールの一覧・切り替えを載せる。
import { claimToken } from './mcp-token.mjs';
import { agentT } from './i18n.mjs';
import { HANDOFF_REASONS } from './chrome/handoff.mjs';

export const BROWSER_MCP_PATH = '/mcp/browser';
export const BROWSER_SERVER = 'ply_browser';

/** ply_browser が出すツールの定義（{ name, description, inputSchema }）。agentT で説明をエージェントの言語にする */
export const browserTools = locale => [{
  name: 'hand_to_user',
  description: agentT(locale, 'browserBridge.handToUser.description'),
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: HANDOFF_REASONS },
      message: { type: 'string', description: agentT(locale, 'browserBridge.handToUser.messageDescription') },
    },
    required: ['reason', 'message'],
  },
}, {
  name: 'close_browser_window',
  description: `${agentT(locale, 'browserBridge.closeWindow.description')} ${agentT(locale, 'browserBridge.closeWindowTask.description')}`,
  inputSchema: { type: 'object', properties: { task: { type: 'string', description: agentT(locale, 'browserBridge.closeWindowTask.argument') } }, additionalProperties: false },
}];

/** Chrome のプロフィールのツール（第 10 段）。プロフィールの本体があるホストだけに載せる（createBrowserBridge の useProfiles） */
export const PROFILE_TOOLS = ['list_browser_profiles', 'use_browser_profile'];
export const profileTools = locale => [{
  name: 'list_browser_profiles',
  description: agentT(locale, 'browserBridge.listProfiles.description'),
  inputSchema: { type: 'object', properties: {} },
}, {
  name: 'use_browser_profile',
  description: agentT(locale, 'browserBridge.useProfile.description'),
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: agentT(locale, 'browserBridge.useProfile.profileDescription') },
      browser: { type: 'string', enum: ['chrome', 'edge'], description: agentT(locale, 'browserBridge.useProfile.browserDescription') },
    },
    required: ['profile'],
  },
}];

/** hand_to_user を待つ 1 回の長さ（ミリ秒）。バックエンドの呼び出しの上限（Claude・Codex は 660 秒）より短くし、超えたら「まだ待っています」で返して呼び直させる */
export const BROWSER_WAIT_SLICE_MS = 600_000;

const clock = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** hand_to_user の答え（handoffs.wait の返り値）→ MCP の結果。待つのは正しい動きなので waiting はエラーにしない */
export function handToUserResult(locale, answer) {
  // i18n-dynamic: agent:browserBridge.handToUser.
  const text = key => agentT(locale, `browserBridge.handToUser.${key}`);
  switch (answer?.kind) {
    case 'resumed': return { isError: false, text: agentT(locale, 'browserBridge.handToUser.resumed', { detail: [clock(answer.at), answer.url, answer.title].filter(Boolean).join(' / ') || '-' }) };
    case 'connected': return { isError: false, text: text('connected') };
    case 'waiting': return { isError: false, text: text('waiting') };
    case 'declined': return { isError: true, text: text('declined') };
    case 'aborted': return { isError: true, text: text('aborted') };
    default: return { isError: true, text: text('none') };
  }
}

/** ply_browser の口。会話ごとに open し、橋は会話の id が決まっても使い回す（agy は会話のあいだ同じトークンを使う） */
export function createBrowserBridge({ handoffs = null, closeWindow = null } = {}) {
  const bindings = new Map();
  const fail = text => ({ isError: true, content: [{ type: 'text', text }] });
  let profiles = null;   // { list(sessionId, locale), use(sessionId, { profile, browser }, locale) }（useProfiles で差し込む。ops の browser.listProfiles・useProfile を呼ぶ）
  async function profileCall(binding, params) {
    // i18n-dynamic: agent:browserBridge.useProfile.
    const { locale } = binding;
    let owner;
    try { owner = await binding.owner(); } catch (error) { return fail(String(error?.message ?? error)); }
    if (!owner?.sessionId) return fail(agentT(locale, 'browserBridge.handToUser.noTurn'));
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      if (params.name === 'list_browser_profiles') return { isError: false, content: [{ type: 'text', text: JSON.stringify(await profiles.list(owner.sessionId, locale)) }] };
      if (typeof args.profile !== 'string' || !args.profile) return fail(agentT(locale, 'browserBridge.invalidTool'));
      const done = await profiles.use(owner.sessionId, { profile: args.profile, ...(typeof args.browser === 'string' ? { browser: args.browser } : {}) }, locale);
      return { isError: false, content: [{ type: 'text', text: agentT(locale, done.changed ? 'browserBridge.useProfile.done' : 'browserBridge.useProfile.same', { name: done.name, dir: done.dir }) }] };
    } catch (error) { return fail(String(error?.message ?? error)); }
  }
  async function callTool(binding, params) {
    // i18n-dynamic: agent:browserBridge.closeWindow.
    const { locale } = binding;
    if (profiles && PROFILE_TOOLS.includes(params?.name)) return profileCall(binding, params);
    if (!['hand_to_user', 'close_browser_window'].includes(params?.name) || (params.name === 'hand_to_user' && !handoffs) || (params.name === 'close_browser_window' && !closeWindow)) return fail(agentT(locale, 'browserBridge.invalidTool'));
    let owner;
    try { owner = await binding.owner(); } catch (error) { return fail(String(error?.message ?? error)); }
    if (!owner?.sessionId) return fail(agentT(locale, 'browserBridge.handToUser.noTurn'));
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (params.name === 'close_browser_window') {
      if (params.arguments != null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(args).some(key => key !== 'task') || (args.task !== undefined && (typeof args.task !== 'string' || !args.task))))
        return fail(agentT(locale, 'browserBridge.invalidTool'));
      try {
        const result = await closeWindow(owner.sessionId, args.task ?? null);
        if (result?.failed) return fail(agentT(locale, 'browserBridge.closeWindow.failed'));
        // i18n-dynamic: agent:browserBridge.closeWindowTask.
        return { isError: false, content: [{ type: 'text', text: agentT(locale, result?.closed ? 'browserBridge.closeWindow.closed' : args.task ? 'browserBridge.closeWindowTask.none' : 'browserBridge.closeWindow.none') }] };
      } catch (error) { return fail(String(error?.message ?? error)); }
    }
    handoffs.ask(owner.sessionId, { reason: args.reason, message: args.message });
    const answer = await handoffs.wait(owner.sessionId, { sliceMs: owner.waitSliceMs ?? BROWSER_WAIT_SLICE_MS, signal: owner.signal });
    const { isError, text } = handToUserResult(locale, answer);
    return { isError, content: [{ type: 'text', text }] };
  }
  return {
    /** プロフィールのツールの本体を差し込む（null で外す）。差し込んだホストだけ tools/list に載る */
    useProfiles(adapter) { profiles = adapter ?? null; },
    // token は開き直す口の値（省略なら新しく作る。形が違う・使用中なら投げる）。
    // owner は呼び出しの時点の会話を返す: { sessionId, signal, waitSliceMs? }（ターンが無ければ投げる。ply_computer の owner と同じ）
    open({ origin, owner, locale, token: fixed }) {
      const token = claimToken(bindings, fixed);
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
      const { locale } = binding;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: BROWSER_SERVER, version: '1.0.0' } };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: handoffs ? browserTools(locale) : [] };   // Chrome の層が無いホストは載せない
      else if (m.method === 'tools/call') result = await callTool(binding, m.params);
      else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      if (m.method === 'tools/list' && handoffs && profiles) result = { tools: [...result.tools, ...profileTools(locale)] };
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
