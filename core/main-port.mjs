// main（Electron のメインプロセス）への口。core が main に頼む機能（secret・computer use・内蔵ブラウザー・
// os-open・resident・locale・update-lock・ready など）は、process.parentPort を直に触らず、この口を通す
// （docs/zero-downtime-update/design.md §7.1）。
//
// 口は parentPort と同じ形（on('message', ({ data }) => …)・postMessage）に、つながっているかを足したもの。
//   hosted    main の下で動く起動か（デスクトップ版）。起動の形で決まり、途中で切れても変わらない
//   connected 今 main に届くか。utilityProcess の parentPort は hosted と同じ（つながったまま）
//   postMessage(message)  送れたら true。main が居ない（hosted でない・切れている）なら何もせず false（溜めない）
//   on / off  'message'（parentPort と同じ { data }）・'connect'・'disconnect'（つながり直し・切れたとき）
// 実体の port は parentPort と同じ on / postMessage を持つ物なら何でもよい。名前付きパイプの口（段階 1 の 1-2）は、
// connected と、'connect'・'disconnect' を足した同じ形の物を { parentPort } に渡して差し替える。

const EVENTS = new Set(['message', 'connect', 'disconnect']);

/** @param port parentPort と同じ形の物（on・postMessage。あれば off・connected）。無ければ main が居ない起動 */
export function createMainPort({ parentPort = null } = {}) {
  const port = parentPort ?? null;
  return {
    hosted: Boolean(port),
    get connected() { return Boolean(port) && port.connected !== false; },
    postMessage(message) {
      if (!port || port.connected === false) return false;
      port.postMessage(message);
      return true;
    },
    on(type, listener) {
      if (port && EVENTS.has(type)) port.on(type, listener);
    },
    off(type, listener) {
      if (port && EVENTS.has(type)) (port.off ?? port.removeListener)?.call(port, type, listener);
    },
  };
}

let shared = null;

/**
 * この起動の口（process.parentPort を包んだ物）。同じ port なら同じ口を返す。
 * 段階 1 の 1-2 で、パイプの口を process.parentPort の代わりにここへ差し込む
 */
export function getMainPort() {
  const parentPort = process.parentPort ?? null;
  if (!shared || shared.parentPort !== parentPort) shared = { parentPort, port: createMainPort({ parentPort }) };
  return shared.port;
}
