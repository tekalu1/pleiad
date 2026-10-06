// ホストの接続口の「端末の AI 用の口」/agent（docs/remote.md §4.5、ADR 0146）。サーバーのプロセスの中で動く。
//
// 端末の AI（端末の会話の ply_delegate の host と ply_task_*）の依頼を受け、ホストのサーバーの委譲の本体（deps.invoke）へ渡す。
// 主体は agent・via: 'remote'・deviceId。画面（human）の経路 /ws とは別の口で、口の上の便りは決まった種類だけ:
//   端末 → ホスト   req（委譲の 6 つの操作）・answer（人の答え。承認の中継の答え）・sync・ping
//   ホスト → 端末   ready・allowed・res・task・relays・relay・relayEnd・answered・pong
// 許可は端末ごと（deps.allowed）。承認の答えは、ホストが中継した今待っている承認の ID・受領証・1 回だけを照合してから受ける。
// 端末の AI が呼べる道具からは answer を作れない（端末側の守りと、口の種類の分離。docs/remote.md §4.5）。
import crypto from 'node:crypto';
import { RESET_CODE } from './frames.mjs';
import { AGENT_OPS, AGENT_LIMITS, AGENT_PROTO, AgentError, normalizeRequester, normalizeAnswerExtras, relayReceipt, sameReceipt } from './agent-protocol.mjs';

const idOk = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && !/[\0\r\n]/.test(v);

/**
 * @param deps.allowed(deviceId)        この端末の AI からの依頼を受けてよいか（devices.json の agentDelegation。デスクトップ版の端末だけ）
 * @param deps.hostName()               ready に載せるホストの名前
 * @param deps.invoke(call)             委譲の本体。call = { device, requester, op, args, signal }。結果の JSON を返すか AgentError を投げる
 * @param deps.activeTasks(deviceId)    この端末から任された、動いているタスクの数（任された子の子孫も数える。上限の判定）
 * @param deps.wakes(device, requester, args)  send が、終わっているタスクを起こし直す（動いている数を増やす）か。起こすなら 1 枠の予約が要る
 * @param deps.tasksFor(deviceId, ids)  sync の答え。ids のタスクの今の公開の形（task の便りの形）の配列
 * @param deps.audit(entry)             記録（by・via・deviceId・種類）。失敗しても口は止めない
 */
export function createAgentPort({ allowed = () => false, hostName = () => '', invoke, activeTasks = () => 0, wakes = () => false, tasksFor = () => [], audit = () => {}, log = () => {}, limits = {}, now = Date.now } = {}) {
  const lim = { ...AGENT_LIMITS, ...limits };
  const conns = new Map();         // deviceId → Set<conn>
  const relays = new Map();        // relayId → { id, deviceId, taskId, requesterSessionId, receipt, payload, answer, answered }
  const rate = new Map();          // deviceId → delegate・send の時刻の配列（1 分の窓）
  const reserved = new Map();      // deviceId → 確かめてから行ができるまでの間に取った枠の数（同時に確かめて全部通る競合を防ぐ）
  const gens = new Map();          // deviceId → 世代。許可を切る・取り消す・すべて止めるたびに増やし、作りかけの依頼が子を作らないよう invoke が見る
  const pendingOf = deviceId => { let n = 0; for (const c of connsOf(deviceId)) n += c.pending.size; return n; };
  const abortPending = deviceId => { for (const c of connsOf(deviceId)) { for (const ac of c.pending) ac.abort(); c.pending.clear(); } };

  const connsOf = deviceId => conns.get(deviceId) ?? new Set();

  function sendTo(conn, msg) {
    if (conn.stream.destroyed || conn.stream.localDone) return false;
    const body = JSON.stringify(msg);
    if (Buffer.byteLength(body) > lim.messageBytes) return false;
    conn.stream.send(body).catch(() => {});
    return true;
  }
  function broadcast(deviceId, msg) {
    let any = false;
    for (const conn of connsOf(deviceId)) any = sendTo(conn, msg) || any;
    return any;
  }

  const publicRelay = r => ({ id: r.id, taskId: r.taskId, requesterSessionId: r.requesterSessionId, receipt: r.receipt, askedAt: r.askedAt, ...r.payload });
  const relaysOf = deviceId => [...relays.values()].filter(r => r.deviceId === deviceId && !r.answered).map(publicRelay);

  function rateOk(deviceId) {
    const t = now();
    const list = (rate.get(deviceId) ?? []).filter(x => t - x < 60_000);
    if (list.length >= lim.perMinute) { rate.set(deviceId, list); return false; }
    list.push(t);
    rate.set(deviceId, list);
    return true;
  }

  async function onReq(conn, msg) {
    const reply = body => sendTo(conn, { t: 'res', id: msg.id, ...body });
    const device = conn.device;
    if (!allowed(device.id)) return reply({ ok: false, code: 'NOT_ALLOWED', error: 'this device is not allowed to delegate to this host' });
    const requester = normalizeRequester(msg.requester);
    if (!AGENT_OPS.includes(msg.op) || !requester) return reply({ ok: false, code: 'BAD_REQUEST', error: 'bad request' });
    const args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
    if (conn.pending.size >= lim.pending || pendingOf(device.id) >= lim.pendingPerDevice) return reply({ ok: false, code: 'RATE_LIMITED', error: 'too many requests in flight' });
    const refuse = (code, error) => { audit({ by: 'agent', via: 'remote', deviceId: device.id, op: msg.op, refused: code }); return reply({ ok: false, code, error }); };
    if (msg.op === 'delegate' || msg.op === 'send') {
      if (!rateOk(device.id)) return refuse('RATE_LIMITED', `at most ${lim.perMinute} delegations or instructions per minute`);
    }
    // 動いているタスクの上限。新しい子を作る・終わったタスクを起こし直すときだけ枠が要る。確かめと行の作成の間に同じ端末の依頼が入っても数えるよう、予約を先に取る
    const needsSlot = msg.op === 'delegate' || (msg.op === 'send' && wakes(device, requester, args));
    const gen = gens.get(device.id) ?? 0;
    if (needsSlot) {
      if (activeTasks(device.id) + (reserved.get(device.id) ?? 0) >= lim.active) return refuse('TOO_MANY_TASKS', `at most ${lim.active} tasks at a time`);
      reserved.set(device.id, (reserved.get(device.id) ?? 0) + 1);
    }
    const ac = new AbortController();
    conn.pending.add(ac);
    const valid = () => !ac.signal.aborted && (gens.get(device.id) ?? 0) === gen && allowed(device.id);
    try {
      const result = await invoke({ device, requester, op: msg.op, args, signal: ac.signal, valid });
      // 止められた・許可が変わった後に終わった依頼の答えは、端末へ返さない（invoke が作ったものは、invoke の側で取り消してある）
      if (!valid()) return reply({ ok: false, code: 'NOT_ALLOWED', error: 'this device is no longer allowed to delegate to this host' });
      audit({ by: 'agent', via: 'remote', deviceId: device.id, op: msg.op, args, result });
      reply({ ok: true, result: result ?? null });
    } catch (e) {
      reply({ ok: false, code: e instanceof AgentError ? e.code : 'ERROR', error: String(e?.message ?? e) });
    } finally {
      conn.pending.delete(ac);
      if (needsSlot) reserved.set(device.id, Math.max(0, (reserved.get(device.id) ?? 1) - 1));
    }
  }

  async function onAnswer(conn, msg) {
    const deviceId = conn.device.id;
    const fail = (code) => {
      log(`remote agent: answer dropped (${code}) device=${deviceId}`);
      audit({ by: 'human', via: 'remote-device', deviceId, op: 'answer', dropped: code, relayId: idOk(msg.id) ? msg.id : null });
      sendTo(conn, { t: 'answered', id: idOk(msg.id) ? msg.id : '', ok: false, code });
    };
    if (!idOk(msg.id)) return fail('BAD_REQUEST');
    const entry = relays.get(msg.id);
    // 自分が中継した、今待っている承認で、この端末へ中継したものだけ。1 回だけ（answered を先に立てる）
    if (!entry || entry.answered || entry.deviceId !== deviceId) return fail('NOT_FOUND');
    if (!allowed(deviceId)) return fail('NOT_ALLOWED');
    // ホストの画面で答えるしかない承認（設定の変更の承認など）は、口からは答えられない
    if (typeof entry.answer !== 'function') return fail('NOT_ANSWERABLE');
    if (!sameReceipt(msg.receipt, entry.receipt)) return fail('RECEIPT_MISMATCH');
    entry.answered = true;
    let ok = false;
    try { ok = await entry.answer({ allow: msg.allow === true, message: typeof msg.message === 'string' ? msg.message.slice(0, 2000) : null, ...normalizeAnswerExtras(msg) }); }
    catch (e) { log(`remote agent: answer failed: ${e?.message ?? e}`); }
    if (!ok) { entry.answered = false; return fail('ALREADY_RESOLVED'); }
    audit({ by: 'human', via: 'remote-device', deviceId, op: 'answer', allow: msg.allow === true, taskId: entry.taskId });
    sendTo(conn, { t: 'answered', id: msg.id, ok: true });
  }

  function onMessage(conn, data, text) {
    if (!text || data.length > lim.messageBytes) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    switch (msg.t) {
      case 'ping': sendTo(conn, { t: 'pong' }); return;
      case 'req': if (idOk(msg.id)) onReq(conn, msg).catch(e => log(`remote agent: ${e?.message ?? e}`)); return;
      case 'answer': onAnswer(conn, msg).catch(e => log(`remote agent: ${e?.message ?? e}`)); return;
      case 'sync': {
        const ids = Array.isArray(msg.taskIds) ? msg.taskIds.filter(x => typeof x === 'string' && x.length <= 100).slice(0, 100) : [];
        const known = new Set();
        if (allowed(conn.device.id)) for (const task of tasksFor(conn.device.id, ids)) { known.add(task.taskId); sendTo(conn, { t: 'task', task }); }
        // 知らない ID（ホストの台帳に無い）を知らせる。端末は、動いているつもりの写しを「ホストに記録が無い」として終わらせる
        if (allowed(conn.device.id)) sendTo(conn, { t: 'synced', unknown: ids.filter(id => !known.has(id)) });
        sendTo(conn, { t: 'relays', relays: allowed(conn.device.id) ? relaysOf(conn.device.id) : [] });
        return;
      }
      default: return;   // 知らない種類は捨てる
    }
  }

  return {
    /** 端末のストリーム 1 本（WebSocket の /agent）を受ける。device は { id, name, platform }（ハンドシェイクで確かめた端末） */
    attach(stream, device) {
      if (stream.kind !== 'ws') return stream.reset(RESET_CODE.FORBIDDEN);
      const conn = { stream, device: { id: device.id, name: device.name ?? '', platform: device.platform ?? '' }, pending: new Set() };
      // 端末 1 台の口の数に上限（待つ依頼を口ごとに積ませない）。多すぎる口は、受けてすぐ閉じる（端末の線は間を置いて開き直す）
      if (connsOf(device.id).size >= lim.portsPerDevice) { stream.accept().then(() => stream.close(1013, 'too many ports')).catch(() => {}); return; }
      if (!conns.has(device.id)) conns.set(device.id, new Set());
      conns.get(device.id).add(conn);
      const drop = () => {
        for (const ac of conn.pending) ac.abort();
        conn.pending.clear();
        const set = conns.get(device.id);
        set?.delete(conn);
        if (set && !set.size) conns.delete(device.id);
      };
      stream.on('message', (data, text, release) => { release(); onMessage(conn, data, text); });
      stream.on('close', (code, reason) => { drop(); stream.close(code === 1005 ? 1000 : code, reason ?? '').catch(() => {}); });
      stream.on('reset', drop);
      stream.accept().then(() => {
        const ok = allowed(device.id);
        sendTo(conn, { t: 'ready', v: AGENT_PROTO, allowed: ok, hostName: hostName(), limits: { active: lim.active, perMinute: lim.perMinute } });
        if (ok) sendTo(conn, { t: 'relays', relays: relaysOf(device.id) });
      }).catch(() => drop());
    },

    /** 端末がつながっているか（完了の便りを届けられるか） */
    online: deviceId => connsOf(deviceId).size > 0,
    /** 許可が変わった（スイッチ）。つながっている口へ知らせる */
    refresh(deviceId) {
      const ok = allowed(deviceId);
      broadcast(deviceId, { t: 'allowed', allowed: ok });
      if (ok) broadcast(deviceId, { t: 'relays', relays: relaysOf(deviceId) });
    },
    /** 端末を取り消した・許可を切った。口を閉じ、中継中の承認の登録は捨てる（子の会話のカードはホストに残る） */
    closeDevice(deviceId, reason = 'revoked') {
      // 作りかけの依頼は、相手の close を待たずに今打ち切る（子を作らせない）。世代も進める
      gens.set(deviceId, (gens.get(deviceId) ?? 0) + 1);
      abortPending(deviceId);
      for (const conn of [...connsOf(deviceId)]) {
        sendTo(conn, { t: 'allowed', allowed: false, reason });
        conn.stream.close(1008, reason).catch(() => {});
      }
      for (const [id, r] of relays) if (r.deviceId === deviceId) relays.delete(id);
    },
    /** 作りかけの依頼を打ち切り、世代を進める（「すべて止める」。口は閉じない）。これから終わる依頼は子を作らない */
    cutOff(deviceId) { gens.set(deviceId, (gens.get(deviceId) ?? 0) + 1); abortPending(deviceId); },
    /** タスクの今の状態を端末へ。つながっている口が 1 つも無ければ false（完了通知を「届いた」にしない） */
    pushTask: (deviceId, task) => broadcast(deviceId, { t: 'task', task }),

    /**
     * 子の承認・質問を端末へ中継する（ホストの承認の待ちに 1 つ足す）。answer({ allow, message, answers, annotations, response }) は決着を引き受ける関数
     * （server が子の承認の settle を呼ぶ。決着済みなら false）。answer が無いものは「ホストの画面で答えてください」の知らせ
     * （設定の変更の承認など。端末のカードに答えるボタンは無く、口からの答えも受けない）。
     * 返す end(by, allow) は、ホスト側で決着した・取り下げたときに呼ぶ（端末のカードを畳む）
     */
    relayOpen({ deviceId, taskId, requesterSessionId, payload, answer = null }) {
      const id = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      const entry = { id, deviceId, taskId, requesterSessionId, payload, answer, answered: false, askedAt: new Date().toISOString(),
        receipt: relayReceipt({ id, taskId, toolName: payload.toolName, input: payload.input, questions: payload.questions, salt }) };
      relays.set(id, entry);
      broadcast(deviceId, { t: 'relay', relay: publicRelay(entry) });
      return {
        id,
        end: (by, allow) => {
          if (!relays.delete(id)) return;
          // 端末の答えが決着させたときは、settle の中から呼ばれる（answered は答えを引き受ける前に立てる）。どこで答えたかはそこで決まる
          broadcast(deviceId, { t: 'relayEnd', id, by: entry.answered ? 'device' : by, allow: allow === true });
        },
      };
    },
    relayCount: deviceId => relaysOf(deviceId).length,
  };
}
