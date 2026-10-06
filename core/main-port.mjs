// main（Electron のメインプロセス）への口。core が main に頼む機能（secret・computer use・内蔵ブラウザー・
// os-open・resident・locale・update-lock・ready など）は、process.parentPort を直に触らず、この口を通す
// （docs/zero-downtime-update/design.md §7.1）。
//
// 口は parentPort と同じ形（on('message', ({ data }) => …)・postMessage）に、つながっているかを足したもの。
//   hosted    main の下で動く起動か（デスクトップ版）。起動の形で決まり、途中で切れても変わらない
//   connected 今 main に届くか。utilityProcess の parentPort は hosted と同じ（つながったまま）
//   resumable 切れても次の main が付け直すか（パイプの口だけ true。main が居ない間の扱いを持つのは resumable の口だけ。core/main-away.mjs）
//   postMessage(message)  送れたら true。main が居ない（hosted でない・切れている）なら何もせず false（溜めない）。
//                         実体の postMessage が false を返したとき（パイプの口が行の上限などで捨てたとき）も false
//   on / off  'message'（parentPort と同じ { data }）・'connect'・'disconnect'（つながり直し・切れたとき）
// 実体の port は parentPort と同じ on / postMessage を持つ物なら何でもよい。名前付きパイプの口（core/main-link.mjs。
// AGENT_HOST_HANDOVER=on のとき）は、connected と、'connect'・'disconnect' を足した同じ形の物で、setMainPortSource で差し込む。

const EVENTS = new Set(['message', 'connect', 'disconnect']);

/** @param port parentPort と同じ形の物（on・postMessage。あれば off・connected）。無ければ main が居ない起動 */
export function createMainPort({ parentPort = null } = {}) {
  const port = parentPort ?? null;
  return {
    hosted: Boolean(port),
    get connected() { return Boolean(port) && port.connected !== false; },
    /** 切れても main が付け直して戻る口か（名前付きパイプの口。utilityProcess の parentPort は切れたら戻らない） */
    get resumable() { return Boolean(port) && port.resumable === true; },
    postMessage(message) {
      if (!port || port.connected === false) return false;
      return port.postMessage(message) !== false;
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
let source = null;

/** process.parentPort の代わりに使う実体（パイプの口）を差し込む。null で戻す。getMainPort の前に呼ぶ */
export function setMainPortSource(port) {
  source = port ?? null;
}

/** この起動の口（差し込まれた実体、無ければ process.parentPort を包んだ物）。同じ port なら同じ口を返す */
export function getMainPort() {
  const parentPort = source ?? process.parentPort ?? null;
  if (!shared || shared.parentPort !== parentPort) shared = { parentPort, port: createMainPort({ parentPort }) };
  return shared.port;
}
