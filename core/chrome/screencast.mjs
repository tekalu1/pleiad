// エージェントの Chrome の窓の映像（docs/inapp-browser.md「リモートから見る」、ADR 0148「右パネルは見るだけの映像」・ADR 0154）。
//
// 会話の範囲の「今のタブ」（エージェントが最後にコマンドを送ったタブ。無ければ窓の最初のタブ。core/chrome/relay.mjs の view.current）に、
// 中継自身のセッション（エージェントのものとは別）を付け、タブの focus emulation を保たせて（host.focus）Page.startScreencast を回す。
//   - 見る人がいる間だけ付け、いなくなったら（stop）止めて focus emulation の理由（relay の view.focus）も手放す。focus emulation 自体は relay が 1 タブ 1 セッションで持ち、
//     ターンの間と映像を見ている間の両方が無くなったときだけ Chrome から外す（Chrome は 1 つのセッションが外すとほかが有効にしていても外れるため。ADR 0154 の実機）
//   - 今のタブが替わったら（エージェントが別のタブに触れた・タブが閉じた）付け替える
//   - 撮影を断つ口: suspend(sessionId[, windowId]) / resume。断っている間は screencast を止め（フレームを撮らない・流さない）、focus emulation も外す。
//     第 6 段の「あなたが操作中」が呼ぶ。状態に { suspended: true } を載せて見る側に知らせる。
//     **suspend と resume は呼ぶ側が対にする**（断りは会話の寿命と結ぶ: 会話を消す・Chrome の接続が切れると消え、id が替わると新しい id へ付け替える。
//     windowId なしの resume は、その会話の窓ごとの断りも全部外す）。suspend は呼んだ時に同期で効く（順番待ちの中の付け替え・開始の途中でもフレームを流さない）
//   - 人が映すウィンドウを選べる（pin(sessionId, windowId)。右パネルの番号チップ）。固定の間は、エージェントがほかのウィンドウに移っても映像は動かず、
//     固定したウィンドウの中の今のタブ（無ければ最初のタブ）を映す。解くのは pin(sessionId, null)・固定したウィンドウが消えたとき・映像の見張りが終わったとき（パネルを閉じる・会話を消す・Chrome の接続が切れる）。
//     固定は会話に 1 つ（端末ごとではない）。エージェントの操作の宛先には影響しない。変化は onPin で知らせる
//   - focus emulation の理由は、映像の見張り（watch）ごとの札で数える（relay の view.focus の owner）。閉じてすぐ開き直しても、古い見張りの「手放す」が新しい見張りの理由を消さない
// core/browser-screencast.mjs の createScreencastHub の bridge の形（ready・request・ack・onFrame・onState・onEnded・onAway）で使う。
// 見る側の入力（タップ・文字・移動）は受けない（見るだけ）。URL・題は状態に載せない。
// ただし端末が引き継いでいる間（第 7 段の by: 'device'。operate(sessionId, viewport)）だけは、映像のセッション（エージェントの接続ではない）で入力を送り、
// ページの大きさを端末の映像の箱に合わせる（Emulation.setDeviceMetricsOverride。operate(sessionId, null) で clearDeviceMetricsOverride）。
import { inputCommands, deviceMetrics } from './input.mjs';

const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 端末の表示の大きさ・倍率・画質を、送ってよい範囲に丸める（フレームの最大の大きさ = 表示の大きさ × 倍率） */
export function chromeScreencastSettings({ width, height, scale, quality } = {}) {
  const s = clamp(scale, 1, 2, 1);
  return {
    quality: Math.round(clamp(quality, 20, 80, 50)),
    maxWidth: Math.round(clamp(Number(width) * s, 200, 1920, 800)),
    maxHeight: Math.round(clamp(Number(height) * s, 200, 1920, 800)),
  };
}

/**
 * @param {object} deps
 * @param deps.host  core/chrome/relay.mjs の view（onChange・summary・tabs・current・attach）
 */
export function createChromeScreencast({ host, log = () => {} } = {}) {
  const watches = new Map();   // 会話の id -> { settings, view, tabId, generation, queue, suspended: boolean, announced: boolean（端末へ知らせた suspended）, pinned: 固定したウィンドウの id か null }
  const lastFrames = new Map(); // 人が窓を直接閉じたときの最後の映像（JPEG）。一時停止中も更新しない
  const suspended = new Set(); // 'sessionId' か 'sessionId#windowId'
  const operated = new Map();  // 会話の id -> 端末の映像の箱（{ width, height, scale }。端末が引き継いでいる間）
  const listeners = { frame: new Set(), state: new Set(), ended: new Set(), away: new Set(), pin: new Set() };
  const emit = (kind, ...args) => { for (const fn of [...listeners[kind]]) { try { fn(...args); } catch { /* 聞き手の失敗は映像を壊さない */ } } };

  const isSuspended = (sessionId, windowId = null) => suspended.has(sessionId) || (windowId != null && suspended.has(`${sessionId}#${windowId}`));
  const windowOf = (sessionId, tabId) => (tabId ? host.tabs(sessionId).find(tab => tab.targetId === tabId)?.windowId ?? null : null);
  const keysOf = sessionId => [...suspended].filter(key => key === sessionId || key.startsWith(`${sessionId}#`));
  /** 会話の断りを全部消す（会話を消した・Chrome の接続が切れた） */
  const dropSuspension = sessionId => { for (const key of keysOf(sessionId)) suspended.delete(key); };
  /** 会話の id が替わった: 断りも新しい id へ付け替える */
  const moveSuspension = (from, to) => { for (const key of keysOf(from)) { suspended.delete(key); suspended.add(`${to}${key.slice(from.length)}`); } };

  function stateOf(sessionId, watch) {
    const summary = host.summary(sessionId);
    return { tabId: watch.tabId ?? null, agent: summary.operating, suspended: watch.suspended, tabs: summary.tabs, pinnedWindowId: watch.pinned ?? null };
  }
  /** 固定を変える。変わったときだけ聞き手（chromeWindow の配信）へ知らせる */
  function setPin(sessionId, watch, windowId) {
    const next = windowId ?? null;
    if ((watch.pinned ?? null) === next) return false;
    watch.pinned = next;
    emit('pin', sessionId, next);
    return true;
  }
  /** 映すタブを決める: 固定したウィンドウがあればその中（今のタブがそこにあればそれ、無ければ最初のタブ）、無ければ今のタブ。固定したウィンドウが消えていれば固定を解く */
  function targetOf(sessionId, watch) {
    const current = host.current(sessionId);
    if (watch.pinned == null) return current;
    const inWindow = host.tabs(sessionId).filter(tab => tab.windowId === watch.pinned);
    if (!inWindow.length) { setPin(sessionId, watch, null); return current; }
    return (inWindow.find(tab => tab.targetId === current) ?? inWindow[0]).targetId;
  }
  const pushState = (sessionId, watch) => {
    if (watches.get(sessionId) !== watch) return;
    watch.announced = watch.suspended;   // 端末へ知らせた断りの状態（suspend が同期で立てた分も、follow が知らせる）
    emit('state', sessionId, stateOf(sessionId, watch));
  };

  /** 映像のセッションを外す（screencast を止め、focus emulation を外してから detach） */
  async function release(watch, sessionId) {
    const { view, tabId, metrics } = watch;
    watch.view = null; watch.tabId = null; watch.generation += 1; watch.metrics = false;
    if (!view) return;
    await view.send('Page.stopScreencast').catch(() => {});
    if (metrics) await view.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await view.detach().catch(() => {});
    await host.focus(sessionId, tabId, false, watch).catch(() => {});   // ターンの間・ほかの見張りがいれば、その分は残る
  }

  async function attachTo(sessionId, watch, targetId) {
    const generation = ++watch.generation;
    const view = await host.attach(sessionId, targetId, (method, params) => onViewEvent(sessionId, watch, generation, method, params));
    if (watches.get(sessionId) !== watch || watch.generation !== generation) { await view.detach().catch(() => {}); return; }   // 待つ間に止められた・付け替えられた
    watch.view = view; watch.tabId = targetId;
    try {
      await host.focus(sessionId, targetId, true, watch);
      if (operated.has(sessionId)) { await view.send('Emulation.setDeviceMetricsOverride', deviceMetrics(operated.get(sessionId))); watch.metrics = true; }
      await view.send('Page.startScreencast', { format: 'jpeg', quality: watch.settings.quality, maxWidth: watch.settings.maxWidth, maxHeight: watch.settings.maxHeight, everyNthFrame: 1 });
    } catch (error) {
      if (watch.view === view) { watch.view = null; watch.tabId = null; watch.metrics = false; }
      await view.detach().catch(() => {});
      await host.focus(sessionId, targetId, false, watch).catch(() => {});
      throw error;
    }
  }

  function onViewEvent(sessionId, watch, generation, method, params) {
    if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
    if (method === 'Page.screencastFrame') {
      // 撮影を断っている間は流さない（順番待ちの外でも、断りの鍵を直に見る）
      if (watch.suspended || isSuspended(sessionId, windowOf(sessionId, watch.tabId)) || typeof params.data !== 'string') return;
      const m = params.metadata ?? {};
      lastFrames.set(sessionId, params.data);
      emit('frame', sessionId, { id: params.sessionId, data: params.data,
        metadata: { deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, pageScaleFactor: m.pageScaleFactor, offsetTop: m.offsetTop, scrollOffsetX: m.scrollOffsetX, scrollOffsetY: m.scrollOffsetY } });
    } else if (method === 'Target.detachedFromTarget') {
      // Chrome の側で外れた（タブが閉じた・移った）。このタブの映像の理由を手放してから、タブが残っていれば付け直す（付け直せばまた理由を持つ）
      const gone = watch.tabId;
      watch.view = null; watch.tabId = null; watch.generation += 1;
      if (gone) host.focus(sessionId, gone, false, watch).catch(() => {});
      follow(sessionId, watch).catch(() => {});
    }
  }

  /** 今のタブ（と撮影を断つかどうか）に映像のセッションを合わせる。同じ会話の呼び出しは順に流す */
  function follow(sessionId, watch) {
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch) return;
      const targetId = targetOf(sessionId, watch);
      const windowId = targetId ? host.tabs(sessionId).find(tab => tab.targetId === targetId)?.windowId ?? null : null;
      const hold = isSuspended(sessionId, windowId);
      const changed = hold !== watch.announced;
      watch.suspended = hold;
      if (!targetId) { await release(watch, sessionId); pushState(sessionId, watch); return; }   // 窓が無い間は待つ（タブが増えたら付く）
      if (hold) { await release(watch, sessionId); if (changed) pushState(sessionId, watch); return; }
      if (watch.view && watch.tabId === targetId) { if (changed) pushState(sessionId, watch); return; }
      await release(watch, sessionId);
      await attachTo(sessionId, watch, targetId);
      pushState(sessionId, watch);
    });
    watch.queue = run.catch(() => {});
    return run;
  }

  function end(sessionId, reason) {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    setPin(sessionId, watch, null);
    release(watch, sessionId).catch(() => {});
    emit('ended', sessionId, reason);
  }

  const off = host.onChange((sessionId, kind, extra) => {
    if (kind === 'reset' || kind === 'forget') { lastFrames.delete(sessionId); dropSuspension(sessionId); operated.delete(sessionId); end(sessionId, 'closed'); return; }
    if (kind === 'rebind') {
      if (lastFrames.has(extra)) { lastFrames.set(sessionId, lastFrames.get(extra)); lastFrames.delete(extra); }
      moveSuspension(extra, sessionId);
      if (operated.has(extra)) { operated.set(sessionId, operated.get(extra)); operated.delete(extra); }
      end(extra, 'closed');
      return;
    }
    const watch = watches.get(sessionId);
    if (!watch) return;
    if (kind === 'operating') { pushState(sessionId, watch); return; }
    // tabs / current。窓のタブが 1 つも無くなったら、映像の持ち主（窓）が消えた
    if (!host.summary(sessionId).tabs) { end(sessionId, 'closed'); return; }
    follow(sessionId, watch).catch(error => { log(`chrome-screencast: follow failed: ${error?.message ?? error}`); });
  });

  async function start(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
    if (!host.summary(sessionId).tabs) throw new Error('no-window');
    const settings = chromeScreencastSettings(options);
    let watch = watches.get(sessionId);
    if (watch) {
      watch.settings = settings;
      // 大きさ・画質が替わった: 付け直さずに screencast だけかけ直す
      if (watch.view) {
        const view = watch.view;
        await view.send('Page.stopScreencast').catch(() => {});
        await view.send('Page.startScreencast', { format: 'jpeg', quality: settings.quality, maxWidth: settings.maxWidth, maxHeight: settings.maxHeight, everyNthFrame: 1 }).catch(() => {});
      }
    } else {
      watch = { settings, view: null, tabId: null, generation: 0, queue: Promise.resolve(), suspended: false, announced: false, metrics: false, pinned: null };
      watches.set(sessionId, watch);
    }
    try { await follow(sessionId, watch); }
    catch (error) { if (watches.get(sessionId) === watch) { watches.delete(sessionId); await release(watch, sessionId); } throw error; }
    return { tabId: watch.tabId, state: stateOf(sessionId, watch) };
  }

  async function stop(sessionId) {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    setPin(sessionId, watch, null);
    await watch.queue;
    await release(watch, sessionId);
  }

  /** 映すウィンドウを固定する（windowId）・解いて今のタブを追う（null）。映像の見張りが無い間は固定しない */
  async function pin(sessionId, windowId) {
    const watch = watches.get(sessionId);
    if (!watch) throw new Error('not-watching');
    if (watch.suspended || operated.has(sessionId)) throw new Error('operating');   // 引き継いでいる間は切り替えない
    if (windowId != null && !host.tabs(sessionId).some(tab => tab.windowId === windowId)) throw new Error('no-window');
    const changed = setPin(sessionId, watch, windowId);
    await follow(sessionId, watch);
    if (changed) pushState(sessionId, watch);
    return { pinnedWindowId: watch.pinned ?? null, state: stateOf(sessionId, watch) };
  }

  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  return {
    ready: true,
    async request(action, sessionId, args = {}) {
      switch (action) {
        case 'start': return start(sessionId, args.options ?? {});
        case 'stop': await stop(sessionId); return {};
        case 'pin': return pin(sessionId, args.windowId ?? null);
        case 'input': return input(sessionId, args.input);
        default: throw new Error('view-only');   // 移動・エージェントの操作は受けない。入力も端末が引き継いでいる間だけ
      }
    },
    ack(sessionId, frameId) {
      const view = watches.get(sessionId)?.view;
      if (view && Number.isInteger(frameId)) view.send('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {});
    },
    onFrame: on('frame'), onState: on('state'), onEnded: on('ended'), onAway: on('away'),
    /** 固定の変化（sessionId, windowId|null）。chromeWindow の配信が聞く */
    onPin: on('pin'),
    /** 今固定しているウィンドウの id（無ければ null） */
    pinned: sessionId => watches.get(sessionId)?.pinned ?? null,

    /**
     * 撮影を断つ（第 6 段の「あなたが操作中」）。windowId があればその窓が今のタブの窓のときだけ、無ければ会話の窓すべて。
     * 断っている間は screencast を止めて focus emulation も外し、フレームを流さない。見ている端末には state.suspended を送る
     */
    suspend(sessionId, windowId = null) {
      suspended.add(windowId == null ? sessionId : `${sessionId}#${windowId}`);
      const watch = watches.get(sessionId);
      if (watch && isSuspended(sessionId, windowOf(sessionId, watch.tabId))) watch.suspended = true;   // 順番待ちを待たずに、今から流さない
      return refollow(sessionId);
    },
    resume(sessionId, windowId = null) {
      if (windowId == null) dropSuspension(sessionId); else suspended.delete(`${sessionId}#${windowId}`);
      return refollow(sessionId);
    },
    isSuspended,
    /**
     * 端末が引き継いだ（viewport = { width, height, scale }）・戻した（null）。引き継いでいる間だけ入力を通し、ページの大きさを端末に合わせる。
     * 映像のセッションが付いていなければ、付いたとき（start・付け替え）に合わせる
     */
    operate(sessionId, viewport) {
      if (viewport) operated.set(sessionId, viewport); else operated.delete(sessionId);
      const watch = watches.get(sessionId);
      if (!watch) return Promise.resolve();
      const run = watch.queue.then(async () => {
        const view = watch.view;
        if (!view) return;
        if (viewport) { await view.send('Emulation.setDeviceMetricsOverride', deviceMetrics(viewport)); watch.metrics = true; }
        else if (watch.metrics) { watch.metrics = false; await view.send('Emulation.clearDeviceMetricsOverride'); }
      });
      watch.queue = run.catch(() => {});
      return run.catch(error => log(`chrome-screencast: metrics failed: ${error?.message ?? error}`));
    },
    operating: sessionId => operated.has(sessionId),
    watching: () => [...watches.keys()],
    lastFrame(sessionId) { return lastFrames.get(sessionId) ?? null; },
    forgetFrame(sessionId) { lastFrames.delete(sessionId); },
    close() { off(); lastFrames.clear(); for (const sessionId of [...watches.keys()]) end(sessionId, 'closed'); },
  };

  /** 端末からの入力を、映像のセッションで今のタブへ送る（端末が引き継いでいる間だけ） */
  async function input(sessionId, value) {
    const viewport = operated.get(sessionId);
    if (!viewport) throw new Error('view-only');
    const view = watches.get(sessionId)?.view;
    if (!view) throw new Error('not-watching');
    const commands = inputCommands(value, viewport);
    if (!commands.length) throw new Error('invalid-input');
    for (const [method, params] of commands) await view.send(method, params);
    return {};
  }

  function refollow(sessionId) {
    const watch = watches.get(sessionId);
    return watch ? follow(sessionId, watch).catch(() => {}) : Promise.resolve();
  }
}
