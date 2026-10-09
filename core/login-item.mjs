// サインイン時の起動（desktop/login-item.cjs）への依頼の口。登録の持ち主は OS で、サーバーは main に頼むだけ
// （core/os-open.mjs の parentPortOpener と同じ形。main 側は desktop/login-item.cjs の attachLoginItem）。
//   送る  { type:'login-item', id, action:'get'|'set', enabled? }
//   返る  { type:'login-item', id, ok:true, state:{ supported, reason?, enabled, blocked } } / { ok:false, code }
// main の下で動いていない起動（npm start など）・更新の切り替えで main に届かない間・応答が無いときは、get は
// supported:false（reason は server / away / timeout）で返し、set は code つきの Error で断る。

class LoginItemRequestError extends Error {
  constructor(code, message = code) { super(message); this.name = 'LoginItemRequestError'; this.code = code; }
}

const unavailable = reason => ({ supported: false, reason, enabled: false, blocked: false });

/** @param port core/main-port.mjs の口 */
export function createLoginItemClient({ port, timeoutMs = 5000 } = {}) {
  const waiting = new Map();
  let seq = 0;
  port?.on?.('message', event => {
    const data = event?.data ?? event;
    if (data?.type !== 'login-item' || !waiting.has(data.id)) return;
    const { resolve, reject, timer } = waiting.get(data.id);
    waiting.delete(data.id); clearTimeout(timer);
    if (data.ok) resolve(data.state); else reject(new LoginItemRequestError(data.code ?? 'failed'));
  });

  function request(message) {
    return new Promise((resolve, reject) => {
      if (!port?.hosted) { reject(new LoginItemRequestError('unsupported', 'server')); return; }
      const id = `l${++seq}`;
      const timer = setTimeout(() => { waiting.delete(id); reject(new LoginItemRequestError('timeout')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      if (port.postMessage({ type: 'login-item', id, ...message }) === false) {
        waiting.delete(id); clearTimeout(timer);
        reject(new LoginItemRequestError('away'));
      }
    });
  }

  return {
    /** 今の状態（OS から読んだもの）。頼めないときは supported:false */
    async get() {
      try { return await request({ action: 'get' }); }
      catch (error) { return unavailable(error.message === 'server' ? 'server' : error.code === 'away' || error.code === 'timeout' ? error.code : 'failed'); }
    },
    /** 登録する・外す。戻り値は登録の後の状態。失敗は code（unsupported / invalid / away / timeout / failed）つきの Error */
    set(enabled) { return request({ action: 'set', enabled }); },
  };
}
