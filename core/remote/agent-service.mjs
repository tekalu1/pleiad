// 端末の main の側の橋（docs/remote.md §4.5、ADR 0146）。ローカルのサーバー（utilityProcess）から parentPort で届く
// { type: 'remote-agent', id, action, … } を、ホストへの AI 用の線（agent-link.mjs。device.mjs が持つ）へ渡し、
// ホストの便りと線の状態を { type: 'remote-agent-event' | 'remote-agent-state' | 'remote-agent-hosts' } でサーバーへ返す。
// デスクトップ版の main（desktop/remote-agent-bridge.cjs）とテスト（tests/lib/remote-agent-parent-port.mjs）が同じものを使う。
//
// 守り: 承認の答え（answer）を線へ運ぶのは、サーバーが画面（human）の resolvePermission の処理の中で出したときだけ（サーバー側の取り決め。
// remote.md §4.5）。この橋は「どの経路から来たか」を見分けられないので、サーバーが human の経路の外から作らないことに頼る。
// AI が呼べる道具（MCP・CLI・ply_task_*）には、answer を作る道が無い。
import { AgentError } from './agent-link.mjs';

const displayName = rec => String(rec?.label || rec?.hostName || String(rec?.hostId ?? '').slice(0, 8));

/**
 * @param getDevice  () => Promise<createRemoteDevice の戻り値>
 * @param post       (message) => void。サーバーへ送る
 */
export function createRemoteAgentService({ getDevice, post, log = () => {} }) {
  const aborts = new Map();   // 依頼の id → AbortController
  let hooked = null;

  async function device() {
    const d = await getDevice();
    if (hooked !== d) {
      hooked = d;
      d.on('agent-state', async s => {
        post({ type: 'remote-agent-state', hostId: s.hostId, state: s.state, allowed: s.allowed === true, hostName: s.hostName ?? '' });
        post({ type: 'remote-agent-hosts', hosts: await hostsView().catch(() => []) });
      });
    }
    return d;
  }

  /** サーバーが知る「ホストの一覧」。線を張っているホスト（agentUse）だけが状態を持つ */
  async function hostsView() {
    const d = await device();
    const rows = await d.list();
    return rows.map(h => ({
      hostId: h.hostId, name: displayName(h), hostName: h.hostName ?? '', agentUse: h.agentUse === true,
      state: h.agent?.state ?? 'offline', allowed: h.agent?.allowed === true,
    }));
  }

  /** 線に聞き手を付ける（ホストの便りをサーバーへ）。同じ線に二重に付けない */
  const listened = new WeakSet();
  function listen(hostId, agent) {
    if (!agent || listened.has(agent)) return;
    listened.add(agent);
    agent.on('event', event => post({ type: 'remote-agent-event', hostId, event }));
    agent.on('ready', status => post({ type: 'remote-agent-ready', hostId, ...status }));
  }

  async function refresh() {
    const d = await device();
    await d.agentSync();
    for (const h of await d.store.hosts()) listen(h.hostId, d.agent(h.hostId));
    post({ type: 'remote-agent-hosts', hosts: await hostsView() });
  }

  /**
   * サーバーがつなぎ直した（付け直した・切り替えで新しい版のサーバーに替わった。desktop/remote-agent-bridge.cjs が ready で呼ぶ）。
   * サーバーは空か古い一覧から始まるので、一覧を送り直し、つながっている線は ready を送り直す（サーバーが動いているタスクと中継する承認を同期し直す）。
   * 線は main のもので、切り替えの間も張ったまま。ready の便りは線がつながったときしか出ないので、ここで補う
   */
  async function resync() {
    await refresh();
    for (const h of await hostsView()) {
      if (h.state === 'ready') post({ type: 'remote-agent-ready', hostId: h.hostId, state: h.state, allowed: h.allowed, hostName: h.hostName });
    }
  }

  const fail = (id, e) => post({ type: 'remote-agent', id, ok: false, code: e instanceof AgentError || typeof e?.code === 'string' ? e.code : 'ERROR', error: String(e?.message ?? e) });

  async function handle(message) {
    const { id, action } = message;
    try {
      const d = await device();
      switch (action) {
        case 'hosts': {
          await refresh();
          return post({ type: 'remote-agent', id, ok: true, hosts: await hostsView() });
        }
        case 'request': {
          const agent = d.agent(message.hostId);
          if (!agent) throw new AgentError('OFFLINE', 'the host is not available');
          listen(message.hostId, agent);
          const ac = new AbortController();
          aborts.set(id, ac);
          try {
            const result = await agent.request(String(message.op), message.args ?? {}, message.requester ?? null, { signal: ac.signal, ...(Number.isFinite(message.timeoutMs) ? { timeoutMs: message.timeoutMs } : {}) });
            return post({ type: 'remote-agent', id, ok: true, result });
          } finally { aborts.delete(id); }
        }
        case 'abort': { aborts.get(message.target)?.abort(); return; }
        case 'answer': {
          const agent = d.agent(message.hostId);
          if (!agent) throw new AgentError('OFFLINE', 'the host is not available');
          const result = await agent.answer(message.relay ?? {});
          return post({ type: 'remote-agent', id, ok: true, result });
        }
        case 'sync': {
          const agent = d.agent(message.hostId);
          return post({ type: 'remote-agent', id, ok: true, result: agent ? agent.sync(Array.isArray(message.taskIds) ? message.taskIds : []) : false });
        }
        default: throw new AgentError('BAD_REQUEST', `unknown action: ${action}`);
      }
    } catch (e) {
      log(`remote agent: ${action}: ${e?.message ?? e}`);
      if (id !== undefined) fail(id, e);
    }
  }

  return {
    handle: message => { if (message?.type === 'remote-agent') return handle(message); },
    /** agentUse が変わった・ホストが増減した。線を張り直し、一覧をサーバーへ */
    refresh: () => refresh().catch(e => log(`remote agent: ${e?.message ?? e}`)),
    resync: () => resync().catch(e => log(`remote agent: ${e?.message ?? e}`)),
    hostsView,
    close() { for (const ac of aborts.values()) ac.abort(); aborts.clear(); },
  };
}
