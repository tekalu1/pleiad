// エージェントのブラウザー（PC の Chrome）の止める・引き継ぐ・戻す（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154）。
//
// 窓（会話）ごとの状態:
//   running  エージェントのターンの間（第 4 段の focus emulation の付け外しと同じ合図）
//   idle     ターンの外（待機中）
//   stopped  「止める」: 接続を閉じ、次の人の送信まで再接続を断る（ターンの開始で鍵を作り直す。中継の stop / resume）
//   paused   「引き継ぐ」: 接続は切らず、エージェントのコマンドは全部断る（relay の PAUSED_MESSAGE）。窓は見える形に戻し、Pleiad の窓のある画面の中で前に出す。
//            映像は止める（captureBlocked。2 段階認証のコードなどを映さない）。「戻す」で窓を画面の外の見えない窓に戻し、一時停止を解く
// 状態は中継の会話の記録（turn・stopped・paused）が持ち、ここは操作（OS の層の reveal・raise・conceal の順序）と、状態の変わった便りと、戻したときの会話の行を受け持つ。
// 自動の一時停止は作らない（ADR 0154。窓が見えるのは引き継ぎのときだけ）。窓を × で閉じられても paused のまま（「戻す」で解き、次に使うとき黙って開き直す）。
// Chrome が閉じたときは中継が paused を解く。
//
// 状態の便り（onChange）は { sessionId, state, since } の形（since: paused の始まりの時刻 ms。それ以外は null）。ログには窓の題・URL を出さない。

export const CONTROL_STATES = Object.freeze(['running', 'idle', 'stopped', 'paused']);

export class ChromeControlError extends Error {
  /** code: NO_WINDOW（引き継げる窓が無い）・NOT_CONNECTED */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} deps
 * @param deps.relay    core/chrome/relay.mjs の中継（pause・unpause・state・scope・cdp・stop・onChange・onTap）
 * @param deps.os       core/chrome/os.mjs の口（引き継ぎの前に、押された直後の前面＝Pleiad の窓を取るのに使う）
 * @param [deps.record] 戻したときに会話へ残す行（({ sessionId, seconds }) → Promise）。失敗しても戻す操作は成功させる
 */
export function createChromeControl({ relay, os, now = Date.now, record = async () => {}, log = () => {} }) {
  const listeners = new Set();
  const last = new Map();      // 会話の id -> 最後に配った状態の印（同じ状態を重ねて配らない）
  const queues = new Map();    // 会話の id -> 操作の順番待ち（同じ会話の引き継ぎ・戻す・止めるを順に流す）

  function stateOf(sessionId) {
    const s = relay.state(sessionId);
    if (!s) return { sessionId, state: 'idle', since: null };
    const state = s.paused ? 'paused' : s.stopped ? 'stopped' : s.turn ? 'running' : 'idle';
    return { sessionId, state, since: s.paused?.at ?? null };
  }
  const mark = state => `${state.state}:${state.since ?? ''}`;

  const offChange = relay.onChange(sessionId => {
    const state = stateOf(sessionId);
    if (last.get(sessionId) === mark(state)) return;
    last.set(sessionId, mark(state));
    if (state.state === 'idle' && !relay.state(sessionId)) last.delete(sessionId);
    for (const fn of [...listeners]) { try { fn(state); } catch (error) { log(`chrome-control: listener failed: ${error?.message ?? error}`); } }
  });

  const serial = (sessionId, work) => {
    const run = (queues.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    queues.set(sessionId, tail);
    tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId); });
    return run;
  };

  async function doTakeOver(sessionId) {
    const before = relay.state(sessionId);
    if (!before) throw new ChromeControlError('NO_WINDOW', 'no agent browser window to hand over');
    if (before.paused) return stateOf(sessionId);
    // 押された直後の前面（Pleiad の窓）。窓をその画面の中へ戻す手がかりで、戻すときの前面の返し先にもなる
    const near = await Promise.resolve(os.foreground()).catch(() => null);
    relay.pause(sessionId, now());   // 先に断る（窓が見える間に、エージェントが操作を続けない）
    let result = { revealed: 0 };
    try { result = await relay.scope.reveal({ entryId: sessionId, near, front: before.lastWindowId }); }
    catch (error) { log(`chrome-control: reveal failed: ${error?.message ?? error}`); }
    if (!result.revealed) {
      relay.unpause(sessionId);
      throw new ChromeControlError('NO_WINDOW', 'the agent browser window could not be shown');
    }
    if (!result.raised) log('chrome-control: the window was shown but did not take the foreground');
    return stateOf(sessionId);
  }

  async function doResume(sessionId) {
    if (!relay.state(sessionId)?.paused) return stateOf(sessionId);
    // 窓を隠してから解く（見えている間は、エージェントのコマンドを通さない）
    try { await relay.scope.conceal({ entryId: sessionId, cdp: relay.cdp }); }
    catch (error) { log(`chrome-control: conceal failed: ${error?.message ?? error}`); }
    const at = relay.unpause(sessionId);
    if (at != null) {
      const seconds = Math.max(0, Math.round((now() - at) / 1000));
      await Promise.resolve(record({ sessionId, seconds })).catch(error => log(`chrome-control: record failed: ${error?.message ?? error}`));
    }
    return stateOf(sessionId);
  }

  async function doStop(sessionId) {
    if (!relay.state(sessionId)) return stateOf(sessionId);
    if (relay.state(sessionId).paused) await doResume(sessionId);   // 窓を戻してから止める
    relay.stop(sessionId);
    return stateOf(sessionId);
  }

  return {
    state: stateOf,
    /** 中継が知っている会話すべての今の状態（待機中のものは除く。画面がつなぎ直したとき） */
    snapshot: () => relay.sessionIds().map(stateOf).filter(state => state.state !== 'idle'),
    takeOver: sessionId => serial(sessionId, () => doTakeOver(sessionId)),
    resume: sessionId => serial(sessionId, () => doResume(sessionId)),
    stop: sessionId => serial(sessionId, () => doStop(sessionId)),
    /** 映像・撮影を断るか（引き継ぎ中。第 5 段の映像が呼ぶ） */
    captureBlocked: sessionId => Boolean(relay.state(sessionId)?.paused),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** エージェントが押した位置（{ sessionId, x, y, windowId }。右パネルの輪の元） */
    onTap: fn => relay.onTap(fn),
    close() { offChange(); listeners.clear(); },
  };
}
