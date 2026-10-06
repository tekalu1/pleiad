'use strict';
// サーバー（utilityProcess・名前付きパイプの link）の message を 1 つの listener で受け、main の橋ごとの受け手に配る。
// 橋（秘密・ファイル・コンピューター・Chrome の OS の層・常駐・リモート・内蔵ブラウザーなど）がそれぞれ worker.on('message') すると、
// 受け手は決まった数なのに 10 を超えて MaxListenersExceededWarning が出る。受け手はここに積み、worker の listener は増やさない。
// 橋が使うのは on・off・once・postMessage だけ。'message' のほか（'exit' など）は worker へそのまま渡す。

/** @param {{ on: Function, off: Function, once: Function, postMessage: Function }} worker */
function createWorkerMessages(worker) {
  const handlers = [];
  // EventEmitter と同じに、配る間の付け外しは次の message から効く
  worker.on('message', message => { for (const fn of handlers.slice()) fn(message); });
  const remove = fn => { const i = handlers.lastIndexOf(fn); if (i >= 0) handlers.splice(i, 1); };
  const port = {
    on(event, fn) { if (event === 'message') handlers.push(fn); else worker.on(event, fn); return port; },
    off(event, fn) { if (event === 'message') remove(fn); else worker.off(event, fn); return port; },
    once(event, fn) {
      if (event !== 'message') { worker.once(event, fn); return port; }
      const wrapped = message => { remove(wrapped); fn(message); };
      handlers.push(wrapped);
      return port;
    },
    postMessage: message => worker.postMessage(message),
    /** 積んでいる受け手の数（テスト用） */
    messageHandlers: () => handlers.length,
  };
  return port;
}

module.exports = { createWorkerMessages };
