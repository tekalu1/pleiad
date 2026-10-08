// CDP の薄い口（docs/inapp-browser.md「Chrome への接続」）。id を振り、応答を Promise で返し、イベントを配る。
// 第 3 段の中継は、この上に「エージェントの接続ごとの id の振り直し」を載せる。
// ws は `send(string)`・`on('message'|'close'|'error')`・`close()` を持つもの（ws パッケージの WebSocket と偽物）。

export class CdpError extends Error {
  constructor(message, { code, method } = {}) { super(message); this.name = 'CdpError'; this.code = code; this.method = method; }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param ws 開いた接続
 * @param {{ timeoutMs?: number, firstId?: number }} [options] 1 回の send の上限。firstId は最初に振る id（接続の子から引き継いだ接続は、前のサーバーが振った id より先から数える）
 */
export function createCdp(ws, { timeoutMs = DEFAULT_TIMEOUT_MS, firstId = 1 } = {}) {
  let next = firstId - 1;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();         // method -> Set<fn(params, sessionId)>
  const sessionListeners = new Map();  // sessionId -> Set<fn(method, params)>
  const eventListeners = new Set();    // fn(method, params, sessionId)。どのイベントも受ける（中継の配り分け）
  const closeListeners = new Set();

  const failAll = error => { for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.reject(error); } };
  const markClosed = () => {
    if (closed) return;
    closed = true;
    failAll(new CdpError('connection closed', { code: 'closed' }));
    for (const fn of [...closeListeners]) { try { fn(); } catch { /* 聞き手の失敗は接続を壊さない */ } }
  };

  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (message && message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new CdpError(message.error.message ?? 'cdp error', { code: message.error.code, method: item.method }));
      else item.resolve(message.result ?? {});
      return;
    }
    if (typeof message?.method !== 'string') return;
    for (const fn of [...eventListeners]) { try { fn(message.method, message.params ?? {}, message.sessionId); } catch { /* 同上 */ } }
    for (const fn of [...(listeners.get(message.method) ?? [])]) { try { fn(message.params ?? {}, message.sessionId); } catch { /* 同上 */ } }
    if (message.sessionId) for (const fn of [...(sessionListeners.get(message.sessionId) ?? [])]) { try { fn(message.method, message.params ?? {}); } catch { /* 同上 */ } }
  });
  ws.on('close', markClosed);
  ws.on('error', () => {});   // 失敗は close で知る

  const add = (map, key, fn) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(fn);
    return () => map.get(key)?.delete(fn);
  };

  return {
    /** @param {{ timeoutMs?: number }} [options] この呼び出しだけの上限（中継が人の確認を待つ移動など） */
    send(method, params = {}, sessionId, options = {}) {
      if (closed) return Promise.reject(new CdpError('connection closed', { code: 'closed', method }));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new CdpError(`${method} timed out`, { code: 'timeout', method })); }, options.timeoutMs ?? timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    /** イベントを受ける。戻り値は外す関数 */
    on: (method, fn) => add(listeners, method, fn),
    onSession: (sessionId, fn) => add(sessionListeners, sessionId, fn),
    /** すべてのイベント（fn(method, params, sessionId)）。戻り値は外す関数 */
    onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
    close() { try { ws.close(); } catch { /* 閉じていてもよい */ } markClosed(); },
    get closed() { return closed; },
  };
}
