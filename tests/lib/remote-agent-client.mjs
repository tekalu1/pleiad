// 試験用の /agent の端末側（docs/remote.md §4.5）。tests/lib/remote-device.mjs の端末から /agent を開き、便りの送受信を包む。
//
//   const a = await openAgent(device);            // { accepted, ready, call(op, args, requester), answer(...), events, next(pred), close() }
//   const r = await a.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:X' }, requester);   // { ok, result | code, error }
//   const ev = await a.next(e => e.t === 'task' && e.task.status === 'completed');
export function requesterOf(sessionId = 'sess-1', { title = '端末の会話', scope = 'workspace', autonomy = 'ask', enforced = false, locale = 'ja' } = {}) {
  return { sessionId, title, locale, mode: { scope, autonomy, enforced } };
}

export async function openAgent(device, { timeoutMs = 10_000 } = {}) {
  const w = await device.ws('/agent');
  if (!w.accepted) return { accepted: false, status: w.status, reset: w.reset };
  const events = [];
  const watchers = new Set();
  let seq = 0;
  const pending = new Map();
  const closed = w.remoteClose.then(c => { for (const p of pending.values()) p.rej(new Error(`口が閉じた（${c.code}）`)); return c; });
  (async () => {
    for (;;) {
      let raw;
      try { raw = await w.next(60 * 60_000); } catch { return; }
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if ((m.t === 'res' || m.t === 'viewed') && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.res(m); continue; }
      events.push(m);
      for (const x of [...watchers]) if (x.pred(m)) { watchers.delete(x); x.res(m); }
    }
  })();
  const waitFor = (pred, ms = timeoutMs, label = '便り', { fresh = false } = {}) => {
    const hit = fresh ? null : events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const x = { pred, res: m => { clearTimeout(timer); res(m); } };
      const timer = setTimeout(() => { watchers.delete(x); rej(new Error(`${label} が ${ms}ms 届かない: ${JSON.stringify(events.slice(-5))}`)); }, ms);
      watchers.add(x);
    });
  };
  const send = msg => w.send(JSON.stringify(msg));
  const api = {
    accepted: true, events, closed, raw: w,
    ready: await waitFor(e => e.t === 'ready', timeoutMs, 'ready'),
    send,
    /** 依頼 1 つ。{ ok, result } か { ok: false, code, error } */
    call(op, args = {}, requester = requesterOf(), ms = 30_000) {
      const id = `r${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} の答えが来ない`)); }, ms);
        pending.set(id, { res: m => { clearTimeout(timer); resolve(m); }, rej: e => { clearTimeout(timer); reject(e); } });
        send({ t: 'req', id, op, args, requester }).catch(reject);
      });
    },
    /** 経過の読み出し 1 つ（人の操作。AI の依頼ではない）。{ ok, result } か { ok: false, code, error } */
    view(taskId, cursor = null, ms = 30_000) {
      const id = `v${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('view の答えが来ない')); }, ms);
        pending.set(id, { res: m => { clearTimeout(timer); resolve(m); }, rej: e => { clearTimeout(timer); reject(e); } });
        send({ t: 'view', id, taskId, ...(cursor ? { cursor } : {}) }).catch(reject);
      });
    },
    /** 条件に合う便りを（もう届いていればそれを）待つ */
    next: waitFor,
    /** これから届く便りだけを待つ（もう届いた分は見ない。同じ種類の答えを何度も確かめるとき） */
    fresh: (pred, ms, label) => waitFor(pred, ms, label, { fresh: true }),
    /** 条件に合う便りが、これから `ms` の間に来ないこと */
    async none(pred, ms = 400) { const before = events.length; await new Promise(r => setTimeout(r, ms)); return !events.slice(before).some(pred); },
    close() { return w.close(); },
  };
  return api;
}
