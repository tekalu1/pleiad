// ply_computer: エージェントに PC の画面を撮らせ、マウスとキーボードで操作させる MCP サーバー（docs/computer-use.md、ADR 0070）。
// core/agent-bridge.mjs（ply_agents）と同じ型で、会話ごとに Bearer の付いた HTTP の MCP を開く。
// 撮影と入力は Electron の main（driver 越し）が行い、ここは MCP の面・アプリの承認・ロック・止めた印・スクショの保存だけを持つ。
import { claimToken } from './mcp-token.mjs';
import { agentT } from './i18n.mjs';
import { computerTools, COMPUTER_TOOL_NAMES, LOCKING } from './computer-use/tools.mjs';
import { createActions, ToolFail } from './computer-use/actions.mjs';
import { computerMarker } from './computer-use/display.mjs';
import { LockError } from './computer-use/lock.mjs';
import { normalizeComputerUse } from './computer-use/policy.mjs';

export const COMPUTER_MCP_PATH = '/mcp/computer';
const DEFAULT_DELIVERY = Object.freeze({ images: 'inline', waitSliceMs: null });
const TITLE_MAX = 80;

/** ply_computer の instructions。画像をファイルでも渡すエージェント（images: path）には、ファイルを開いて見る指示を足す */
export function computerInstructions(locale, delivery = DEFAULT_DELIVERY) {
  return [agentT(locale, 'computer.instructions'), delivery.images === 'path' ? agentT(locale, 'computer.pathInstructions') : null].filter(Boolean).join('\n');
}

const POINT_TOOLS = new Set(['mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_mouse_down', 'left_mouse_up']);

/** title が来なかったときに操作から作る短い題（computer.autoTitle.<ツール名>）。表示は入力の title を優先する */
function autoTitle(locale, name, args) {
  const c = Array.isArray(args.coordinate) && args.coordinate.length === 2 ? args.coordinate.map(v => Math.round(Number(v))) : null;
  const params = {
    x: c?.[0], y: c?.[1], count: typeof args.text === 'string' ? [...args.text].length : 0, text: typeof args.text === 'string' ? args.text.slice(0, 30) : '',
    app: typeof args.app === 'string' ? args.app.slice(0, 30) : '', n: args.display, direction: args.scroll_direction, seconds: args.duration,
    actions: Array.isArray(args.actions) ? args.actions.length : 0,
  };
  const key = (POINT_TOOLS.has(name) || name === 'screenshot') && !c && (name !== 'screenshot' || args.display === undefined) ? `${name}NoPoint` : name;
  // i18n-dynamic: agent:computer.autoTitle.
  return agentT(locale, `computer.autoTitle.${key}`, params);
}

const cleanTitle = value => (typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) : null);

/**
 * @param driver main への口（core/computer-use/driver.mjs）
 * @param lock PC 全体で 1 つのロックとターンごとの止めた印（core/computer-use/lock.mjs）
 * @param shots スクリーンショットの保存（core/computer-use/shots.mjs）
 * @param access アプリの許可の読み書き { getPrefs, sessionApps, rememberSession, rememberAlways, markIntroduced }
 * @param askPermission server の承認の口（payload に computerApp を足せる）
 * @param translate server の t（承認カードの見出し）
 */
export function createComputerBridge({ driver, lock, shots, access, askPermission, translate }) {
  const bindings = new Map();
  const actions = createActions({ driver, shots, access, askPermission, translate });

  const plain = (locale, text, isError = true) => ({ isError, content: [{ type: 'text', text }] });

  /** 結果の content。text の最後の行が印の行。画像があれば 2 つ目に image */
  function format(ctx, name, title, r, { state = 'ok', reason } = {}) {
    const lines = [r.text];
    if (r.shotId && ctx.binding.delivery.images === 'path') lines.push(agentT(ctx.locale, 'computer.shotPath', { path: shots.pathOf(r.shotId) }));
    lines.push(computerMarker({ tool: name, state, reason, title, app: r.app, display: r.display, shot: r.shotId, w: r.shotId ? r.w : undefined, h: r.shotId ? r.h : undefined, grant: r.grant, actions: r.actions }));
    const content = [{ type: 'text', text: lines.filter(l => l !== undefined && l !== '').join('\n') }];
    if (r.image?.jpeg) content.push({ type: 'image', mimeType: 'image/jpeg', data: Buffer.from(r.image.jpeg).toString('base64') });
    return { isError: state !== 'ok', content };
  }

  /** 保存してから形にする。保存に失敗しても操作の結果は返す（画面に画像が出ないだけ） */
  async function withShot(ctx, r) {
    if (!r?.image?.jpeg) return r;
    try { return { ...r, shotId: await shots.save(ctx.sessionId, r.image.jpeg) }; }
    catch (e) { console.error('  computer: スクリーンショットを保存できませんでした:', String(e?.message ?? e)); return r; }
  }

  async function callTool(binding, name, args) {
    const { locale } = binding;
    if (!COMPUTER_TOOL_NAMES.includes(name)) return plain(locale, agentT(locale, 'computer.errors.invalid', {}));
    let info;
    try { info = await binding.owner(); }
    catch (e) { return plain(locale, String(e?.message ?? e)); }
    const agent = info.agent ?? (typeof binding.agent === 'function' ? binding.agent() : binding.agent);
    info = { ...info, agent };
    binding.turns.add(info.turnId);
    const t = lock.turn(info);
    const ctx = { binding, info, t, locale, turnId: info.turnId, sessionId: info.sessionId, signal: info.signal, agent };
    const title = cleanTitle(args.title) ?? autoTitle(locale, name, args);
    const fail = async (e, partial) => {
      const r = await withShot(ctx, partial ?? {});
      return format(ctx, name, title, { ...r, text: actions.failText(ctx, e), app: r.app ?? e.params?.app }, { state: e.state, reason: e.reason });
    };
    try {
      if (!driver.state()?.supported || normalizeComputerUse((await access.getPrefs()).computerUse).enabled === false) throw new ToolFail('unsupported', { message: '' });
      if (t.stopped) throw new ToolFail(t.stopped.reason);
      const body = () => {
        if (t.stopped) throw new ToolFail(t.stopped.reason);
        return actions.perform(ctx, name, args);
      };
      let r;
      try {
        r = LOCKING.has(name)
          ? await lock.run(info, body, { signal: info.signal, sliceMs: binding.delivery.waitSliceMs })
          : await body();
      } catch (e) {
        if (!(e instanceof LockError)) throw e;
        if (e.code === 'slice') return format(ctx, name, title, { text: agentT(locale, 'computer.errors.waiting') }, { state: 'waiting' });
        if (e.code === 'busy') throw new ToolFail('busy', { title: lock.holder()?.title ?? '' });
        throw new ToolFail(e.code === 'stopped' ? (t.stopped?.reason ?? 'stop') : 'stop');
      }
      return format(ctx, name, title, await withShot(ctx, r));
    } catch (e) {
      if (e instanceof ToolFail) return fail(e, e.partial);
      console.error('  computer: 予期しない失敗:', String(e?.stack ?? e));
      return fail(new ToolFail('failed', { message: String(e?.message ?? e) }));
    }
  }

  return {
    /**
     * 会話ごとに開く。owner() は呼び出しの時点のターン { turnId, sessionId, title, mode, signal, ancestors, agent? }。
     * agent は { id, label }（オーバーレイのピルと承認カードの名前。関数でもよい）。delivery はバックエンドの capabilities.computerUse。
     * token は開き直す口の値（省略なら新しく作る。形が違う・使用中なら投げる）
     */
    open({ origin, owner, locale, agent, delivery, token: fixed }) {
      const token = claimToken(bindings, fixed);
      const d = { ...DEFAULT_DELIVERY, ...(delivery && typeof delivery === 'object' ? delivery : {}) };
      // shot: その会話で最後に撮った全画面の撮影（座標の基準）。display: 切り替えた対象（番号）。known: 見たアプリの id -> 情報
      const binding = { owner, locale, agent, delivery: d, shot: null, display: null, pressed: false, known: new Map(), turns: new Set() };
      bindings.set(token, binding);
      return {
        url: origin + COMPUTER_MCP_PATH,
        headers: { Authorization: `Bearer ${token}` },
        instructions: computerInstructions(locale, d),
        close() { bindings.delete(token); for (const id of binding.turns) lock.endTurn(id); binding.turns.clear(); },
      };
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
        for await (const chunk of req) { size += chunk.length; if (size > 256000) return reply(413); chunks.push(chunk); }
        m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply(400);
      if (m.id === undefined) return reply(202);
      const { locale } = binding;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ply_computer', version: '1.0.0' } };  // instructions は systemPrompt の append だけで渡す（二重にしない。ADR 0169）
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: computerTools(locale) };
      else if (m.method === 'tools/call') {
        const args = m.params?.arguments ?? {};
        // 知らない引数は無視する（失敗にしない）。引数の形が object でなければ断る
        result = !args || typeof args !== 'object' || Array.isArray(args) ? plain(locale, agentT(locale, 'computer.errors.invalid', {})) : await callTool(binding, m.params?.name, args);
      } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
