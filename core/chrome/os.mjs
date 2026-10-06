// OS ごとの層の口（docs/inapp-browser.md「OS ごとの層」、ADR 0153）。
//
// 窓を前に出す・確認の窓を見つけて閉じる、といった OS で違う操作は、すべてこの口の向こう（Electron main の desktop/chrome-os/<os>.cjs）に
// 閉じ込める。core/chrome/ のほかのファイルは OS の値（窓のハンドルなど）を解釈せず、この口だけを呼ぶ。
// 実装があるのは Windows だけ。ほかの OS・Electron の無いホストでは capabilities().supported が false になり、
// エージェントのブラウザーは「この OS ではまだ使えません」になる。
//
// どの口も、使えない OS・使えない機能・時間切れでは投げずに null / false を返す（呼び出し側は、層が無くても進める作りにする）。
//
// @typedef {{ id: string }} WindowRef   層が出した値。core は覚える・比べる・返すだけ（Windows は窓のハンドルの 10 進）。層が出していない値には何もしない
// @typedef {{ supported: boolean, reason?: string, features: { dialog: boolean, raise: boolean, launch: boolean, watch: boolean, bounds: boolean } }} Capabilities
//
// capabilities()                         → Capabilities（同期。main の chrome-os-ready を受けるまでは pending）
// ready()                                → Promise<Capabilities>（main の返事を待つ。返事が無ければ supported: false）
// onReady(fn)                            → 外す関数。層が作り直された（main の再起動）ときも呼ぶ
// snapshotWindows()                      → Promise<string[] | null>  今あるブラウザーの最上位の窓の印（findPermissionDialog の比べ元。中身は層だけが解く）
// findPermissionDialog({ since })        → Promise<WindowRef | null>  since に無い、見えている、小さい（外形が 1000×700 DIP 以下）ブラウザーの窓＝リモート デバッグの確認
// raise(ref)                             → Promise<{ ok: boolean, method: string }>  窓を前に出す（最小化なら戻す）。method は direct・attach・failed など
// yieldForeground(ref, { to })           → Promise<boolean>  ref が前面を取っていたら to（直前の前面）に返す
// foreground()                           → Promise<{ id: string, browser: boolean } | null>  今の前面の窓。browser はブラウザー自身の窓か
// close(ref)                             → Promise<boolean>  確認の窓を閉じる（層が確認として出した ref だけ）
//
// 第 4 段以降で足す口（locateBrowser・launchWindow・findWindowByNonce・minimize・watch・bounds）は、capabilities().features で有無を示す。

const FEATURES_NONE = Object.freeze({ dialog: false, raise: false, launch: false, watch: false, bounds: false });

/** テストとほかの OS の既定。どの口も null / false を返す */
export function unsupportedChromeOs(reason = 'platform') {
  const caps = Object.freeze({ supported: false, reason, features: FEATURES_NONE });
  return {
    kind: 'unsupported',
    capabilities: () => caps,
    ready: async () => caps,
    onReady: () => () => {},
    snapshotWindows: async () => null,
    findPermissionDialog: async () => null,
    raise: async () => ({ ok: false, method: 'unsupported' }),
    yieldForeground: async () => false,
    foreground: async () => null,
    close: async () => false,
  };
}

const READY_WAIT_MS = 5000;
const CALL_TIMEOUT_MS = 5000;

/**
 * parentPort 越しの口。port が無い（Electron でない）ときは no-desktop の口を返す。
 * main が `chrome-os-ready { supported, reason, features }` を返すまで capabilities() は pending（supported: false, reason: 'pending'）。
 */
export function parentPortChromeOs(port, { timeoutMs = CALL_TIMEOUT_MS, readyWaitMs = READY_WAIT_MS } = {}) {
  if (!port) return unsupportedChromeOs('no-desktop');
  const pending = new Map();
  const listeners = new Set();
  let caps = Object.freeze({ supported: false, reason: 'pending', features: FEATURES_NONE });
  let isReady = false;
  let next = 0;
  let readyWaiters = [];

  const fire = () => { for (const fn of [...listeners]) { try { fn(caps); } catch { /* 聞き手の失敗は口を壊さない */ } } };
  const failAll = () => { for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.resolve(item.fallback); } };

  port.on('message', event => {
    const message = event?.data ?? event;
    if (message?.type === 'chrome-os-ready') {
      if (isReady) failAll();   // main が作り直された。待っていた呼び出しはもう返らない
      isReady = true;
      const features = { ...FEATURES_NONE, ...(message.features ?? {}) };
      caps = Object.freeze({ supported: message.supported === true, ...(message.reason ? { reason: String(message.reason) } : {}), features });
      const waiters = readyWaiters; readyWaiters = [];
      for (const w of waiters) { clearTimeout(w.timer); w.resolve(caps); }
      fire();
    } else if (message?.type === 'chrome-os-result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      item.resolve(message.ok ? (message.result ?? item.fallback) : item.fallback);
    }
  });
  port.postMessage({ type: 'chrome-os-ready-request' });

  const call = (action, args, fallback) => {
    if (!caps.supported) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const id = `co${++next}`;
      const timer = setTimeout(() => { pending.delete(id); resolve(fallback); }, timeoutMs);
      pending.set(id, { resolve, timer, fallback });
      try { port.postMessage({ type: 'chrome-os', id, action, args }); } catch { pending.delete(id); clearTimeout(timer); resolve(fallback); }
    });
  };

  return {
    kind: 'electron',
    capabilities: () => caps,
    ready() {
      if (isReady) return Promise.resolve(caps);
      return new Promise(resolve => {
        const waiter = { resolve, timer: setTimeout(() => {
          readyWaiters = readyWaiters.filter(w => w !== waiter);
          resolve(Object.freeze({ supported: false, reason: 'no-desktop', features: FEATURES_NONE }));
        }, readyWaitMs) };
        readyWaiters.push(waiter);
      });
    },
    onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshotWindows: () => call('snapshotWindows', {}, null),
    findPermissionDialog: ({ since } = {}) => call('findPermissionDialog', { since: since ?? [] }, null),
    raise: ref => call('raise', { ref }, { ok: false, method: 'failed' }),
    yieldForeground: (ref, { to } = {}) => call('yieldForeground', { ref, to }, false),
    foreground: () => call('foreground', {}, null),
    close: ref => call('close', { ref }, false),
  };
}
