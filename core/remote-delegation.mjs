// 端末（デスクトップ版）のローカルのサーバーの側: この PC の AI から、リモートのホストへ作業を任せる
// （docs/agent-delegation.md「リモートのホストへ任せる」、docs/remote.md §4.5、ADR 0146）。
//
//   parentPortRemoteAgent(port)   main との口。ホストへの依頼（request）・人の答え（answer）・経過の読み出し（view）・つなぎ直しの同期（sync）と、ホストの便りの受け取り
//   createRemoteDelegation(deps)  ply_delegate の host・ホストのタスクの写し（agent-tasks の host の行）の追跡と追いつき・中継された承認のカード
//
// 守り: 承認の答え（answer）は、画面（human）の resolvePermission の処理（core/server.mjs）が answerCard を呼んだときだけ作る。
// 経過の読み出し（view）は、画面（human）の操作 delegation.hostView（MCP・CLI には出さない）が view を呼んだときだけ作る。
// AI が呼べる道具（MCP の ply_delegate・ply_task_*）から answer・view を作る道は無い（taskCall は答えも読み出しも運ばない）。
import { modePosition } from './modes.mjs';

export const RESULT_PAGE_MAX = 20;   // 完了した結果の続きを読むページ数の上限（16,000 字 × 20）

// ---- main との口 ------------------------------------------------------------------------------------------------

/**
 * main への口（core/main-port.mjs）の上の口。port が無い（Electron でない）ときは null。
 * main が付け直す口（名前付きパイプ。port.resumable）では、main が居ない間（更新・切り替えの間）の扱いを持つ（docs/zero-downtime-update/design.md §7.2）:
 * ホストへの線は main のものなので居ない間は無く、依頼は待たせずに OFFLINE で失敗にし（ホストがオフラインのときの扱いに乗る）、ホストは全部オフライン扱いにする。
 * 戻ったときは、main が一覧と、つながっている線の ready を送り直す（desktop/remote-agent-bridge.cjs）ので、追いつき（catchUp）はそれで走る
 */
export function parentPortRemoteAgent(port, { timeoutMs = 70_000 } = {}) {
  if (!port) return null;
  const pending = new Map();
  let seq = 0;
  let hosts = [];
  const listeners = { event: new Set(), state: new Set(), hosts: new Set(), ready: new Set() };
  const fire = (kind, ...args) => { for (const fn of [...listeners[kind]]) { try { fn(...args); } catch { /* 聞き手の失敗で口は止めない */ } } };
  const offline = () => Object.assign(new Error('the host is not available (Pleiad is restarting)'), { code: 'OFFLINE' });
  // 一覧の更新（remote-agent-hosts）は状態の便りより遅れて届くので、状態の便りで先に今の状態を写す
  const setState = (kind, hostId, st) => {
    hosts = hosts.map(h => (h.hostId === hostId ? { ...h, state: st.state, allowed: st.allowed, ...(st.view !== undefined ? { view: st.view === true } : {}) } : h));
    fire(kind, hostId, st);
  };
  port.on('message', event => {
    const m = event?.data ?? event;
    switch (m?.type) {
      case 'remote-agent': {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m); else p.reject(Object.assign(new Error(m.error || 'remote agent failed'), { code: m.code || 'ERROR' }));
        return;
      }
      case 'remote-agent-event': fire('event', m.hostId, m.event); return;
      case 'remote-agent-state': case 'remote-agent-ready':
        setState(m.type === 'remote-agent-ready' ? 'ready' : 'state', m.hostId, { state: m.state, allowed: m.allowed === true, view: m.view === true, hostName: m.hostName ?? '' });
        return;
      case 'remote-agent-hosts': hosts = Array.isArray(m.hosts) ? m.hosts : []; fire('hosts', hosts); return;
      default:
    }
  });
  if (port.resumable) {
    port.on('disconnect', () => {
      // 答えの待ちは、線ごと無くなった。OFFLINE で返す（ホストの線が切れたときと同じ）
      for (const [id, p] of [...pending]) { pending.delete(id); clearTimeout(p.timer); p.reject(offline()); }
      for (const h of hosts) if (h.state !== 'offline') setState('state', h.hostId, { state: 'offline', allowed: h.allowed === true, hostName: h.hostName ?? '' });
    });
  }
  const call = (action, payload = {}, { signal, timeoutMs: ms = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (port.resumable && port.connected === false) return reject(offline());
    const id = `ra${++seq}`;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('the host did not answer'), { code: 'TIMEOUT' })); }, ms);
    timer.unref?.();
    const onAbort = () => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      port.postMessage({ type: 'remote-agent', action: 'abort', target: id });
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    };
    pending.set(id, { resolve, reject, timer });
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    port.postMessage({ type: 'remote-agent', id, action, ...payload });
  });
  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  return {
    /** main が最後に知らせたホストの一覧 [{ hostId, name, hostName, agentUse, state, allowed, view }]。view はホストが経過の読み出しを知っているか */
    get hosts() { return hosts; },
    /** main との口が使えるか（更新の引き継ぎの間は false）。false の間のオフラインは、ホストの不通ではない */
    get connected() { return !port.resumable || port.connected !== false; },
    refresh: async () => { const r = await call('hosts'); hosts = r.hosts ?? hosts; return hosts; },
    /** 委譲の 6 つの操作のどれか（ホストの答えの result で解決。失敗は code 付きの Error）。ms は main がホストの答えを待つ上限 */
    request: async (hostId, op, args, requester, { signal, timeoutMs: ms = 60_000 } = {}) =>
      (await call('request', { hostId, op, args, requester, timeoutMs: ms }, { signal, timeoutMs: ms + 10_000 })).result,
    /** 承認の中継への人の答え。{ ok, code? } */
    answer: async (hostId, relay) => (await call('answer', { hostId, relay }, { timeoutMs: 30_000 })).result,
    /** 任せた子の会話の経過の読み出し（ホストの viewed の result）。画面（human）の delegation.hostView からだけ呼ぶ */
    view: async (hostId, taskId, cursor = null) => (await call('view', { hostId, taskId, cursor }, { timeoutMs: 30_000 })).result,
    sync: async (hostId, taskIds) => (await call('sync', { hostId, taskIds }, { timeoutMs: 15_000 })).result === true,
    onEvent: on('event'), onState: on('state'), onHosts: on('hosts'), onReady: on('ready'),
  };
}

// ---- 委譲の本体 -------------------------------------------------------------------------------------------------

const DELEGATE_KEYS = ['kind', 'task', 'title', 'backend', 'context', 'cwd', 'model', 'effort', 'isolate'];
const FINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

class DelegationError extends Error {
  constructor(message, code = 'ERROR') { super(message); this.code = code; }
}

/**
 * @param deps.bridge        parentPortRemoteAgent の戻り値（無ければ null: この口を使えない起動）
 * @param deps.tasks         () => createAgentTasks の戻り値（後から決まるので関数）
 * @param deps.agentT        (locale, key, params) => エージェントに返す文（agent 名前空間）
 * @param deps.titleOf       async (sessionId) => 会話の題（依頼元としてホストへ送る）
 * @param deps.cards         承認のカードの口: open(card) → cardId / close(cardId, resolution) / online(hostId, bool)
 * @param deps.locale        () => 言語。依頼元の会話がまだ分からない場所のエージェント向けの文に使う
 * @param deps.changed       () => void。承認の待ちが変わった（ply_task_wait を起こす・実行中の配信）
 * @param deps.log           (line) => void
 * @param deps.deliverNotice async (ownerSessionId, build(lng) => 文) => 'ok' | 'requeue' | 'error'。依頼元の会話へ内部のターンで知らせる（無音の通知と同じ道。ADR 0171）
 * @param deps.now           () => ms。時計（試験で偽物にする）
 * @param deps.offlineMinutes        ホストがこの分数オフラインのままなら、走っている子のある依頼元へ知らせる（0 で知らせない）
 * @param deps.offlineRepeatMinutes  同じオフラインが続くとき、最初の通知からこの分数あけて、もう 1 回だけ知らせる
 * @param deps.syncWaitMs            つながり直した後、追いつきの答え（synced）を待つ上限
 */
export function createRemoteDelegation({ bridge, tasks, agentT, titleOf = async () => '', cards = null, changed = () => {}, locale = () => 'en', log = () => {},
  deliverNotice = async () => 'ok', now = Date.now,
  offlineMinutes = Number(process.env.AGENT_HOST_OFFLINE_MINUTES ?? 10), offlineRepeatMinutes = Number(process.env.AGENT_HOST_OFFLINE_REPEAT_MINUTES ?? 60),
  syncWaitMs = 20_000 }) {
  const open = new Map();         // `${hostId}:${relayId}` → { cardId, hostId, relayId, taskId, receipt }
  const byCard = new Map();       // cardId → 同じ項目
  const orphans = new Map();      // taskId → { event, at }。adopt より先に届いた便り（res と task の順が入れ替わったとき）
  const syncing = new Set();      // hostId。同期の最中の二重実行を避ける
  const offlineAt = new Map();    // hostId → 線が使えなくなった時刻。画面の「オフライン · HH:MM までの分」（経過の読み出しが最後に届いた分の目安）
  const seenOffline = new Map();  // hostId → Pleiad が初めてオフラインと知った時刻（起動した時にはもう落ちていたホストの、不通の通知の起点）
  const told = new Map();         // hostId → Map(依頼元の会話 → { at, n, taskIds })。不通を知らせた記録。つながり直して追いつきを知らせたら消す
  const catching = new Map();     // hostId → { unknown: Set, timer }。つながり直した後、追いつきの答え（synced）を待っている
  const working = new Set();      // 反映の途中の task の便り（追いつきの知らせは、それが済んでから）
  const known = new Map();        // 経過の読み出しで知ったホストの子孫の taskId → hostId（読み出しの宛先を引く。端末の台帳には保存しない）

  const hostsNow = () => bridge?.hosts ?? [];
  const hostById = hostId => hostsNow().find(h => h.hostId === hostId) ?? null;
  const usable = h => Boolean(h) && h.agentUse === true && h.allowed === true && h.state === 'ready';

  /** ply_delegate の説明に載せる、任せられるホスト（端末側がオンで、ホストが許可しているもの）。オフラインは online: false */
  function describe() {
    // 名前は AI の道具の説明に入るので、改行・制御文字を空白にして短くする（ホストが名乗る名前をそのまま信じない）
    return hostsNow().filter(h => h.agentUse === true && h.allowed === true).map(h => ({ name: String(h.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40), online: h.state === 'ready' }));
  }

  function findHost(name, lng) {
    const wanted = String(name ?? '').trim().toLowerCase();
    const listed = describe();
    const unknown = () => new DelegationError(agentT(lng, 'delegation.remote.hostUnknown', { host: String(name), hosts: listed.map(h => h.name).join(', ') || '-' }), 'HOST_UNKNOWN');
    if (!wanted) throw unknown();
    const hits = hostsNow().filter(h => h.name.toLowerCase() === wanted || h.hostId.toLowerCase() === wanted || (h.hostName ?? '').toLowerCase() === wanted);
    if (hits.length > 1) throw new DelegationError(agentT(lng, 'delegation.remote.hostAmbiguous', { host: String(name) }), 'HOST_AMBIGUOUS');
    const host = hits[0];
    if (!host) throw unknown();
    if (!host.agentUse) throw new DelegationError(agentT(lng, 'delegation.remote.hostNotEnabled', { host: host.name }), 'HOST_NOT_ENABLED');
    if (!host.allowed) throw new DelegationError(agentT(lng, 'delegation.remote.hostNotAllowed', { host: host.name }), 'HOST_NOT_ALLOWED');
    // オフラインは待たずに失敗する（走り出す前に分かる失敗を、AI に待たせない）
    if (!usable(host)) throw new DelegationError(agentT(lng, 'delegation.remote.hostOffline', { host: host.name }), 'HOST_OFFLINE');
    return host;
  }

  /** ホストへ送る依頼元（端末の会話）。承認モードの位置は手元の委譲が子へ継ぐのと同じ形（core/modes.mjs の modePosition） */
  async function requesterOf(owner, turn, lng) {
    return {
      sessionId: owner, title: (await titleOf(owner).catch(() => '')) || '', locale: lng,
      backend: turn?.backend?.id ?? '', mode: modePosition(turn?.backend?.modes?.()[turn?.info?.mode]),
    };
  }

  const patchOf = ev => {
    const final = FINAL.has(ev.rawStatus ?? ev.status);
    const telemetry = ev.telemetry?.version === 1 && Number.isFinite(ev.telemetry.lastActivityAt)
      ? ev.telemetry : null;
    return {
      title: ev.title ?? undefined, status: ev.rawStatus ?? ev.status, hostWaiting: ev.status === 'waiting', error: ev.error ?? null,
      backend: ev.backend ?? undefined, model: ev.model ?? undefined, effort: ev.effort ?? undefined, mode: ev.mode ?? undefined, cwd: ev.cwd ?? undefined,
      remoteSessionId: ev.sessionId ?? undefined, worktree: ev.worktree ?? undefined,
      routing: ev.routing ? { mode: 'host', kind: ev.routing.kind ?? null, decidedBy: 'host', target: { backend: ev.routing.backend ?? null, model: ev.routing.model ?? null, account: null } } : undefined,
      ...(final ? { result: ev.result ?? '', resultLength: ev.resultLength ?? 0 } : {}),
      ...(!telemetry && !final ? { hostTelemetry: null, hostBackground: null, hostLockWaiting: null,
        lastActivityAt: null, lastOutputAt: null, activeCommands: null } : {}),
      ...(telemetry ? { hostTelemetry: true, lastActivityAt: telemetry.lastActivityAt,
        lastOutputAt: Number.isFinite(telemetry.lastOutputAt) ? telemetry.lastOutputAt : null,
        activeCommands: Array.isArray(telemetry.activeCommands) ? telemetry.activeCommands.slice(0, 8).filter(c => c && typeof c.noticeId === 'string' && typeof c.command === 'string')
          .map(c => ({ ...c, notified: false })) : [],
        hostLockWaiting: telemetry.lockWaiting === true,
        hostBackground: Number.isFinite(telemetry.background?.since) && Array.isArray(telemetry.background?.tasks)
          ? { since: telemetry.background.since, tasks: telemetry.background.tasks.slice(0, 8),
            reply: typeof telemetry.background.reply === 'string' ? telemetry.background.reply.slice(0, 4000) : '' } : null } : {}),
    };
  };

  /** 完了した結果が最初のページより長いとき、続きをホストから読んで行に写す（上限 RESULT_PAGE_MAX ページ） */
  async function completeResult(host, row, ev, requester) {
    let text = ev.result ?? '';
    const total = ev.resultLength ?? text.length;
    let pages = 1;
    while (text.length < total && pages < RESULT_PAGE_MAX) {
      let page;
      try { page = await bridge.request(host.hostId, 'status', { taskId: ev.taskId, offset: text.length }, requester, { timeoutMs: 20_000 }); }
      catch { break; }
      const more = String(page?.result ?? '');
      if (!more) break;
      text += more;
      pages++;
    }
    return text;
  }

  /** ホストのタスクの便り（task）を、写しの行へ。行がまだ無ければ（delegate の応答より先に届いた）取り置く */
  async function onTask(hostId, ev) {
    if (!ev || typeof ev.taskId !== 'string') return;
    const t = tasks();
    const row = t?.get(ev.taskId);
    if (!row?.host || row.host.hostId !== hostId) {
      if (!row) { orphans.set(ev.taskId, { event: ev, at: Date.now(), hostId }); if (orphans.size > 50) orphans.delete(orphans.keys().next().value); }
      return;
    }
    const host = hostById(hostId);
    let patch = patchOf(ev);
    const final = FINAL.has(patch.status);
    if (final && (ev.resultLength ?? 0) > (ev.result ?? '').length && usable(host)) {
      const requester = await requesterOf(row.parentSessionId, null, null).catch(() => null);
      const full = await completeResult(host, row, ev, requester ?? { sessionId: row.parentSessionId });
      patch = { ...patch, result: full, resultLength: ev.resultLength ?? full.length };
    }
    await t.mirror(ev.taskId, patch);
    changed();
  }

  // ---- 中継された承認 ----

  /** ホストの Chrome の操作待ちの印（relay.chromeWait）を、カードに載せる形へ。知らない値は落とす */
  const cleanChromeWait = (w, askedAt = null) => {
    if (!w || typeof w !== 'object') return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    return { reason: str(w.reason, 40), state: str(w.state, 20), dialog: w.dialog === true, message: str(w.message, 400),
      ...(typeof askedAt === 'string' ? { since: askedAt } : {}) };
  };

  function updateRelay(hostId, relayId, chromeWait) {
    const entry = open.get(`${hostId}:${relayId}`);
    const next = entry?.chromeWait && cleanChromeWait(chromeWait);
    if (next) cards?.update?.(entry.cardId, { chromeWait: next });
  }

  function openRelay(hostId, relay) {
    if (!cards || !relay || typeof relay.id !== 'string') return;
    const key = `${hostId}:${relay.id}`;
    // つなぎ直しで送り直された中継は、開いたままのカードの中身だけ最新に替える（カードも通知も増やさない）
    if (open.has(key)) return updateRelay(hostId, relay.id, relay.chromeWait);
    const row = tasks()?.get(relay.taskId);
    // 自分が任せたタスク（この会話の写し）の承認だけを出す。知らないタスクの承認は出さない
    if (!row?.host || row.host.hostId !== hostId || row.parentSessionId !== relay.requesterSessionId) return;
    // もう止めた・終わったタスク（止める予定を含む）の承認は出さない。つなぎ直しで送り直されても、止めたものを動かし直す入口にしない
    if (FINAL.has(row.status) || row.cancelPending) return;
    const host = hostById(hostId);
    const kind = ['question', 'hostOnly'].includes(relay.kind) ? relay.kind : 'tool';
    const cardId = cards.open({
      sessionId: row.parentSessionId, hostId, hostName: host?.name ?? row.host.name, relayId: relay.id, taskId: relay.taskId, kind, hostOnly: kind === 'hostOnly',
      toolName: relay.toolName, input: relay.input, questions: kind === 'question' ? relay.questions : undefined,
      // Chrome の操作待ちのカードは、題に「委譲先「…」」だけを出す（ホスト側の依頼の題は、本文の最初の 1 行が言う）
      title: relay.chromeWait ? null : relay.title ?? null, childTitle: row.title || relay.childTitle || '',
      askedAt: relay.askedAt, online: usable(host),
      ...(typeof relay.childSessionId === 'string' && relay.childSessionId.length <= 200 ? { childSessionId: relay.childSessionId } : {}),
      ...(relay.chromeWait && typeof relay.chromeWait === 'object' ? { chromeWait: cleanChromeWait(relay.chromeWait, relay.askedAt) } : {}),
    });
    const entry = { cardId, hostId, relayId: relay.id, taskId: relay.taskId, receipt: relay.receipt, hostOnly: kind === 'hostOnly', chromeWait: Boolean(relay.chromeWait) };
    open.set(key, entry);
    byCard.set(cardId, entry);
    changed();
  }

  function closeRelay(hostId, relayId, resolution) {
    const entry = open.get(`${hostId}:${relayId}`);
    if (!entry) return;
    open.delete(`${hostId}:${relayId}`);
    byCard.delete(entry.cardId);
    // 子が待つのをやめた（abort）は、Chrome の操作待ちのカードだけ「子が待つのをやめました」と残す。ほかの中継は誰が答えたか分からない決着として下げる
    const by = resolution.by === 'abort' && !entry.chromeWait ? null : resolution.by;
    cards?.close(entry.cardId, { ...resolution, by, hostName: hostById(hostId)?.name ?? '' });
    changed();
  }

  /** ホストが今待っている中継する承認の全部（つなぎ直し・sync の答え）。無いものは畳み、足りないものは出す */
  function reconcile(hostId, relays) {
    const live = new Set((relays ?? []).map(r => r.id));
    for (const entry of [...open.values()]) if (entry.hostId === hostId && !live.has(entry.relayId)) closeRelay(hostId, entry.relayId, { by: null, allow: null });
    for (const r of relays ?? []) openRelay(hostId, r);
  }

  function onEvent(hostId, ev) {
    switch (ev?.t) {
      case 'task': {
        const work = onTask(hostId, ev.task).catch(e => log(`remote delegation: ${e?.message ?? e}`)).finally(() => working.delete(work));
        working.add(work);
        return work;
      }
      case 'relays': return reconcile(hostId, ev.relays);
      case 'synced': return unknownTasks(hostId, ev.unknown).then(() => caughtUp(hostId, ev.unknown));
      case 'relay': return openRelay(hostId, ev.relay);
      case 'relayUpdate': return updateRelay(hostId, ev.id, ev.chromeWait);
      case 'relayEnd': return closeRelay(hostId, ev.id, { by: ['device', 'host', 'abort'].includes(ev.by) ? ev.by : null, allow: ev.allow === true });
      default:
    }
  }

  /** つなぎ直した（ready）。動いているタスクの今の状態と、待っている中継する承認を求める。ホストが許可していなければ、動いていた写しを止まったことにする */
  async function catchUp(hostId, status) {
    if (syncing.has(hostId)) return;
    syncing.add(hostId);
    try {
      cards?.online(hostId, status.state === 'ready' && status.allowed);
      if (status.state === 'ready' && status.allowed) {
        const rows = tasks()?.rowsWhere(r => r.host?.hostId === hostId) ?? [];
        // オフライン中に止めた分（cancelPending）は、つながり直したここで送る。成功したら予定を外す
        for (const r of rows.filter(x => x.cancelPending)) {
          cancelHost(r).then(ok => { if (ok) return tasks().mirror(r.taskId, { cancelPending: null }); }).catch(() => {});
        }
        // 動いているもの・追えなくなっていたもの（hostLost）の今の状態を求める。ホストが知らない ID は synced の unknown で返る
        const live = rows.filter(r => !FINAL.has(r.status) || r.hostLost);
        bridge.sync(hostId, live.map(r => r.taskId)).catch(() => {});
      } else if (stopped(status)) await retire(hostId, 'stopped');
    } finally { syncing.delete(hostId); }
  }

  /**
   * ホストがもう依頼を受けていない（許可を切った・取り消した・古い版）か、この PC 側で任せる設定を切った・ホストを消した。
   * 動いていた写しは、理由つきで終わらせる（失敗。ホストの作業は止まっているか続いているか分からない）。追えなくなった印（hostLost）を付けるので、
   * つながり直した・設定を入れ直したときの sync で、ホストの状態に戻せる
   */
  const stopped = st => st.state === 'revoked' || st.state === 'unsupported' || (st.state === 'ready' && !st.allowed);
  async function retire(hostId, reason = 'stopped') {
    const live = (tasks()?.rowsWhere(r => r.host?.hostId === hostId) ?? []).filter(r => !FINAL.has(r.status));
    for (const r of live) {
      const error = reason === 'unlinked' ? agentT(locale(), 'delegation.remote.hostUnlinked', { host: r.host.name }) : agentT(locale(), 'delegation.remote.hostStopped', { host: r.host.name });
      await tasks().mirror(r.taskId, { status: 'failed', hostWaiting: false, hostLost: true, error });
    }
    for (const entry of [...open.values()]) if (entry.hostId === hostId) closeRelay(hostId, entry.relayId, { by: null, allow: null });
  }
  async function suspendTelemetry(hostId) {
    for (const r of tasks()?.rowsWhere(x => x.host?.hostId === hostId && ACTIVE.has(x.status) && x.hostTelemetry) ?? [])
      await tasks().mirror(r.taskId, { hostTelemetry: null, hostBackground: null, hostLockWaiting: null,
        activeCommands: null, lastActivityAt: null, lastOutputAt: null });
  }

  /** sync の答えの「ホストが知らない ID」。ホストのデータが消えた・別の端末として組み直した、など。動いているつもりの写しを、記録が無いものとして終わらせる */
  async function unknownTasks(hostId, ids) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const row = tasks()?.get(String(id));
      if (!row?.host || row.host.hostId !== hostId || (FINAL.has(row.status) && !row.hostLost)) continue;
      await tasks().mirror(row.taskId, { status: 'failed', hostWaiting: false, cancelPending: null, error: agentT(locale(), 'delegation.remote.hostNoRecord', { host: row.host.name }) });
    }
    changed();
  }

  // ---- 依頼元の会話への通知（ホストが落ちたままのとき。ADR 0171） ----

  const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const itemsOf = (rows, state) => rows.map(r => `- ${r.title || r.taskId} (${r.taskId})${state ? `: ${state(r)}` : ''}`).join('\n');
  const stillRunning = hostId => (tasks()?.rowsWhere(r => r.host?.hostId === hostId && !FINAL.has(r.status)) ?? []);
  const byParent = rows => { const m = new Map(); for (const r of rows) m.set(r.parentSessionId, [...(m.get(r.parentSessionId) ?? []), r]); return m; };
  const sending = new Set();

  /** 通知を 1 通送る。'requeue'（会話が受け取れない）なら false を返し、記録しない（次の確認でもう一度） */
  async function say(owner, build) {
    const key = `${owner}`;
    if (sending.has(key)) return false;
    sending.add(key);
    try { return (await deliverNotice(owner, build)) !== 'requeue'; }
    catch (e) { log(`remote delegation: ${e?.message ?? e}`); return true; }
    finally { sending.delete(key); }
  }

  let checking = false;
  /**
   * 定期の確認。走っている子（終わっていないホストの行）があるホストが offlineMinutes 以上オフラインのままなら、その依頼元の会話へ 1 通
   * （ホストと依頼元の組ごと。子ごとではない）。続くなら offlineRepeatMinutes あけてもう 1 回。口が無い間（更新の引き継ぎ）は数えない
   */
  async function checkOffline() {
    const offlineMs = offlineMinutes * 60000, repeatMs = offlineRepeatMinutes * 60000;
    if (checking || !bridge || !(offlineMs > 0) || bridge.connected === false) return;
    checking = true;
    try {
      const at = now();
      for (const h of hostsNow()) if (h.state === 'offline' && !offlineAt.has(h.hostId) && !seenOffline.has(h.hostId)) seenOffline.set(h.hostId, at);
      const ids = new Set([...offlineAt.keys(), ...seenOffline.keys()]);
      for (const hostId of ids) {
        const host = hostById(hostId);
        if (!host || host.state === 'ready') continue;
        const since = offlineAt.get(hostId) ?? seenOffline.get(hostId);
        if (at - since < offlineMs) continue;
        for (const [owner, rows] of byParent(stillRunning(hostId))) {
          const mine = told.get(hostId) ?? new Map();
          const rec = mine.get(owner);
          if (rec && (rec.n >= 2 || !(repeatMs > 0) || at - rec.at < repeatMs)) continue;
          const name = host.name ?? rows[0].host.name;
          const build = lng => agentT(lng, 'delegation.hostOfflineNotice', { host: name, since: hhmm(since), minutes: Math.round((at - since) / 60000),
            count: rows.length, items: itemsOf(rows) });
          if (!await say(owner, build)) continue;
          mine.set(owner, { at, n: (rec?.n ?? 0) + 1, taskIds: new Set([...(rec?.taskIds ?? []), ...rows.map(r => r.taskId)]) });
          told.set(hostId, mine);
        }
      }
    } finally { checking = false; }
  }

  /** つながり直した。不通を知らせたホストなら、追いつきの答え（synced）を待って（上限 syncWaitMs）まとめて知らせる */
  function reconnected(hostId) {
    offlineAt.delete(hostId); seenOffline.delete(hostId);
    if (!told.has(hostId) || catching.has(hostId)) return;
    const entry = { unknown: new Set(), timer: null };
    entry.timer = setTimeout(() => { report(hostId).catch(e => log(`remote delegation: ${e?.message ?? e}`)); }, syncWaitMs);
    entry.timer.unref?.();
    catching.set(hostId, entry);
  }

  /** synced が届いた（ホストが知らない ID を含む）。追いつきの待ちがあれば知らせる */
  async function caughtUp(hostId, unknown) {
    const entry = catching.get(hostId);
    if (!entry) return;
    for (const id of Array.isArray(unknown) ? unknown : []) entry.unknown.add(String(id));
    await report(hostId);
  }

  /** 追いつきの結果を、不通を知らせた依頼元ごとに 1 通で知らせる。走っている・終わった（結果は完了通知で届く）・ホストに記録が無い、の別 */
  async function report(hostId) {
    const entry = catching.get(hostId);
    const mine = told.get(hostId);
    if (!entry || !mine) return;
    catching.delete(hostId); told.delete(hostId);
    clearTimeout(entry.timer);
    await Promise.all([...working]);
    const name = hostById(hostId)?.name ?? '';
    for (const [owner, rec] of mine) {
      const rows = [...rec.taskIds].map(id => tasks()?.get(id)).filter(r => r?.host?.hostId === hostId);
      if (!rows.length) continue;
      const build = lng => {
        const label = r => (entry.unknown.has(r.taskId) ? agentT(lng, 'delegation.hostBackLost')
          : FINAL.has(r.status) ? agentT(lng, 'delegation.hostBackEnded', { status: r.status }) : agentT(lng, 'delegation.hostBackRunning'));
        return agentT(lng, 'delegation.hostBackNotice', { host: name || rows[0].host.name, items: itemsOf(rows, label) });
      };
      await say(owner, build);
    }
  }

  let unsubscribe = [];
  let ticker = null;
  function start() {
    if (!bridge || unsubscribe.length) return;
    unsubscribe = [
      bridge.onEvent(onEvent),
      bridge.onState((hostId, status) => {
        if (status.state === 'ready') { offlineAt.delete(hostId); seenOffline.delete(hostId); } else if (!offlineAt.has(hostId)) offlineAt.set(hostId, now());
        if (status.state !== 'ready') { const c = catching.get(hostId); if (c) { clearTimeout(c.timer); catching.delete(hostId); } }
        cards?.online(hostId, status.state === 'ready' && status.allowed);
        const done = stopped(status) ? retire(hostId).catch(e => log(`remote delegation: ${e?.message ?? e}`))
          : status.state !== 'ready' ? suspendTelemetry(hostId).catch(e => log(`remote delegation: ${e?.message ?? e}`)) : null;
        Promise.resolve(done).finally(changed);
      }),
      bridge.onReady((hostId, status) => { reconnected(hostId); return catchUp(hostId, status).catch(e => log(`remote delegation: ${e?.message ?? e}`)); }),
      // 一覧が変わった。この PC 側で任せる設定を切った・ホストを消したら、そのホストの動いていた写しは追えない（理由つきで終わらせる）
      bridge.onHosts(list => {
        const gone = new Set();
        for (const r of tasks()?.rowsWhere(x => x.host && !FINAL.has(x.status)) ?? []) {
          const h = list.find(x => x.hostId === r.host.hostId);
          if (!h || !h.agentUse) gone.add(r.host.hostId);
        }
        Promise.all([...gone].map(id => retire(id, 'unlinked'))).catch(e => log(`remote delegation: ${e?.message ?? e}`)).finally(changed);
      }),
    ];
    bridge.refresh().catch(() => {});
    ticker = setInterval(() => { checkOffline().catch(e => log(`remote delegation: ${e?.message ?? e}`)); }, 60_000);
    ticker.unref?.();
  }

  // ---- ply_delegate の host ----

  /**
   * ply_delegate { host, … }。ホストが子を作り、その写しを端末の台帳に足す。承認モードの引き上げが要るときは、ホストが計画を返し、
   * 依頼元の会話で 1 回だけ確かめる（askPermission。常に許可は出さない）。許可されたら同じ鍵で確定する。戻りは AI へ返す JSON
   */
  async function delegate({ owner, turn, args, lng, signal, askPermission, permissionTitle }) {
    const host = findHost(args.host, lng);
    const clean = {};
    for (const k of DELEGATE_KEYS) if (args[k] !== undefined) clean[k] = args[k];
    const requester = await requesterOf(owner, turn, lng);
    let res;
    try { res = await bridge.request(host.hostId, 'delegate', clean, requester, { signal }); }
    catch (e) { throw wrapped(e, host, lng); }
    if (res?.plan) {
      const answer = await askPermission({ plan: res.plan, host: host.name, title: permissionTitle?.(res.plan, host) });
      if (!answer?.allow) throw new DelegationError(agentT(lng, 'delegation.denied'), 'DENIED');
      try { res = await bridge.request(host.hostId, 'delegate', { ...clean, confirm: res.plan.key }, requester, { signal }); }
      catch (e) { throw wrapped(e, host, lng); }
      if (res?.plan) throw new DelegationError(agentT(lng, 'delegation.remote.planChanged'), 'PLAN_CHANGED');
    }
    const ev = res?.task;
    if (!ev?.taskId) throw new DelegationError(agentT(lng, 'delegation.remote.badResponse', { host: host.name }), 'BAD_RESPONSE');
    const row = await tasks().adopt({
      taskId: ev.taskId, parentSessionId: owner, host: { hostId: host.hostId, name: host.name }, title: ev.title ?? clean.title ?? null,
      task: clean.task, ...(clean.context !== undefined ? { context: clean.context } : {}), kind: clean.kind ?? null, ...patchOf(ev),
    }, lng);
    const early = orphans.get(ev.taskId);
    orphans.delete(ev.taskId);
    if (early && (early.event.updatedAt ?? 0) >= (ev.updatedAt ?? 0)) await onTask(host.hostId, early.event);
    changed();
    return present(tasks().get(ev.taskId) ?? row, host.name);
  }

  const wrapped = (e, host, lng) => {
    if (e?.code === 'OFFLINE') return new DelegationError(agentT(lng, 'delegation.remote.hostOffline', { host: host.name }), 'HOST_OFFLINE');
    if (e?.code === 'NOT_ALLOWED') return new DelegationError(agentT(lng, 'delegation.remote.hostNotAllowed', { host: host.name }), 'HOST_NOT_ALLOWED');
    return e;
  };

  /** AI へ返すタスクの形（端末の台帳の行から。host の名前・ホストでの会話は hostSessionId） */
  function present(row, hostName) {
    const { host, sessionId, parentSessionId, remoteSessionId, hostWaiting, cancelPending, hostLost, ...rest } = row;
    return { ...rest, host: hostName ?? host?.name ?? null, ...(remoteSessionId ? { hostSessionId: remoteSessionId } : {}), ...notesOf(row, hostName) };
  }

  /** AI に伝えておく事情: 止める依頼がまだホストへ届いていない／承認待ちの理由がホストの画面でしか答えられないもの（設定の変更の承認など） */
  function notesOf(row, hostName) {
    const name = hostName ?? row.host?.name ?? '';
    const hostOnly = [...open.values()].some(e => e.taskId === row.taskId && e.hostOnly);
    return {
      ...(row.cancelPending ? { cancelPending: true, note: agentT(locale(), 'delegation.remote.cancelPending', { host: name }) } : {}),
      ...(hostOnly ? { hostOnlyApproval: agentT(locale(), 'delegation.remote.hostOnlyApproval', { host: name }) } : {}),
    };
  }

  /**
   * ホストのタスクへの ply_task_status・ply_task_wait・ply_task_send・ply_task_cancel（写しの行があるもの）。
   * つながっていれば、ホストの答えを写しに反映して返す。つながっていない間は、status・wait は最後に分かっている状態を、send・cancel は失敗を返す。
   */
  async function taskCall({ owner, turn, name, args, signal, lng }) {
    const t = tasks();
    const row = t.get(String(args.taskId ?? ''));
    if (!row?.host || row.parentSessionId !== owner) throw new DelegationError(agentT(lng, 'tasks.notOwned'), 'NOT_OWNED');
    const host = hostById(row.host.hostId);
    const hostName = host?.name ?? row.host.name;
    const op = { ply_task_status: 'status', ply_task_wait: 'wait', ply_task_send: 'send', ply_task_cancel: 'cancel' }[name];
    if (!op) throw new DelegationError(agentT(lng, 'tasks.unknownTool'), 'UNKNOWN_TOOL');
    if (op === 'send' && ['backend', 'model', 'effort'].some(k => args[k] !== undefined)) throw new DelegationError(agentT(lng, 'delegation.remote.settingsUnsupported'), 'UNSUPPORTED');
    if (!usable(host)) {
      // wait は待つ約束なので、つながり直す（ready）か seconds が過ぎるまで待ってから返す（短い間隔で回らせない）
      if (op === 'wait') {
        await untilReady(row.host.hostId, (Number.isInteger(args.seconds) ? args.seconds : 30) * 1000, signal);
        if (usable(hostById(row.host.hostId))) return taskCall({ owner, turn, name, args: { ...args, seconds: 1 }, signal, lng });
      }
      if (op === 'status' || op === 'wait') {
        return { ...present(t.get(row.taskId) ?? row, hostName), hostOffline: true, note: agentT(lng, 'delegation.remote.statusOffline', { host: hostName }) };
      }
      // 止めるは、つながっていなくても約束する: 端末の写しを止めた状態にして「止める予定」を残し、つながり直したらホストへ送る（catchUp）
      if (op === 'cancel') {
        await t.cancel(row.taskId);
        return { ...present(t.get(row.taskId) ?? row, hostName), hostOffline: true };
      }
      throw new DelegationError(agentT(lng, 'delegation.remote.hostOffline', { host: hostName }), 'HOST_OFFLINE');
    }
    const requester = await requesterOf(owner, turn, lng);
    const wire = {};
    for (const k of ['taskId', 'offset', 'seconds', 'message']) if (args[k] !== undefined) wire[k] = args[k];
    // 同じ ID の依頼をホストが知らない（ホストの台帳が消えた）などの失敗はそのまま返す
    let out;
    try { out = await bridge.request(host.hostId, op, wire, requester, { signal, timeoutMs: op === 'wait' ? ((args.seconds ?? 30) + 15) * 1000 : 60_000 }); }
    catch (e) {
      if (e?.code === 'OFFLINE' && (op === 'status' || op === 'wait')) return { ...present(row, hostName), hostOffline: true, note: agentT(lng, 'delegation.remote.statusOffline', { host: hostName }) };
      throw wrapped(e, host, lng);
    }
    // ホストの答えの task（今の状態）を写しに反映する。結果は ply_task_status の戻りにそのまま載る
    if (out?.task) await t.mirror(row.taskId, { ...patchOf(out.task), ...(FINAL.has(out.task.rawStatus ?? out.task.status) && typeof out.result === 'string' && (out.nextOffset ?? null) === null && !args.offset ? { result: out.result, resultLength: out.resultLength ?? out.result.length } : {}) });
    const fresh = t.get(row.taskId) ?? row;
    const { task: _task, parentSessionId: _p, sessionId: hostSession, ...rest } = out ?? {};
    // 依頼元が終わった結果を受け取った。同じ結果の完了通知を後から送らない
    if (op === 'status' || op === 'wait' || op === 'cancel') { if (FINAL.has(fresh.status)) await t.markRead(row.taskId); }
    return { ...rest, host: hostName, taskId: row.taskId, ...(hostSession ? { hostSessionId: hostSession } : {}), ...notesOf(fresh, hostName) };
  }

  /** ホストがつながり直す（ready）か ms が過ぎるまで待つ（abort でも戻る） */
  function untilReady(hostId, ms, signal) {
    return new Promise(resolve => {
      let off = () => {};
      const done = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      off = bridge.onReady(id => { if (id === hostId) done(); });
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }

  /** ply_task_list の戻りの行を、ply_task_status と同じ形（host は名前）にする */
  function presentList(out) {
    if (!out?.tasks) return out;
    return { ...out, tasks: out.tasks.map(r => (r.host ? present(r) : r)) };
  }

  /** 会話の中断・取り消しで写しの行を止めるとき、ホストのタスクも止める（つながっていれば。最善の努力） */
  async function cancelHost(row) {
    const host = hostById(row?.host?.hostId);
    if (!usable(host)) return false;
    const requester = { sessionId: row.parentSessionId, title: '', locale: 'en', mode: modePosition(null) };
    try { await bridge.request(host.hostId, 'cancel', { taskId: row.taskId }, requester, { timeoutMs: 2500 }); return true; }
    catch { return false; }
  }

  /**
   * 中継されたカードへの人の答え。画面（human）の resolvePermission の処理からだけ呼ぶ（core/server.mjs）。
   * ホストが受け取れば { ok: true }（カードは畳む）。つながっていない・もう決着していたなら { ok: false, code }
   */
  async function answerCard(cardId, { allow, message, answers, annotations, response } = {}) {
    const entry = byCard.get(cardId);
    if (!entry) return { ok: false, code: 'NOT_FOUND' };
    if (entry.hostOnly) return { ok: false, code: 'HOST_ONLY' };
    const host = hostById(entry.hostId);
    if (!usable(host)) return { ok: false, code: 'OFFLINE' };
    let r;
    try { r = await bridge.answer(entry.hostId, { id: entry.relayId, receipt: entry.receipt, allow: allow === true, ...(message ? { message } : {}),
      ...(answers != null ? { answers } : {}), ...(annotations != null ? { annotations } : {}), ...(response != null ? { response } : {}) }); }
    catch (e) { return { ok: false, code: e?.code === 'OFFLINE' ? 'OFFLINE' : 'ERROR' }; }
    if (r?.ok) closeRelay(entry.hostId, entry.relayId, { by: 'device', allow: allow === true });
    return { ok: r?.ok === true, code: r?.code ?? null };
  }

  /**
   * 経過の読み出し（画面（human）の操作 delegation.hostView からだけ。AI の道具には無い）。taskId は端末の台帳にあるホストのタスク（根）か、
   * 読み出しで知ったその子孫。見せる範囲の絞り込みはホストがする（この端末が任せた子とその子孫だけ）。
   * 戻りは { state: 'ok' | 'offline' | 'unsupported' | 'denied' | 'failed', … }。ok のときだけホストの答え（task・messages・descendants など）を載せる
   */
  async function view({ taskId, hostId: asked = null, cursor = null }) {
    const row = tasks()?.get(taskId);
    const hostId = row?.host?.hostId ?? known.get(taskId) ?? null;
    if (!hostId || (asked && asked !== hostId)) return { state: 'failed', code: 'NOT_FOUND' };
    const host = hostById(hostId);
    if (!host || host.agentUse !== true) return { state: 'failed', code: 'NOT_FOUND' };
    if (host.state !== 'ready') return { state: 'offline', since: offlineAt.get(hostId) ?? null };
    if (!host.allowed) return { state: 'denied' };
    if (host.view !== true) return { state: 'unsupported' };
    try {
      const r = await bridge.view(hostId, taskId, cursor);
      for (const d of r?.descendants ?? []) {
        if (typeof d?.taskId !== 'string') continue;
        known.delete(d.taskId); known.set(d.taskId, hostId);
        if (known.size > 500) known.delete(known.keys().next().value);
      }
      return { state: 'ok', ...r };
    } catch (e) {
      if (e?.code === 'OFFLINE') return { state: 'offline', since: offlineAt.get(hostId) ?? null };
      if (e?.code === 'UNSUPPORTED') return { state: 'unsupported' };
      if (e?.code === 'NOT_ALLOWED') return { state: 'denied' };
      return { state: 'failed', code: e?.code ?? 'ERROR', error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  return {
    enabled: Boolean(bridge),
    start, checkOffline, describe, delegate, taskCall, cancelHost, answerCard, presentList, view,
    /** 線が使えなくなった時刻（使えるなら null。つながっていなかった間に起きたものは分からず null） */
    offlineSince: hostId => offlineAt.get(hostId) ?? null,
    isRemoteCard: cardId => byCard.has(cardId),
    /** そのタスクが、依頼元の会話に中継された承認を待っているか */
    waitingFor: taskId => [...open.values()].some(e => e.taskId === taskId),
    hostName: hostId => hostById(hostId)?.name ?? null,
    usable: hostId => usable(hostById(hostId)),
    /** 試験用: 開いている中継のカード */
    get openRelays() { return [...open.values()]; },
  };
}
