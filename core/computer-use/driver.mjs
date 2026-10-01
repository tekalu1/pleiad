// main（Electron）への往復の口（docs/computer-use.md「core と main（parentPort）」）と、テスト用の偽の driver。
//
// どちらも同じ形の driver を返す:
//   state()                    { supported, reason?, displays, displaysVersion } | null（main の computer-ready をまだ受けていない）
//   onReady(cb) / onDisplays(cb) / onEscape(cb)   main からの便り。戻り値は外す関数
//   call(owner, op, args)      main に操作を頼む（op は契約の表）。失敗は ComputerError（code, message）
//   arm(owner)                 ロックの持ち主が変わった（null で持ち主なし）。持ち主がいる間は 10 秒ごとに computer-heartbeat も送る
//   overlay(message)           computer-overlay。message は { owner, state, display, agent, title, cursor? }
//   stop(owner) / turnEnded(owner)
// main は A（desktop/computer/*）の持ち物。ここは契約どおりのメッセージを送る側と、AGENT_HOST_COMPUTER_DRIVER=fake の偽の driver だけ。
import { fitScale, SHOT_LIMITS } from './coords.mjs';

export class ComputerError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const HEARTBEAT_MS = 10_000;
// main の操作の上限時間（10 秒、launch は 15 秒）より少し長く待つ。main が応答しないときに呼び出しが固まらないための保険
const CALL_TIMEOUT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 25_000;

/** parentPort 越しの driver。port が無い（Electron でない）ときは null */
export function parentPortComputer(port, { timeoutMs = CALL_TIMEOUT_MS, launchTimeoutMs = LAUNCH_TIMEOUT_MS, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!port) return null;
  const pending = new Map();
  const listeners = { ready: new Set(), displays: new Set(), escape: new Set() };
  let ready = null;
  let next = 0;
  let heartbeat = null;
  let heartbeatOwner = null;
  const listen = (set, cb) => { set.add(cb); return () => set.delete(cb); };
  const fire = (set, ...args) => { for (const cb of [...set]) { try { cb(...args); } catch (e) { console.error('computer driver:', String(e?.message ?? e)); } } };
  const failAll = error => { for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.reject(error); } };

  port.on('message', event => {
    const message = event?.data ?? event;
    switch (message?.type) {
      case 'computer-ready':
        // main か core が作り直された。待っていた呼び出しはもう返らない
        if (ready) failAll(new ComputerError('failed', 'computer service restarted'));
        ready = { supported: message.supported === true, ...(message.reason ? { reason: message.reason } : {}), displays: Array.isArray(message.displays) ? message.displays : [], displaysVersion: Number(message.displaysVersion) || 0 };
        fire(listeners.ready, ready);
        break;
      case 'computer-displays-changed':
        if (!ready) break;
        ready = { ...ready, displays: Array.isArray(message.displays) ? message.displays : ready.displays, displaysVersion: Number(message.displaysVersion) || ready.displaysVersion + 1 };
        fire(listeners.displays, ready);
        break;
      case 'computer-escape':
        fire(listeners.escape, message.owner);
        break;
      case 'computer-result': {
        const item = pending.get(message.id);
        if (!item) break;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.ok) item.resolve(message.data);
        else item.reject(new ComputerError(message.error?.code ?? 'failed', message.error?.message));
        break;
      }
      default:
    }
  });
  port.postMessage({ type: 'computer-ready-request' });

  return {
    kind: 'electron',
    state: () => ready,
    onReady: cb => listen(listeners.ready, cb),
    onDisplays: cb => listen(listeners.displays, cb),
    onEscape: cb => listen(listeners.escape, cb),
    call(owner, op, args = {}) {
      if (ready && !ready.supported) return Promise.reject(new ComputerError('unsupported', `computer use is not supported (${ready.reason ?? 'unknown'})`));
      return new Promise((resolve, reject) => {
        const id = `cu${++next}`;
        const limit = op === 'launch' ? launchTimeoutMs : timeoutMs;
        const timer = setTimeout(() => { pending.delete(id); reject(new ComputerError('timeout', `${op} timed out`)); }, limit);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: 'computer-call', id, owner, op, args });
      });
    },
    arm(owner) {
      port.postMessage({ type: 'computer-arm', owner: owner ?? null });
      heartbeatOwner = owner ?? null;
      if (heartbeatOwner && !heartbeat) {
        heartbeat = setInterval(() => { if (heartbeatOwner) port.postMessage({ type: 'computer-heartbeat', owner: heartbeatOwner }); }, heartbeatMs);
        heartbeat.unref?.();
      } else if (!heartbeatOwner && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
    overlay(message) { port.postMessage({ type: 'computer-overlay', ...message }); },
    stop(owner) { port.postMessage({ type: 'computer-stop', owner }); },
    turnEnded(owner) { port.postMessage({ type: 'computer-turn-ended', owner }); },
  };
}

// ---- 偽の driver -------------------------------------------------------------------------
// 決まった画像を返し、頼まれた操作を記録するだけ。実画面には何もしない（AGENT_HOST_COMPUTER_DRIVER=fake と単体テスト）。
const FAKE_JPEG = Buffer.from('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', 'base64');

const app = (id, name, extra = {}) => ({ id, kind: id.startsWith('aumid:') ? 'aumid' : 'exe', name, elevated: false, self: false, ...extra });
export const FAKE_APPS = Object.freeze({
  notepad: app('exe:c:/windows/system32/notepad.exe', 'メモ帳', { path: 'C:\\Windows\\System32\\notepad.exe', pid: 1001 }), // i18n-ignore: テスト用の偽のアプリ名
  calc: app('aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', '電卓', { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', pid: 1002 }), // i18n-ignore: テスト用の偽のアプリ名
  explorer: app('exe:c:/windows/explorer.exe', 'エクスプローラー', { path: 'C:\\Windows\\explorer.exe', pid: 1003 }), // i18n-ignore: テスト用の偽のアプリ名
  terminal: app('exe:c:/program files/windowsapps/microsoft.windowsterminal_1.21/windowsterminal.exe', 'Windows Terminal', { path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe', pid: 1004 }),
  admin: app('exe:c:/tools/adminpanel.exe', '管理ツール', { path: 'C:\\Tools\\AdminPanel.exe', pid: 1005, elevated: true }), // i18n-ignore: テスト用の偽のアプリ名
  pleiad: app('exe:c:/users/x/appdata/local/programs/pleiad/ply.exe', 'Pleiad', { path: 'C:\\Users\\x\\AppData\\Local\\Programs\\Pleiad\\Ply.exe', pid: 1006, self: true }),
});

const FAKE_DISPLAYS = [
  { id: 'fake-1', index: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, primary: true },
  { id: 'fake-2', index: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scale: 1.25, primary: false },
];

/**
 * 偽の driver。
 * 点の下のアプリ（appAt）は物理座標で決める: y ≥ 1000 は Windows Terminal（禁止）、y ≥ 900 はエクスプローラー（高リスク）、
 * x ≥ 3000 は管理者権限のアプリ（uipi）、x ≥ 1920 は電卓、それ以外はメモ帳。前面（foreground）は既定でメモ帳（setForeground で替える）。
 * 失敗の注入: fail(op, code) で次の 1 回を失敗にする。setLocked(true) で撮影と入力が locked になる。pressEscape(owner) で main の Esc を真似る。
 * log は、呼ばれた操作と core から main への便り（arm・overlay・stop・turnEnded）を 1 件ずつ受ける関数（サーバー越しのテストが別プロセスの記録を読む）。
 */
export function fakeComputerDriver({ supported = true, reason, displays = FAKE_DISPLAYS, delayMs = 0, log = null } = {}) {
  let ready = { supported, ...(reason ? { reason } : {}), displays: structuredClone(displays), displaysVersion: 1 };
  const listeners = { ready: new Set(), displays: new Set(), escape: new Set() };
  const listen = (set, cb) => { set.add(cb); return () => set.delete(cb); };
  const fire = (set, ...args) => { for (const cb of [...set]) cb(...args); };
  const failures = [];
  let locked = false;
  let foreground = FAKE_APPS.notepad;
  let cursor = { x: 100, y: 100 };
  const running = new Set([FAKE_APPS.notepad.id]);
  const note = entry => { try { log?.(entry); } catch { /* 記録は確認用 */ } };
  const self = {
    kind: 'fake',
    /** 呼ばれた操作（{ owner, op, args }）。入力は actions を含む */
    calls: [], arms: [], overlays: [], stops: [], turnsEnded: [], heartbeats: 0,
    state: () => ready,
    onReady: cb => listen(listeners.ready, cb),
    onDisplays: cb => listen(listeners.displays, cb),
    onEscape: cb => listen(listeners.escape, cb),
    fail(op, code = 'failed', message) { failures.push({ op, code, message }); },
    setLocked(v) { locked = Boolean(v); },
    setForeground(a) { foreground = a; },
    setSupported(v, why) { ready = { ...ready, supported: Boolean(v), ...(why ? { reason: why } : {}) }; fire(listeners.ready, ready); },
    /** ディスプレイの構成が変わったことにする（displaysVersion が 1 進む） */
    changeDisplays(next) { ready = { ...ready, displays: next ?? ready.displays, displaysVersion: ready.displaysVersion + 1 }; fire(listeners.displays, ready); },
    pressEscape(owner) { fire(listeners.escape, owner); },
    arm(owner) { self.arms.push(owner ?? null); note({ kind: 'arm', owner: owner ?? null }); },
    overlay(message) { self.overlays.push(message); note({ kind: 'overlay', ...message }); },
    stop(owner) { self.stops.push(owner); note({ kind: 'stop', owner }); },
    turnEnded(owner) { self.turnsEnded.push(owner); note({ kind: 'turnEnded', owner }); },
    async call(owner, op, args = {}) {
      self.calls.push({ owner, op, args: structuredClone(args) });
      note({ kind: 'call', owner, op, args });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      if (!ready.supported) throw new ComputerError('unsupported', 'fake: unsupported');
      const i = failures.findIndex(f => f.op === op);
      if (i >= 0) { const f = failures.splice(i, 1)[0]; throw new ComputerError(f.code, f.message ?? `fake: ${f.code}`); }
      switch (op) {
        case 'displays': return { displays: ready.displays, displaysVersion: ready.displaysVersion };
        case 'screenshot': {
          if (locked) throw new ComputerError('locked', 'fake: locked');
          const d = ready.displays.find(x => x.id === args.display) ?? ready.displays.find(x => x.index === args.display) ?? ready.displays[0];
          const r = args.region ?? d.bounds;
          const limits = { maxPixels: args.maxPixels ?? SHOT_LIMITS.maxPixels, maxEdge: args.maxEdge ?? SHOT_LIMITS.maxEdge };
          let scale = fitScale(r.width, r.height, limits);
          // zoom（upscale）は上限まで拡大してよい
          if (args.upscale) scale = Math.min(Math.sqrt(limits.maxPixels / (r.width * r.height)), limits.maxEdge / Math.max(r.width, r.height));
          return { jpeg: new Uint8Array(FAKE_JPEG), width: Math.max(1, Math.floor(r.width * scale)), height: Math.max(1, Math.floor(r.height * scale)), scale, origin: { x: r.x, y: r.y }, displaysVersion: ready.displaysVersion };
        }
        case 'appAt': {
          const { x, y } = args;
          if (x >= 3000) return { app: FAKE_APPS.admin };
          if (y >= 1000) return { app: FAKE_APPS.terminal };
          if (y >= 900) return { app: FAKE_APPS.explorer };
          if (x >= 1920) return { app: FAKE_APPS.calc };
          return { app: FAKE_APPS.notepad };
        }
        case 'foreground': return { app: foreground };
        case 'findApp': {
          const q = String(args.name ?? '').toLowerCase();
          const hits = Object.values(FAKE_APPS).filter(a => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || (a.path && a.path.toLowerCase().includes(q)));
          return { apps: hits.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q)) };
        }
        case 'input': {
          if (locked) throw new ComputerError('locked', 'fake: locked');
          const actions = args.actions ?? [];
          for (const a of actions) {
            const at = a.type === 'drag' ? a.to : a;
            if (Number.isFinite(at?.x) && Number.isFinite(at?.y)) {
              if (!ready.displays.some(d => at.x >= d.bounds.x && at.y >= d.bounds.y && at.x < d.bounds.x + d.bounds.width && at.y < d.bounds.y + d.bounds.height)) throw new ComputerError('outside', 'fake: outside');
              cursor = { x: at.x, y: at.y };
            }
            if (a.type === 'key' || a.type === 'keyDown') {
              if (/(^|\+)(super|win|meta)(\+|$)/i.test(String(a.combo ?? ''))) throw new ComputerError('windows_key', 'fake: windows key');
            }
          }
          return { done: actions.length, cursor };
        }
        case 'cursor': return { ...cursor };
        case 'launch': {
          const a = args.app;
          if (!a?.id || !Object.values(FAKE_APPS).some(x => x.id === a.id)) throw new ComputerError('not_found', 'fake: not found');
          const already = running.has(a.id);
          running.add(a.id);
          return { started: !already, alreadyRunning: already, app: a };
        }
        case 'releaseAll': return { released: [] };
        default: throw new ComputerError('failed', `fake: unknown op ${op}`);
      }
    },
  };
  // heartbeat は数えるだけ（arm の持ち主がいる間、本物は 10 秒ごとに送る）
  return self;
}
