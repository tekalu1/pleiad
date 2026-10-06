// ローカルのサーバー（utilityProcess）と、ホストへの AI 用の線（core/remote/agent-link.mjs）の間の橋（docs/remote.md §4.5、ADR 0146）。
// サーバーの core/remote-delegation.mjs（parentPortRemoteAgent）が相手。メッセージの形は core/remote/agent-service.mjs に書いてある。
//   worker -> main: { type: 'remote-agent', id, action: 'hosts' | 'request' | 'abort' | 'answer' | 'sync', … }
//   main -> worker: { type: 'remote-agent', id, ok, … }（応答）・{ type: 'remote-agent-event' | 'remote-agent-state' | 'remote-agent-hosts' | 'remote-agent-ready', … }
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * getDevice: () => Promise<createRemoteDevice の戻り値>（desktop/remote-windows.cjs の device()）
 * 戻り値の refresh() は、agentUse が変わった・ホストが増減したときに呼ぶ（線を張り直してサーバーへ一覧を送る）
 */
function attachRemoteAgentBridge(worker, { getDevice, log = () => {} }) {
  const service = import(pathToFileURL(path.join(__dirname, '..', 'core', 'remote', 'agent-service.mjs')).href)
    .then(({ createRemoteAgentService }) => createRemoteAgentService({ getDevice, post: message => { try { worker.postMessage(message); } catch { /* サーバーが終わった */ } }, log }));
  service.catch(e => log(`remote agent bridge: ${e?.message ?? e}`));
  worker.on('message', async message => {
    if (message?.type !== 'remote-agent') return;
    try { (await service).handle(message); } catch (e) { log(`remote agent bridge: ${e?.message ?? e}`); }
  });
  return {
    refresh: async () => { try { await (await service).refresh(); } catch (e) { log(`remote agent bridge: ${e?.message ?? e}`); } },
    close: async () => { try { (await service).close(); } catch { /* 閉じかけ */ } },
  };
}

module.exports = { attachRemoteAgentBridge };
