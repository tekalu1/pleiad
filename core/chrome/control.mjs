// エージェントのブラウザー（PC の Chrome）の止める・引き継ぐ・戻す（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154）。
//
// 窓（会話）ごとの状態:
//   running  エージェントのターンの間（第 4 段の focus emulation の付け外しと同じ合図）
//   idle     ターンの外（待機中）
//   stopped  「止める」: 接続を閉じ、次の人の送信まで再接続を断る（ターンの開始で鍵を作り直す。中継の stop / resume）
//   paused   「引き継ぐ」: エージェントのブラウザーとタブの接続を切り（Chrome からの通知を流さない）、つなぎ直されたコマンドも全部断る（relay の PAUSED_MESSAGE）。窓は見える形に戻し、Pleiad の窓のある画面の中で前に出す。
//            映像は止める（captureBlocked。2 段階認証のコードなどを映さない）。「戻す」で窓を画面の外の見えない窓に戻し、一時停止を解く
// 状態は中継の会話の記録（turn・stopped・paused）が持ち、ここは操作（OS の層の reveal・raise・conceal の順序）と、状態の変わった便りと、戻したときの会話の行を受け持つ。
// 自動の一時停止は作らない（ADR 0154。窓が見えるのは引き継ぎのときだけ）。窓を × で閉じられても paused のまま（「戻す」で解き、次に使うとき黙って開き直す）。
// Chrome が閉じたときは中継が paused を解く。
//
// 撮影を断る（右パネルの映像。core/chrome/screencast.mjs の suspend / resume）: paused に入った時に同期で suspend し、paused が解けた時に resume する。
// 解け方（戻す・止める・Chrome が閉じた・会話の削除・id の付け替え）に依らず、中継の状態の変化から対にする（付け替え・削除で消えた会話の分は次の変化で resume して片付ける。
// 映像の側も、会話の削除・接続の切断で断りを自分で消し、id の付け替えで新しい id へ移す）。
// 状態の便り（onChange）は { sessionId, state, since, error } の形（since: paused の始まりの時刻 ms。それ以外は null。error: 戻せなかった理由 'conceal-failed'（paused のまま）。無ければ null）。ログには窓の題・URL を出さない。

export const CONTROL_STATES = Object.freeze(['running', 'idle', 'stopped', 'paused']);

export class ChromeControlError extends Error {
  /** code: NO_WINDOW（引き継げる窓が無い）・NOT_CONNECTED */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} deps
 * @param deps.relay    core/chrome/relay.mjs の中継（pause・unpause・state・scope・cdp・stop・onChange・onTap）
 * @param deps.os       core/chrome/os.mjs の口（引き継ぎで、窓を戻す画面の手がかり＝Pleiad の窓（appWindow）・無ければその時の前面（foreground）を取るのに使う）
 * @param [deps.capture] 映像の撮影を断る口（{ suspend(sessionId), resume(sessionId) }。core/chrome/screencast.mjs）。無ければ断らない（captureBlocked は引ける）
 * @param [deps.record] 戻したときに会話へ残す行（({ sessionId, seconds }) → Promise）。失敗しても戻す操作は成功させる
 */
export function createChromeControl({ relay, os, now = Date.now, record = async () => {}, capture = null, log = () => {} }) {
  const listeners = new Set();
  const last = new Map();      // 会話の id -> 最後に配った状態の印（同じ状態を重ねて配らない）
  const queues = new Map();    // 会話の id -> 操作の順番待ち（同じ会話の引き継ぎ・戻す・止めるを順に流す）

  const errors = new Map();    // 会話の id -> 戻せなかった理由（'conceal-failed'。paused のまま画面へ返す。paused でなくなれば消す）

  function stateOf(sessionId) {
    const s = relay.state(sessionId);
    if (!s) return { sessionId, state: 'idle', since: null, error: null };
    const state = s.paused ? 'paused' : s.stopped ? 'stopped' : s.turn ? 'running' : 'idle';
    return { sessionId, state, since: s.paused?.at ?? null, error: s.paused ? errors.get(sessionId) ?? null : null };
  }
  const mark = state => `${state.state}:${state.since ?? ''}:${state.error ?? ''}`;

  const suspended = new Set();   // 撮影を断っている会話の id（paused の間）
  const safe = (what, fn) => { try { fn(); } catch (error) { log(`chrome-control: ${what} failed: ${error?.message ?? error}`); } };
  /** paused に合わせて撮影を断る・解く。suspend は同期で効く（relay.pause の中から呼ばれる）。中継から消えた会話（削除・付け替え）の分は resume して片付ける */
  function syncCapture(sessionId) {
    if (!capture) return;
    const paused = Boolean(relay.state(sessionId)?.paused);
    if (paused && !suspended.has(sessionId)) { suspended.add(sessionId); safe('suspend', () => capture.suspend(sessionId)); }
    else if (!paused && suspended.has(sessionId)) { suspended.delete(sessionId); safe('resume', () => capture.resume(sessionId)); }
    for (const id of [...suspended]) if (!relay.state(id)) { suspended.delete(id); safe('resume', () => capture.resume(id)); }
  }

  /** 状態を聞き手へ配る（前に配った状態と同じなら配らない） */
  function publish(sessionId) {
    syncCapture(sessionId);
    if (!relay.state(sessionId)?.paused) errors.delete(sessionId);
    const state = stateOf(sessionId);
    if (last.get(sessionId) === mark(state)) return;
    last.set(sessionId, mark(state));
    if (state.state === 'idle' && !relay.state(sessionId)) last.delete(sessionId);
    for (const fn of [...listeners]) { try { fn(state); } catch (error) { log(`chrome-control: listener failed: ${error?.message ?? error}`); } }
  }
  const offChange = relay.onChange(publish);
  for (const id of relay.sessionIds()) syncCapture(id);   // 更新で一時停止のまま引き継がれた会話の撮影を断つ

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
    // 見せられる窓が無ければ、一時停止にしない（一時停止はエージェントの接続を切るので、窓が無いのに切らない）
    if (!relay.scope.windows?.(sessionId).some(window => window.ref)) throw new ChromeControlError('NO_WINDOW', 'no agent browser window to hand over');
    relay.pause(sessionId, now());   // 先に断つ（窓が見える間に、エージェントが操作を続けない。接続も切る）
    // 窓を戻す画面の手がかり（戻すときの前面の返し先にもなる）。Pleiad 自身の窓のある画面。リモートの端末から押したときも、PC の Pleiad の窓（その時の前面ではない）。
    // Pleiad の窓が引けなければ、その時の前面
    const near = await Promise.resolve(os.appWindow?.()).catch(() => null) ?? await Promise.resolve(os.foreground()).catch(() => null);
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
    // 窓を隠してから解く（見えている間は、エージェントのコマンドを通さない）。引き継ぎの間に人が窓を作り替えた（タブを引き離した）分は先に取り込む
    await relay.refreshWindows(sessionId).catch(error => log(`chrome-control: refreshWindows failed: ${error?.message ?? error}`));
    let result = { concealed: 0, failed: 0 };
    try { result = await relay.scope.conceal({ entryId: sessionId, cdp: relay.cdp }); }
    catch (error) { log(`chrome-control: conceal failed: ${error?.message ?? error}`); result = { concealed: 0, failed: 1 }; }
    if (result.failed > 0) {
      // 隠せなかった窓が見えたままなので、解かない（paused のまま）。理由を状態に載せて画面へ返す（もう一度「戻す」を押せる）
      log(`chrome-control: ${result.failed} window(s) could not be hidden, so the pause was kept`);
      errors.set(sessionId, 'conceal-failed');
      publish(sessionId);
      return stateOf(sessionId);
    }
    errors.delete(sessionId);
    const at = relay.unpause(sessionId);
    if (at != null) {
      const seconds = Math.max(0, Math.round((now() - at) / 1000));
      await Promise.resolve(record({ sessionId, seconds })).catch(error => log(`chrome-control: record failed: ${error?.message ?? error}`));
    }
    return stateOf(sessionId);
  }

  async function doStop(sessionId) {
    if (!relay.state(sessionId)) return stateOf(sessionId);
    if (relay.state(sessionId).paused) {
      await doResume(sessionId);   // 窓を戻してから止める
      if (relay.state(sessionId)?.paused) return stateOf(sessionId);   // 窓を隠せなかった。止めずに画面へ返す
    }
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
    close() { offChange(); listeners.clear(); for (const id of [...suspended]) { suspended.delete(id); safe('resume', () => capture?.resume(id)); } },
  };
}
