// 端末（デスクトップ版）の main がホストへ張る、AI 用の線（docs/remote.md §4.5、ADR 0141）。
//
// DeviceLink（中継を通るチャネル。device-link.mjs）の上に /agent の WebSocket のストリームを 1 本開き、決まった便りを交わす:
//   request(op, args, requester)  委譲の 6 つの操作（delegate・status・wait・send・cancel・list）。ホストの答えで解決する
//   answer({ id, receipt, allow }) 承認の中継への人の答え（端末の画面の resolvePermission からだけ呼ばれる。remote.md §4.5）
//   sync(taskIds)                  つなぎ直したとき、持っているタスクの今の状態を求める
// ホストの便り（task・relays・relay・relayEnd・allowed）は 'event' で出す。状態（state）は
//   'offline'      チャネルが無い・口が閉じた（張り直しは DeviceLink が受け持ち、チャネルが戻れば口も開き直す）
//   'connecting'   口を開いて ready を待っている
//   'ready'        使える（allowed はホストが端末の AI からの依頼を受けているか）
//   'unsupported'  ホストが /agent を知らない（古い版。RESET 3）
//   'revoked'      この端末はホストで取り消された
import { EventEmitter } from 'node:events';
import { RESET_CODE } from './frames.mjs';
import { AGENT_PATH, AGENT_PROTO, AGENT_LIMITS } from './agent-protocol.mjs';

const REQUEST_TIMEOUT_MS = 60_000;

export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}

export class AgentLink extends EventEmitter {
  /** link: DeviceLink。start() で聞き始める（link の start は呼び側） */
  constructor({ link, requestTimeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
    super();
    this.link = link;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.state = 'offline';
    this.allowed = false;
    this.hostName = '';
    this.stream = null;
    this.pending = new Map();
    this.seq = 0;
    this.started = false;
    this.reopenTimer = null;
    this.reopenAttempt = 0;
    this.onChannel = ch => { this.reopenAttempt = 0; this.#open(ch); };
    this.onStatus = s => {
      if (s.state === 'revoked') this.#drop('revoked');
      else if (s.state !== 'connected' && s.state !== 'connecting') this.#drop('offline');
    };
  }

  get status() { return { state: this.state, allowed: this.allowed, hostName: this.hostName }; }
  /** 今すぐ依頼を出せるか（口が開いていて、ホストが許可している） */
  get usable() { return this.state === 'ready' && this.allowed; }

  start() {
    if (this.started) return;
    this.started = true;
    this.link.on('channel', this.onChannel);
    this.link.on('status', this.onStatus);
    if (this.link.channel && !this.link.channel.closed) this.#open(this.link.channel);
    else if (this.link.state === 'revoked') this.#setState('revoked');
  }

  /** 口だけが閉じた（ホストが許可を切った・口を閉じた）。チャネルが生きていれば、間を置いて開き直す（1 秒から 15 秒まで倍々。取り消し・未対応は開き直さない） */
  #reopenLater() {
    if (!this.started || this.reopenTimer || this.state === 'revoked' || this.state === 'unsupported') return;
    const delay = Math.min(15_000, 1000 * 2 ** this.reopenAttempt++);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      const ch = this.link.channel;
      if (this.started && ch && !ch.closed && !this.stream) this.#open(ch);
    }, delay);
    this.reopenTimer.unref?.();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.link.off('channel', this.onChannel);
    this.link.off('status', this.onStatus);
    const s = this.stream;
    this.stream = null;
    this.#failPending(new AgentError('OFFLINE', 'agent link stopped'));
    try { s?.close(1000).catch(() => {}); } catch { /* 閉じかけ */ }
    this.state = 'offline';
  }

  #setState(state, extra = {}) {
    const changed = state !== this.state || (extra.allowed !== undefined && extra.allowed !== this.allowed) || (extra.hostName !== undefined && extra.hostName !== this.hostName);
    this.state = state;
    if (extra.allowed !== undefined) this.allowed = extra.allowed === true;
    if (extra.hostName !== undefined) this.hostName = String(extra.hostName);
    if (changed) this.emit('state', this.status);
  }

  #failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  #drop(state = 'offline') {
    const had = this.stream;
    this.stream = null;
    this.#failPending(new AgentError('OFFLINE', 'the host is offline'));
    if (had) { try { had.reset(RESET_CODE.CANCEL); } catch { /* もう無い */ } }
    // 許可の最後の値は、オフラインの間も覚える（一覧に「オフライン」の印で出すため）。知らない・取り消された間だけ捨てる
    this.#setState(state, state === 'unsupported' || state === 'revoked' ? { allowed: false } : {});
  }

  #open(ch) {
    if (!this.started || ch.closed) return;
    // 前のチャネルの口は、そのチャネルが閉じたときに捨ててある
    let s;
    try { s = ch.openWs({ path: AGENT_PATH, protocols: [] }); }
    catch (e) { this.log(`remote agent: ${e.message}`); return this.#drop('offline'); }
    this.stream = s;
    this.#setState('connecting');
    const mine = () => this.stream === s;
    s.on('accept', () => { /* ready を待つ */ });
    s.on('reject', () => { if (mine()) this.#drop('unsupported'); });
    s.on('reset', code => {
      if (!mine()) return;
      this.stream = null;
      this.#failPending(new AgentError('OFFLINE', 'the host is offline'));
      this.#setState(code === RESET_CODE.FORBIDDEN ? 'unsupported' : 'offline', code === RESET_CODE.FORBIDDEN ? { allowed: false } : {});
      this.#reopenLater();
    });
    s.on('close', (code, reason) => {
      if (!mine()) return;
      s.close(code === 1005 ? 1000 : code, reason ?? '').catch(() => {});
      this.stream = null;
      this.#failPending(new AgentError('OFFLINE', 'the host closed the agent port'));
      this.#setState(code === 1008 && reason === 'revoked' ? 'revoked' : 'offline', code === 1008 && reason === 'revoked' ? { allowed: false } : {});
      this.#reopenLater();
    });
    s.on('message', (data, text, release) => {
      release();
      if (!mine() || !text || data.length > AGENT_LIMITS.messageBytes) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) this.#onMessage(msg);
    });
  }

  #onMessage(msg) {
    switch (msg.t) {
      case 'ready':
        this.reopenAttempt = 0;
        if (msg.v !== AGENT_PROTO) { this.log(`remote agent: unknown protocol ${msg.v}`); return this.#drop('unsupported'); }
        this.#setState('ready', { allowed: msg.allowed === true, hostName: typeof msg.hostName === 'string' ? msg.hostName : this.hostName });
        this.emit('ready', this.status);
        return;
      case 'allowed':
        this.#setState(this.state === 'offline' ? 'ready' : this.state, { allowed: msg.allowed === true });
        if (msg.allowed !== true && msg.reason === 'revoked') this.#setState('revoked', { allowed: false });
        return;
      case 'res': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.signal?.removeEventListener('abort', p.onAbort);
        if (msg.ok === true) p.resolve(msg.result ?? null);
        else p.reject(Object.assign(new AgentError(typeof msg.code === 'string' ? msg.code : 'ERROR', String(msg.error ?? 'error'))));
        return;
      }
      case 'task': case 'relays': case 'relay': case 'relayEnd': case 'answered': case 'pong': case 'synced':
        this.emit('event', msg);
        return;
      default: return;
    }
  }

  #send(msg) {
    const s = this.stream;
    if (!s || this.state === 'offline' || s.destroyed || s.localDone) throw new AgentError('OFFLINE', 'the host is offline');
    s.send(JSON.stringify(msg)).catch(() => {});
  }

  /** 委譲の 6 つの操作のどれか 1 つ。ホストの答え（result）で解決し、ホストの失敗は AgentError（code・message）で reject する。オフラインなら即座に reject（OFFLINE） */
  request(op, args = {}, requester = null, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (!this.usable) return Promise.reject(new AgentError(this.state === 'ready' ? 'NOT_ALLOWED' : 'OFFLINE', this.state === 'ready' ? 'the host does not accept requests from this device' : 'the host is offline'));
    return new Promise((resolve, reject) => {
      const id = `a${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError('TIMEOUT', 'the host did not answer')); }, timeoutMs);
      timer.unref?.();
      const onAbort = () => { if (this.pending.delete(id)) { clearTimeout(timer); reject(new AgentError('ABORTED', 'aborted')); } };
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      try { this.#send({ t: 'req', id, op, args, requester }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /** 承認の中継への人の答え。ホストの `answered` で解決する（{ ok, code? }）。オフラインなら reject（OFFLINE） */
  answer({ id, receipt, allow, message, answers, annotations, response }, { timeoutMs = 15_000 } = {}) {
    if (!this.usable) return Promise.reject(new AgentError('OFFLINE', 'the host is offline'));
    return new Promise((resolve, reject) => {
      const off = () => { this.off('event', onEvent); clearTimeout(timer); };
      const onEvent = e => { if (e.t === 'answered' && e.id === id) { off(); resolve({ ok: e.ok === true, code: e.code ?? null }); } };
      const timer = setTimeout(() => { off(); reject(new AgentError('TIMEOUT', 'the host did not answer')); }, timeoutMs);
      timer.unref?.();
      this.on('event', onEvent);
      try { this.#send({ t: 'answer', id, receipt, allow: allow === true, ...(message ? { message } : {}),
        ...(answers != null ? { answers } : {}), ...(annotations != null ? { annotations } : {}), ...(response != null ? { response } : {}) }); }
      catch (e) { off(); reject(e); }
    });
  }

  /** つなぎ直したとき: 持っているタスクの今の状態（task の便り）と、待っている中継する承認（relays）を求める */
  sync(taskIds = []) {
    if (!this.usable) return false;
    try { this.#send({ t: 'sync', taskIds: taskIds.slice(0, 100) }); return true; } catch { return false; }
  }
}
