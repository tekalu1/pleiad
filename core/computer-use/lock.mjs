// コンピューターの操作のロックと、ターンごとの止めた印（docs/computer-use.md「ロック・待ち・止めた印」、ADR 0072）。
//
// PC のマウスとキーボードは 1 組なので、操作できるのは PC 全体で 1 つのターン（委譲の子も含む）。
// - 持ち主はターン。最初に撮影か入力をした呼び出しで取り、ターンの終わり（endTurn・signal の abort・橋を閉じる）で放す。
// - 2 つ目は列（FIFO）に並んで待つ。最長 waitMs（10 分）で busy。ターンの中で最初に待ち始めた時刻から数える。
// - 持ち主のターンの子孫（委譲の子）が取りに来たら、待たせずに貸す（持ち主が呼び出しを実行中でないとき。実行中なら終わってから）。
//   貸している間、持ち主の呼び出しは待つ。子のターンが終われば持ち主へ返す。持ち主が先に終われば、子がそのまま持ち主になる。
// - 同じターンの並列の呼び出しは直列にする。
// 純粋なロジックだけで、main や会話の保存には触れない（通知は onState・onArm・onStop の口で外へ出す）。

export const LOCK_WAIT_MS = 600_000;

export class LockError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const lockError = code => new LockError(code);

/**
 * @param waitMs ロックを待つ上限（既定 10 分。テストは縮める）
 * @param onState ({ sessionId, state: 'idle'|'running'|'waiting', holder?: { sessionId, title }, since? }) 会話ごとの状態が変わったとき
 * @param onArm (ownerId|null) ロックの持ち主が変わったとき（Esc の向け先）
 * @param onStop (ownerId) 持ち主のターンが中断されたとき（押したままの入力を離し、オーバーレイを消す）
 */
export function createComputerLock({ waitMs = LOCK_WAIT_MS, now = () => Date.now(), onState = () => {}, onArm = () => {}, onStop = () => {} } = {}) {
  const turns = new Map();       // turnId -> T
  let holder = null;             // 今操作してよいターン
  let lenders = [];              // holder に貸しているターン（末尾が直近）
  let queue = [];                // 待っているターン（FIFO）
  let armed = null;              // 最後に onArm へ渡した持ち主

  /** 呼び出しの時点のターンの情報から、ターンの状態を引く（無ければ作る）。title・ancestors は毎回新しい値に直す */
  function ensure(info) {
    let t = turns.get(info.turnId);
    if (!t) {
      t = { id: info.turnId, sessionId: info.sessionId ?? null, title: '', ancestors: [], signal: null, stopped: null, denied: new Set(), granted: new Set(),
        grantNoted: new Set(), running: 0, pending: 0, chain: Promise.resolve(), waitSince: null, waitTimer: null, busy: false, ended: false,
        wakers: new Set(), emitted: { state: 'idle', key: '' }, stateSince: now() };
      turns.set(t.id, t);
    }
    t.sessionId = info.sessionId ?? t.sessionId;
    t.title = info.title ?? t.title;
    t.ancestors = info.ancestors ?? t.ancestors;
    if (info.signal && t.signal !== info.signal) {
      t.signal = info.signal;
      // ターンの中断: 持ち主（貸し借りでつながるものを含む）なら、押したままの入力を離させてから放す
      const abort = () => {
        const wasOwner = t === holder || lenders.includes(t);
        if (wasOwner) { t.stopped ??= { reason: 'stop', at: now() }; try { onStop(t.id); } catch {} }
        release(t);
      };
      if (info.signal.aborted) queueMicrotask(abort);
      else info.signal.addEventListener('abort', abort, { once: true });
    }
    return t;
  }

  const wake = t => { for (const w of [...t.wakers]) w(); };
  const clearWait = t => { t.waitSince = null; if (t.waitTimer) { clearTimeout(t.waitTimer); t.waitTimer = null; } };

  function stateOf(t) {
    if (t.ended) return { state: 'idle' };
    if (t === holder) return { state: 'running' };
    const waiting = t.pending > 0 || queue.includes(t);
    if (waiting && holder) return { state: 'waiting', holder: { sessionId: holder.sessionId, title: holder.title } };
    if (lenders.includes(t)) return { state: 'running' };
    return { state: 'idle' };
  }

  /** 会話ごとの状態の変化を知らせる */
  function changed() {
    for (const t of [...turns.values()]) {
      const s = stateOf(t);
      const key = s.state + '|' + (s.holder?.sessionId ?? '') + '|' + (s.holder?.title ?? '');
      if (key === t.emitted.key) continue;
      if (s.state !== t.emitted.state) t.stateSince = now();
      t.emitted = { state: s.state, key };
      if (t.sessionId) {
        try { onState({ sessionId: t.sessionId, state: s.state, ...(s.holder ? { holder: s.holder } : {}), ...(s.state !== 'idle' ? { since: t.stateSince } : {}) }); } catch {}
      }
    }
    for (const [id, t] of [...turns]) if (t.ended && t.emitted.state === 'idle') turns.delete(id);
    const owner = holder?.id ?? null;
    if (owner !== armed) { armed = owner; try { onArm(owner); } catch {} }
  }

  function setHolder(t) {
    holder = t;
    if (t) { queue = queue.filter(x => x !== t); clearWait(t); wake(t); }
  }

  /** 空いていれば先頭を、持ち主が呼び出しを実行していなければ待っている子孫を、持ち主にする */
  function pump() {
    for (;;) {
      if (!holder) {
        const next = queue.shift();
        if (!next) break;
        setHolder(next);
        continue;
      }
      if (holder.running > 0 || holder.pending > 0) break;
      const child = queue.find(q => holder.sessionId && q.ancestors.includes(holder.sessionId));
      if (!child) break;
      lenders.push(holder);
      setHolder(child);
    }
    changed();
  }

  /** ターンの終わり。持ち主なら貸していた持ち主へ返し、待っている先頭を起こす */
  function release(t) {
    if (t.ended) return;
    t.ended = true;
    queue = queue.filter(x => x !== t);
    lenders = lenders.filter(x => x !== t);
    clearWait(t);
    if (holder === t) {
      holder = null;
      while (lenders.length) { const back = lenders.pop(); if (!back.ended) { setHolder(back); break; } }
    }
    wake(t);
    pump();
  }

  function expire(t) {
    t.waitTimer = null;
    if (t.ended || holder === t) return;
    queue = queue.filter(x => x !== t);
    t.waitSince = null;
    t.busy = true;
    wake(t);
    changed();
  }

  /** 待ち始めた印（ターンの中で最初に待ち始めた時刻）を付け、列に並ぶ。貸している側（lenders）は列に並ばず、返ってくるのを待つ */
  function startWaiting(t) {
    if (t.waitSince == null) {
      t.waitSince = now();
      t.waitTimer = setTimeout(() => expire(t), waitMs);
    }
    if (!lenders.includes(t) && !queue.includes(t)) queue.push(t);
  }

  async function acquire(t, signal, sliceMs) {
    const sliceEnd = sliceMs ? now() + sliceMs : Infinity;
    t.pending++;
    try {
      for (;;) {
        if (t.ended || signal?.aborted) throw lockError('aborted');
        if (t.stopped) throw lockError('stopped');
        if (t.busy) { t.busy = false; throw lockError('busy'); }
        if (holder === t) { clearWait(t); t.running++; return; }
        startWaiting(t);
        pump();
        if (holder === t) { clearWait(t); t.running++; return; }
        const left = sliceEnd - now();
        if (left <= 0) throw lockError('slice');
        await new Promise(resolve => {
          let timer = null;
          const done = () => { if (timer) clearTimeout(timer); t.wakers.delete(done); signal?.removeEventListener?.('abort', done); resolve(); };
          t.wakers.add(done);
          signal?.addEventListener?.('abort', done, { once: true });
          if (Number.isFinite(left)) timer = setTimeout(done, left);
        });
      }
    } finally { t.pending--; changed(); }
  }

  const untilOr = (promise, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(lockError('aborted'));
    const onAbort = () => reject(lockError('aborted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    promise.then(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, () => { signal?.removeEventListener?.('abort', onAbort); resolve(); });
  });

  return {
    /** ターンの状態（止めた印・拒否・このターンだけの許可）。呼び出しの時点の情報で更新して返す */
    turn: ensure,
    /**
     * ロックを取って fn を実行する。fn の間はこのターンが持ち主で、同じターンの別の呼び出しは待つ。
     * 例外: LockError（code: busy | slice | aborted | stopped）。sliceMs はこの 1 回の呼び出しで待つ最長の時間
     */
    async run(info, fn, { signal, sliceMs } = {}) {
      const t = ensure(info);
      const prev = t.chain;
      let done;
      t.chain = new Promise(r => { done = r; });
      try {
        await untilOr(prev, signal ?? t.signal);
        await acquire(t, signal ?? t.signal, sliceMs);   // 戻った時点で running は増えている（間に貸し出しが割り込まないように）
        try { return await fn(); }
        finally { t.running--; pump(); }
      } finally { done(); }
    },
    /** ターンの終わり（成功・失敗・中断）。ロックを放し、止めた印・拒否の記録も消す。このターンを知っていたか（操作の呼び出しがあったか）を返す */
    endTurn(turnId) { const t = turns.get(turnId); if (!t) return false; release(t); return true; },
    /** main か core が作り直された。持ち主を外し、待っている先頭に譲る */
    reset() {
      holder = null; lenders = [];
      pump();
    },
    /**
     * 会話の「止める」。その会話の走っているターンと、そこから貸している先（子）のターンに印を付ける。
     * 戻り: 印を付けたか。操作の呼び出しがまだ 1 つも無い（このロックが知らない）ターンなら false
     */
    stopSession(sessionId, reason = 'stop') {
      const t = [...turns.values()].reverse().find(x => !x.ended && x.sessionId === sessionId);
      if (!t) return { stopped: false, owner: null };
      const chain = [...lenders, ...(holder ? [holder] : [])];
      const at = chain.indexOf(t);
      const targets = at >= 0 ? chain.slice(at) : [t];
      for (const x of targets) { x.stopped ??= { reason, at: now() }; wake(x); }
      return { stopped: true, owner: holder?.id ?? null };
    },
    /** 物理の Esc。持ち主と、貸し借りでつながる全部のターンに印を付ける。owner が今の持ち主でなければ、そのターンだけ */
    escape(ownerId) {
      const t = turns.get(ownerId);
      const targets = holder && holder.id === ownerId ? [...lenders, holder] : t ? [t] : [];
      for (const x of targets) { x.stopped ??= { reason: 'escape', at: now() }; wake(x); }
      return targets.length > 0;
    },
    /** 今 running か waiting の会話の分（接続し直した画面に送り直す） */
    snapshot() {
      const out = [];
      for (const t of turns.values()) {
        if (!t.sessionId) continue;
        const s = stateOf(t);
        if (s.state !== 'idle') out.push({ sessionId: t.sessionId, state: s.state, ...(s.holder ? { holder: s.holder } : {}), since: t.stateSince });
      }
      return out;
    },
    /** 今の持ち主（テスト・確認用） */
    holder: () => (holder ? { turnId: holder.id, sessionId: holder.sessionId, title: holder.title } : null),
  };
}
