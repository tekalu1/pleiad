// ply_computer の各ツールの中身（docs/computer-use.md「ツール」「入力の前のゲート」）。
// 呼ばれる前にロックは取ってある（ロックを取らないツールを除く）。失敗は ToolFail を投げ、橋が印の行と文にする。
import { agentT } from '../i18n.mjs';
import { SHOT_LIMITS, toPhysical, toImage, inShot, regionToPhysical, displayAt } from './coords.mjs';
import { decideApp, autoGrantKind, normalizeComputerUse, isUnattendedMode } from './policy.mjs';
import { ComputerError } from './driver.mjs';
import { BATCHABLE, MAX_BATCH, MAX_SECONDS, untilSeconds } from './tools.mjs';
import { isForbiddenApp } from './apps.mjs';
import { settle, SETTLE } from './settle.mjs';
import { askDecider, DECIDER_SHOT, UNTIL_MAX } from './decider.mjs';

/** 止めた・ロック・禁止・拒否・待ちの上限・更新で main が居ないための停止は、画面で失敗に数えない（state: stopped）。それ以外は failed */
const STOPPED_REASONS = new Set(['escape', 'stop', 'update', 'locked', 'forbidden', 'denied', 'busy']);
export const stateOfReason = reason => (STOPPED_REASONS.has(reason) ? 'stopped' : 'failed');

export class ToolFail extends Error {
  constructor(reason, params = {}) { super(reason); this.reason = reason; this.params = params; this.state = stateOfReason(reason); }
}
const fail = (reason, params) => { throw new ToolFail(reason, params); };

const MODIFIERS = new Set(['ctrl', 'shift', 'alt']);
// macOS は ⌘ を使う（ADR 0173 §4）。OS の機能を呼ぶ組み合わせ（Spotlight など）は main が system_key で拒む
const MAC_MODIFIERS = new Set([...MODIFIERS, 'cmd', 'command']);
const WINDOWS_KEY = /(^|[+\s,])(super|win|windows|meta|cmd|command)([+\s,]|$)/i;
const num = v => typeof v === 'number' && Number.isFinite(v);
// main が返す契約の code のうち、そのまま reason にするもの（permission・secure_input・system_key は macOS だけが返す）
const PASS_CODES = new Set(['locked', 'uipi', 'self', 'windows_key', 'outside', 'not_found', 'timeout', 'unsupported', 'permission', 'secure_input', 'system_key']);

/** text の修飾キー（ctrl / shift / alt。macOS は cmd も。"ctrl+shift" の形も受ける）。不正なら invalid */
function modifiers(text, allowed = MODIFIERS) {
  if (text === undefined || text === null || text === '') return undefined;
  if (typeof text !== 'string') fail('invalid');
  const list = text.toLowerCase().split(/[+\s,]+/).filter(Boolean);
  if (!list.length || !list.every(m => allowed.has(m))) fail('invalid');
  return [...new Set(list)];
}

/**
 * @param driver main への口（core/computer-use/driver.mjs）
 * @param shots スクリーンショットの保存（core/computer-use/shots.mjs）
 * @param access { getPrefs(), sessionApps(sessionId), rememberSession(sessionId, apps), rememberAlways(app), markIntroduced() }
 * @param askPermission server の askPermission
 * @param translate server の t（承認カードの見出し）
 * @param decider wait_until の問いの口 { key(): 選んだキーか null, ask: askDecider と同じ形 }（core/computer-use/decider.mjs）
 * @param platform 操作する PC の OS（process.platform）。darwin では ⌘ を通す
 */
export function createActions({ driver, shots, access, askPermission, translate, decider = {}, platform = process.platform }) {
  const mac = platform === 'darwin';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deciderKey = decider.key ?? (async () => null);
  const askDecision = decider.ask ?? askDecider;

  // ---- 共通の部品 ----------------------------------------------------------------------
  // i18n-dynamic: agent:computer.
  const L = (ctx, key, params) => agentT(ctx.locale, `computer.${key}`, params);
  /** 完了の文。対象のアプリが分かっていれば「（メモ帳）」を足す */
  const done = (ctx, key, app, params) => L(ctx, key, params) + (app ? L(ctx, 'onApp', { app: nameOf(app) }) : '');

  /** 止めた印・ターンの中断を見て、あれば止める。動作の切れ目ごとに呼ぶ */
  function checkStopped(ctx) {
    if (ctx.t.stopped) fail(ctx.t.stopped.reason);
    if (ctx.signal?.aborted) fail('stop');
  }

  /** main への頼みごと。失敗は契約の code から reason へ */
  async function call(ctx, op, args) {
    checkStopped(ctx);
    try { return await driver.call(ctx.turnId, op, args); }
    catch (e) {
      if (!(e instanceof ComputerError)) fail('failed', { message: String(e?.message ?? e) });
      if (e.code === 'stopped') { ctx.t.stopped ??= { reason: 'escape', at: Date.now() }; fail(ctx.t.stopped.reason); }
      // main が居ない（Pleiad の更新中）。Esc と同じに、このターンの操作を止める（core/computer-use/lock.mjs の stopAll と同じ印）
      if (e.code === 'away') { ctx.t.stopped ??= { reason: 'update', at: Date.now() }; fail(ctx.t.stopped.reason); }
      if (e.code === 'permission') fail('permission', { what: L(ctx, e.permission === 'accessibility' ? 'permissionNames.accessibility' : 'permissionNames.screen') });
      if (PASS_CODES.has(e.code)) fail(e.code, { message: e.message });
      fail('failed', { message: e.message });
    }
  }

  const displaysOf = () => driver.state()?.displays ?? [];

  /** 撮影・切り替えの対象のディスプレイ（切り替えていなければ主ディスプレイ） */
  function targetDisplay(ctx) {
    const displays = displaysOf();
    const d = displays.find(x => x.index === ctx.binding.display) ?? displays.find(x => x.primary) ?? displays[0];
    if (!d) fail('failed', { message: 'no display' });
    return d;
  }

  /** その会話で最後に撮った全画面の撮影。無い・古い（別のターン・構成が変わった）ときは失敗 */
  function currentShot(ctx) {
    const shot = ctx.binding.shot;
    if (!shot || shot.turnId !== ctx.turnId) fail('no_shot');
    if (shot.displaysVersion !== driver.state()?.displaysVersion) fail('stale');
    return shot;
  }

  /** 画像の座標 [x, y] を物理座標へ。省略できるときの省略は null */
  function physicalOf(ctx, coord, { optional = false } = {}) {
    if (coord === undefined || coord === null) { if (optional) return null; fail('invalid'); }
    if (!Array.isArray(coord) || coord.length !== 2 || !coord.every(num)) fail('invalid');
    const shot = currentShot(ctx);
    const p = toPhysical(shot, coord[0], coord[1]);
    if (!p) fail('outside', { w: shot.width, h: shot.height });
    return p;
  }

  async function cursorPoint(ctx) { return call(ctx, 'cursor', {}); }

  const nameOf = app => app?.name || app?.id || '';
  const remember = (ctx, app) => { if (app?.id) ctx.binding.known.set(app.id, app); };

  /** オーバーレイに「操作中」を出す（入力・撮影の後） */
  function activity(ctx, { cursor, display } = {}) {
    try {
      const d = display ?? (cursor ? displayAt(displaysOf(), cursor.x, cursor.y) : null) ?? targetDisplay(ctx);
      // オーバーレイには display の要素そのもの（{ id, index, bounds, … }）を渡す。main は物理の bounds でどのモニターかを決める
      driver.overlay({ owner: ctx.turnId, state: 'activity', display: d ?? null, agent: ctx.agent.label, title: ctx.info.title ?? '',
        ...(cursor ? { cursor: { x: cursor.x, y: cursor.y, pressed: ctx.binding.pressed } } : {}) });
    } catch { /* オーバーレイは見た目だけ。操作の結果には響かせない */ }
  }

  // ---- アプリの承認 --------------------------------------------------------------------
  async function sessionApps(ctx) { return [...(await access.sessionApps(ctx.sessionId)), ...ctx.t.granted]; }

  /**
   * 承認のカードを出して答えを待つ。聞く間はオーバーレイを消す。許可なら true。
   * apps は [{ app, risk }]。答え（scope）が once ならこのターンだけ、session なら会話、always なら常に許可へ
   */
  async function ask(ctx, apps, reason) {
    const previous = ctx.t.askChain ?? Promise.resolve();
    let release;
    ctx.t.askChain = new Promise(r => { release = r; });
    try {
      await previous;
      // 待つ間に別の呼び出しが許可・拒否していることがある
      const pending = apps.filter(({ app }) => !ctx.t.denied.has(app.id) && !(ctx.t.granted.has(app.id)));
      if (!pending.length) return !apps.some(({ app }) => ctx.t.denied.has(app.id));
      const prefs = await access.getPrefs();
      const known = new Set(await sessionApps(ctx));
      const need = pending.filter(({ app }) => !known.has(app.id));
      if (!need.length) return true;
      const first = !normalizeComputerUse(prefs.computerUse).introduced;
      try { driver.overlay({ owner: ctx.turnId, state: 'hide', display: null, agent: ctx.agent.label, title: ctx.info.title ?? '' }); } catch {}
      // i18n-dynamic: server:permission.computerApp
      const names = need.map(({ app }) => nameOf(app)).join(translate('permission.computerAppJoin'));
      const answer = await askPermission({
        toolName: 'ply_computer', input: {}, sessionId: ctx.sessionId, kind: 'tool', canAlways: true, signal: ctx.signal, locale: ctx.locale,
        title: translate('permission.computerApp', { agent: ctx.agent.label, app: names }),
        computerApp: { agent: { id: ctx.agent.id, label: ctx.agent.label }, apps: need.map(({ app, risk }) => ({ id: app.id, name: nameOf(app), risk })), ...(reason ? { reason } : {}), first },
      });
      if (first) await access.markIntroduced().catch(() => {});
      if (ctx.signal?.aborted) fail('stop');
      const scope = answer?.scope ?? (answer?.always ? 'always' : 'once');
      if (!answer?.allow) { for (const { app } of need) ctx.t.denied.add(app.id); return false; }
      if (scope === 'always') for (const { app } of need) await access.rememberAlways({ id: app.id, name: nameOf(app), kind: app.kind, ...(app.path ? { path: app.path } : {}), at: new Date().toISOString() });
      else if (scope === 'session') await access.rememberSession(ctx.sessionId, need.map(({ app }) => app.id));
      else for (const { app } of need) ctx.t.granted.add(app.id);
      return true;
    } finally { release(); }
  }

  /**
   * アプリを操作してよいか決め、必要なら聞く。通れば { grant? } を返し、通らなければ ToolFail。
   * grant は、確認なし・すべて許可で承認を飛ばしたとき、そのアプリのターンで最初の呼び出しにだけ付ける
   */
  async function authorize(ctx, app) {
    if (!app) return {};
    remember(ctx, app);
    const prefs = await access.getPrefs();
    const apps = await sessionApps(ctx);
    const args = { app, prefs, sessionApps: apps, deniedThisTurn: ctx.t.denied, mode: ctx.info.mode, agent: ctx.agent.id };
    const decision = decideApp(args);
    if (decision === 'forbidden') fail('forbidden', { app: nameOf(app) });
    if (decision === 'denied') fail('denied', { app: nameOf(app) });
    if (decision === 'allow') {
      const kind = autoGrantKind(args);
      if (kind && !ctx.t.grantNoted.has(app.id)) { ctx.t.grantNoted.add(app.id); return { grant: kind }; }
      return {};
    }
    if (!(await ask(ctx, [{ app, risk: decision === 'ask-high' ? 'high' : 'normal' }]))) fail('denied', { app: nameOf(app) });
    return {};
  }

  /** 点の下のアプリを聞いて判定する。通ればそのアプリ（と grant） */
  async function authorizeAt(ctx, p) {
    const { app } = await call(ctx, 'appAt', { x: p.x, y: p.y });
    const { grant } = await authorize(ctx, app);
    return { app, grant };
  }
  async function authorizeForeground(ctx) {
    const { app } = await call(ctx, 'foreground', {});
    const { grant } = await authorize(ctx, app);
    return { app, grant };
  }

  /** 複数の点を判定する（ドラッグの始点と終点）。同じアプリは 1 回だけ。grant はどれかにあれば付ける */
  async function authorizePoints(ctx, points) {
    let first = null, grant;
    for (const p of points) {
      const r = await authorizeAt(ctx, p);
      first ??= r.app;
      grant ??= r.grant;
    }
    return { app: first, grant };
  }

  // ---- 画像 ----------------------------------------------------------------------------
  async function capture(ctx, args) {
    const data = await call(ctx, 'screenshot', { quality: SHOT_LIMITS.quality, maxPixels: SHOT_LIMITS.maxPixels, maxEdge: SHOT_LIMITS.maxEdge, ...args });
    return data;
  }

  // ---- ツール --------------------------------------------------------------------------
  const ACTIONS = {
    async list_granted_applications(ctx) {
      const prefs = await access.getPrefs();
      const cu = normalizeComputerUse(prefs.computerUse);
      const lines = [];
      if (ctx.agent.id === 'antigravity' || isUnattendedMode(ctx.info.mode)) lines.push(L(ctx, 'granted.unattended'));
      else if (cu.allowAllApps) lines.push(L(ctx, 'granted.all'));
      const seen = new Set();
      const add = (id, name, kind) => { if (seen.has(id)) return; seen.add(id); lines.push(L(ctx, `granted.${kind}`, { app: name })); };
      for (const a of cu.alwaysAllowed) add(a.id, a.name || a.id, 'always');
      for (const id of await sessionApps(ctx)) add(id, ctx.binding.known.get(id)?.name ?? cu.alwaysAllowed.find(a => a.id === id)?.name ?? idToName(id), 'session');
      if (!lines.length) lines.push(L(ctx, 'granted.none'));
      return { text: lines.join('\n') };
    },

    async request_access(ctx, args) {
      const names = Array.isArray(args.apps) ? args.apps.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()).slice(0, 10) : [];
      if (!names.length) fail('invalid');
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : undefined;
      const prefs = await access.getPrefs();
      const entries = [];
      for (const name of names) {
        const { apps } = await call(ctx, 'findApp', { name });
        const app = apps?.[0] ?? null;
        if (!app) { entries.push({ name, result: 'not_found' }); continue; }
        remember(ctx, app);
        const decision = decideApp({ app, prefs, sessionApps: await sessionApps(ctx), deniedThisTurn: ctx.t.denied, mode: ctx.info.mode, agent: ctx.agent.id });
        entries.push({ name, app, decision, result: decision === 'allow' ? 'allowed' : decision === 'forbidden' ? 'forbidden' : decision === 'denied' ? 'denied' : 'ask' });
      }
      const asks = [...new Map(entries.filter(e => e.result === 'ask').map(e => [e.app.id, e])).values()];
      if (asks.length) {
        const ok = await ask(ctx, asks.map(e => ({ app: e.app, risk: e.decision === 'ask-high' ? 'high' : 'normal' })), reason);
        for (const e of entries) if (e.result === 'ask') e.result = ok ? 'allowed' : 'denied';
      }
      const lines = entries.map(e => L(ctx, `access.${e.result}`, { app: e.app ? nameOf(e.app) : e.name }));
      const allowed = entries.filter(e => e.result === 'allowed');
      if (!allowed.length) {
        // 1 つも通らなかった。理由はいちばん強いもの（拒否 > 禁止 > 見つからない）
        const why = entries.some(e => e.result === 'denied') ? 'denied' : entries.some(e => e.result === 'forbidden') ? 'forbidden' : 'not_found';
        const f = new ToolFail(why, { app: entries[0]?.app ? nameOf(entries[0].app) : entries[0]?.name });
        f.text = lines.join('\n');
        throw f;
      }
      return { text: lines.join('\n'), app: nameOf(allowed[0].app) };
    },

    async screenshot(ctx, args) {
      const displays = displaysOf();
      if (args.display !== undefined) {
        if (!Number.isInteger(args.display) || !displays.some(d => d.index === args.display)) fail('invalid');
        ctx.binding.display = args.display;
      }
      const d = targetDisplay(ctx);
      const r = await capture(ctx, { display: d.id });
      ctx.binding.shot = { display: d.index, scale: r.scale, origin: r.origin, width: r.width, height: r.height, displaysVersion: r.displaysVersion, turnId: ctx.turnId };
      activity(ctx, { display: d });
      const scaled = r.scale < 1;
      return { text: L(ctx, scaled ? 'screenshotScaled' : 'screenshot', { n: d.index, count: displays.length, w: r.width, h: r.height, rw: d.bounds.width, rh: d.bounds.height }),
        image: r, display: d.index, w: r.width, h: r.height };
    },

    async zoom(ctx, args) {
      const shot = currentShot(ctx);
      const physical = regionToPhysical(shot, args.region);
      if (!physical) fail(Array.isArray(args.region) && args.region.length === 4 && args.region.every(num) ? 'outside' : 'invalid', { w: shot.width, h: shot.height });
      const s = args.scale === undefined ? 1 : args.scale;
      if (!num(s) || s <= 0 || s > 1) fail('invalid');
      const d = displaysOf().find(x => x.index === shot.display) ?? targetDisplay(ctx);
      const r = await capture(ctx, { display: d.id, region: physical, upscale: true, maxPixels: Math.round(SHOT_LIMITS.maxPixels * s), maxEdge: Math.round(SHOT_LIMITS.maxEdge * s) });
      activity(ctx, { display: d });
      return { text: L(ctx, 'zoom', { x0: args.region[0], y0: args.region[1], x1: args.region[2], y1: args.region[3], w: r.width, h: r.height }), image: r, display: d.index, w: r.width, h: r.height };
    },

    async switch_display(ctx, args) {
      const displays = displaysOf();
      if (!Number.isInteger(args.display)) fail('invalid');
      const d = displays.find(x => x.index === args.display);
      if (!d) fail('invalid');
      ctx.binding.display = d.index;
      activity(ctx, { display: d });
      return { text: L(ctx, 'switched', { n: d.index, count: displays.length }), display: d.index };
    },

    async cursor_position(ctx) {
      const shot = currentShot(ctx);
      const c = await cursorPoint(ctx);
      const p = toImage(shot, c.x, c.y);
      if (inShot(shot, p.x, p.y)) return { text: L(ctx, 'cursorAt', { x: p.x, y: p.y }), display: shot.display };
      const other = displayAt(displaysOf(), c.x, c.y);
      return { text: other ? L(ctx, 'cursorOther', { n: other.index }) : L(ctx, 'cursorOutside'), ...(other ? { display: other.index } : {}) };
    },

    mouse_move: (ctx, args) => pointer(ctx, args, { type: 'move' }, 'moved', { required: true }),
    left_click: (ctx, args) => pointer(ctx, args, { type: 'click', button: 'left', count: 1 }, 'clicked'),
    right_click: (ctx, args) => pointer(ctx, args, { type: 'click', button: 'right', count: 1 }, 'rightClicked'),
    middle_click: (ctx, args) => pointer(ctx, args, { type: 'click', button: 'middle', count: 1 }, 'middleClicked'),
    double_click: (ctx, args) => pointer(ctx, args, { type: 'click', button: 'left', count: 2 }, 'doubleClicked'),
    triple_click: (ctx, args) => pointer(ctx, args, { type: 'click', button: 'left', count: 3 }, 'tripleClicked'),
    left_mouse_down: (ctx, args) => pointer(ctx, args, { type: 'down', button: 'left' }, 'mouseDown'),
    left_mouse_up: (ctx, args) => pointer(ctx, args, { type: 'up', button: 'left' }, 'mouseUp'),

    async left_click_drag(ctx, args) {
      const to = physicalOf(ctx, args.coordinate);
      const from = physicalOf(ctx, args.start_coordinate, { optional: true }) ?? await cursorPoint(ctx);
      const { app, grant } = await authorizePoints(ctx, [from, to]);
      const r = await call(ctx, 'input', { actions: [{ type: 'drag', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }] });
      ctx.binding.pressed = false;
      activity(ctx, { cursor: r.cursor });
      return { text: done(ctx, 'dragged', app), app: nameOf(app) || undefined, grant };
    },

    async scroll(ctx, args) {
      const p = physicalOf(ctx, args.coordinate);
      if (!['up', 'down', 'left', 'right'].includes(args.scroll_direction) || !Number.isInteger(args.scroll_amount) || args.scroll_amount < 1) fail('invalid');
      const { app, grant } = await authorizeAt(ctx, p);
      const r = await call(ctx, 'input', { actions: [{ type: 'scroll', x: p.x, y: p.y, direction: args.scroll_direction, amount: args.scroll_amount }] });
      activity(ctx, { cursor: r.cursor });
      return { text: done(ctx, 'scrolled', app, { direction: args.scroll_direction }), app: nameOf(app) || undefined, grant };
    },

    async type(ctx, args) {
      if (typeof args.text !== 'string' || !args.text.length || args.text.length > 20_000) fail('invalid');
      const { app, grant } = await authorizeForeground(ctx);
      const r = await call(ctx, 'input', { actions: [{ type: 'text', text: args.text }] });
      activity(ctx, { cursor: r.cursor });
      return { text: done(ctx, 'typed', app, { count: [...args.text].length }), app: nameOf(app) || undefined, grant };
    },

    async key(ctx, args) {
      const combo = keyCombo(args.text);
      const repeat = args.repeat === undefined ? undefined : args.repeat;
      if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)) fail('invalid');
      const { app, grant } = await authorizeForeground(ctx);
      const r = await call(ctx, 'input', { actions: [{ type: 'key', combo, ...(repeat ? { repeat } : {}) }] });
      activity(ctx, { cursor: r.cursor });
      return { text: done(ctx, 'keyPressed', app, { combo }), app: nameOf(app) || undefined, grant };
    },

    async hold_key(ctx, args) {
      const combo = keyCombo(args.text);
      if (!num(args.duration) || args.duration <= 0) fail('invalid');
      const seconds = Math.min(args.duration, MAX_SECONDS);
      const { app, grant } = await authorizeForeground(ctx);
      await call(ctx, 'input', { actions: [{ type: 'keyDown', combo }] });
      let held = true;
      try {
        await waitInterruptibly(ctx, seconds * 1000);
      } finally {
        if (held) { held = false; await driver.call(ctx.turnId, 'input', { actions: [{ type: 'keyUp', combo }] }).catch(() => {}); }
      }
      activity(ctx);
      return { text: done(ctx, 'keyHeld', app, { combo, seconds }), app: nameOf(app) || undefined, grant };
    },

    async wait(ctx, args) {
      if (!num(args.duration) || args.duration <= 0) fail('invalid');
      const seconds = Math.min(args.duration, MAX_SECONDS);
      await waitInterruptibly(ctx, seconds * 1000);
      return { text: L(ctx, 'waited', { seconds }) };
    },

    async wait_until(ctx, args) {
      if (args.until !== undefined && args.until !== null && typeof args.until !== 'string') fail('invalid');
      const seconds = untilSeconds(args.timeout);
      if (seconds === null) fail('invalid');
      const until = typeof args.until === 'string' ? args.until.trim().replace(/\s+/g, ' ').slice(0, UNTIL_MAX) : '';
      const d = targetDisplay(ctx);
      // 人がキーを選ぶまでは画面を送らない（ADR 0155）。選んでいなければ問いを使わず、差分だけで待つ
      const key = until ? await deciderKey().catch(() => null) : null;
      activity(ctx, { display: d });
      const grab = async () => {
        const r = await capture(ctx, { display: d.id, gray: true, maxEdge: SETTLE.frameEdge, maxPixels: SETTLE.frameEdge * SETTLE.frameEdge });
        if (!ArrayBuffer.isView(r?.gray)) fail('failed', { message: 'no frame' });
        return r;
      };
      let skippedApp = '';
      const askOnce = key ? async () => {
        // 前面が操作できないアプリ（ターミナル・パスワード管理・Pleiad 自身など）の画面は送らない
        const { app } = await call(ctx, 'foreground', {});
        if (isForbiddenApp(app)) { skippedApp = nameOf(app); return { skip: 'protected_app' }; }
        skippedApp = '';
        const shot = await capture(ctx, { display: d.id, ...DECIDER_SHOT });
        checkStopped(ctx);
        return askDecision({ key, jpeg: shot.jpeg, until, signal: ctx.signal });
      } : null;
      const noKey = Boolean(until) && !key;
      let r = await settle({ grab, ask: askOnce, timeoutMs: seconds * 1000, sleep, check: () => checkStopped(ctx) });
      // 問いがあるのにキーが無ければ、画面が止まっても問いは確かめていない
      if (noKey && r.status === 'success') r = { ...r, status: 'unverified', reason: 'no_key' };
      activity(ctx, { display: d });
      return { text: untilText(ctx, r, { until, noKey, app: skippedApp }), wait: untilResult(r) };
    },

    async open_application(ctx, args) {
      if (typeof args.app !== 'string' || !args.app.trim()) fail('invalid');
      const { apps } = await call(ctx, 'findApp', { name: args.app.trim() });
      const app = apps?.[0];
      if (!app) fail('not_found', { app: args.app.trim() });
      const { grant } = await authorize(ctx, app);
      let r;
      try { r = await call(ctx, 'launch', { app }); }
      catch (e) { if (e instanceof ToolFail && e.reason === 'not_found') fail('not_found', { app: nameOf(app) }); throw e; }
      activity(ctx);
      return { text: L(ctx, r.alreadyRunning ? 'alreadyRunning' : 'launched', { app: nameOf(r.app ?? app) }), app: nameOf(r.app ?? app) || undefined, grant };
    },

    async computer_batch(ctx, args) {
      const list = Array.isArray(args.actions) ? args.actions : null;
      if (!list || !list.length || list.length > MAX_BATCH) fail('invalid');
      const actions = [], lines = [];
      let image = null, last = null, grant, failure = null;
      for (const [i, item] of list.entries()) {
        const name = item?.action;
        const one = { tool: typeof name === 'string' ? name : '?', state: 'ok' };
        try {
          if (!BATCHABLE.includes(name)) fail('invalid');
          checkStopped(ctx);
          const r = await ACTIONS[name](ctx, item);
          if (r.app) one.app = r.app;
          if (r.image) { image = r.image; last = r; }
          grant ??= r.grant;
          lines.push(`${i + 1}. ${name}: ${r.text}`);
        } catch (e) {
          if (!(e instanceof ToolFail)) throw e;
          one.state = e.state; one.reason = e.reason;
          if (e.params?.app) one.app = e.params.app;
          lines.push(`${i + 1}. ${name}: ${failText(ctx, e)}`);
          failure = e;
        }
        actions.push(one);
        if (failure) break;
      }
      const out = { text: lines.join('\n'), actions, grant, ...(image ? { image, display: last.display, w: last.w, h: last.h } : {}) };
      if (failure) { failure.partial = out; throw failure; }
      return out;
    },
  };

  /** マウスの動作。coordinate を省くと今のカーソルの位置 */
  async function pointer(ctx, args, action, doneKey, { required = false } = {}) {
    const p = physicalOf(ctx, args.coordinate, { optional: !required });
    const mods = action.type === 'click' ? modifiers(args.text, mac ? MAC_MODIFIERS : MODIFIERS) : undefined;
    const at = p ?? await cursorPoint(ctx);
    const { app, grant } = await authorizeAt(ctx, at);
    const send = { ...action, ...(p ? { x: p.x, y: p.y } : {}), ...(mods ? { modifiers: mods } : {}) };
    const r = await call(ctx, 'input', { actions: [send] });
    if (action.type === 'down') ctx.binding.pressed = true;
    else if (action.type === 'up' || action.type === 'click') ctx.binding.pressed = false;
    activity(ctx, { cursor: r.cursor });
    return { text: done(ctx, doneKey, app), app: nameOf(app) || undefined, grant };
  }

  function keyCombo(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200 || /[\r\n]/.test(text)) fail('invalid');
    if (!mac && WINDOWS_KEY.test(text)) fail('windows_key');
    return text.trim();
  }

  /**
   * wait_until の結果の決まった語（言語に依らない。印の行の wait）。キーの値は入らない。
   * status: success（条件を満たした）・timeout・unverified（止まったが問いを確かめていない）・error（決定モデルに聞けなかった）
   */
  function untilResult(r) {
    return { status: r.status, screen: r.screen, answer: r.answer, ...(r.reason ? { reason: r.reason } : {}),
      ...(r.p !== null ? { p_yes: r.p } : {}), checks: r.asks, waited_ms: r.waitedMs };
  }
  /** wait_until の結果の文（会話の言語の 1 文）。何が起きたかと待った時間 */
  function untilText(ctx, r, { until, noKey, app }) {
    const seconds = (r.waitedMs / 1000).toFixed(1);
    const key = r.status === 'success' ? (r.answer === 'yes' ? (r.screen === 'stable' ? 'yes' : 'yesChanging') : r.sawChange ? 'still' : 'alreadyStill')
      : r.status === 'unverified' ? (r.reason === 'no_key' ? 'noKey' : 'protectedApp')
      : r.status === 'error' ? 'error'
      : r.asks ? 'notYet' : noKey ? 'neverStillNoKey' : app ? 'neverStillProtected' : until ? 'neverStillAsk' : 'neverStill';
    return L(ctx, `until.${key}`, { seconds, app, count: r.asks, ...(r.status === 'error' ? { reason: deciderReason(ctx, r.reason) } : {}) });
  }
  /** 決定モデルに聞けなかった理由（決まった code から。キーも応答の本文も含めない） */
  function deciderReason(ctx, code) {
    const status = /^http_(\d{3})$/.exec(String(code ?? ''))?.[1];
    if (!status) return L(ctx, `until.reason.${['timeout', 'network', 'bad_response'].includes(code) ? code : 'bad_response'}`);
    const n = Number(status);
    return L(ctx, n === 401 || n === 403 ? 'until.reason.auth' : n === 402 ? 'until.reason.credits' : n === 429 ? 'until.reason.rate' : n >= 500 ? 'until.reason.server' : 'until.reason.http', { status });
  }

  /** 止められるまで待つ（50ms 刻みで止めた印とターンの中断を見る） */
  async function waitInterruptibly(ctx, ms) {
    const end = Date.now() + ms;
    for (;;) {
      checkStopped(ctx);
      const left = end - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(50, left));
    }
  }

  /** 失敗の文（agent 名前空間 computer.errors.<reason>）。f.text があればそれを優先する（request_access の一覧） */
  // i18n-dynamic: agent:computer.errors.
  const failText = (ctx, e) => e.text ?? agentT(ctx.locale, `computer.errors.${e.reason === 'outside' && e.params?.w === undefined ? 'outsideScreen' : e.reason}`, e.params);

  return { perform: (ctx, name, args) => ACTIONS[name](ctx, args), failText, has: name => Object.hasOwn(ACTIONS, name) };
}

/** id から作る名前（exe のファイル名・AUMID）。名前が分からないとき（list_granted_applications）のため */
function idToName(id) {
  if (String(id).startsWith('exe:')) return String(id).slice(4).split('/').pop();
  if (String(id).startsWith('bundle:')) return String(id).slice(7);
  return String(id).replace(/^aumid:/, '').split('!')[0];
}
