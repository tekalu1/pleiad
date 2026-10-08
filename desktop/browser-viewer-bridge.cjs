// worker（core/browser-viewer.mjs の parentPortViewer）との口。内蔵ブラウザー（ビューア）が持つ物だけ（エージェントの操作は PC の Chrome。core/chrome/）:
//   - 読み込みの方針: main <- worker browser-load-policy { confirm, origins }（起動時に browser-load-policy-request で引く。ADR 0079）
//   - タブの写し（無停止の更新。AGENT_HOST_HANDOVER=on の名前付きパイプの経路。docs/zero-downtime-update/design.md §7.2）:
//       main -> worker: browser-state-report { tabs }（タブの写し。変わったときに 1 秒ほどまとめて）・browser-restore-request（付け直した main が起動で 1 回）
//       worker -> main: browser-restore { tabs }（サーバーが持つ前の main の写し）
//     切り替え（desktop/switch.cjs）で新しいサーバー（S2）に替わったときは、S2 は写しを持たずに空から始まり、報告は中身が変わらないと送らない。
//     そこで、つなぎ直したサーバーが送る ready（つながるたびに届く）で、写しを 1 回送り直す。
function attachBrowserViewerBridge(worker, panel, { handover = false, reportMs = 1000, restoreWaitMs = 5000 } = {}) {
  // 写しの報告（handover のときだけ）。付け直しの答え（browser-restore）が届くまでは報告しない（空の状態でサーバーの写しを上書きしない）
  let reportsOn = false, restored = false, lastReport = '', reportTimer = null, restoreTimer = null;
  const report = () => {
    reportTimer = null;
    if (!handover || !reportsOn) return;
    let state;
    try { state = panel.exportState?.(); } catch { return; }
    const key = state && JSON.stringify(state);
    if (!key || key === lastReport) return;
    lastReport = key;
    worker.postMessage({ type: 'browser-state-report', ...state });
  };
  // つなぎ直したサーバーへ、写しを送り直す（上の注記）。復元が済む前の ready は、復元の流れが報告を始めるので何もしない
  const resend = () => {
    if (!handover || !reportsOn) return;
    clearTimeout(reportTimer); reportTimer = null;
    let state;
    try { state = panel.exportState?.(); } catch { return; }
    if (!state) return;
    lastReport = JSON.stringify(state);
    worker.postMessage({ type: 'browser-state-report', ...state });
  };
  const scheduleReport = () => { if (handover && reportsOn && !reportTimer) reportTimer = setTimeout(report, reportMs); };
  const offState = handover ? panel.onStateChanged?.(scheduleReport) : null;
  function restore(message) {
    if (!restored) {
      restored = true;
      try { panel.restoreState?.({ tabs: message.tabs }); } catch { /* 開き直せない分は戻さない */ }
    }
    reportsOn = true;
    scheduleReport();
  }
  worker.on('message', message => {
    if (message?.type === 'browser-restore') { restore(message); return; }
    if (message?.type === 'ready') { resend(); return; }
    if (message?.type === 'browser-load-policy') panel.setLoadPolicy?.({ confirm: message.confirm === true, origins: message.origins });
  });
  worker.postMessage({ type: 'browser-load-policy-request' });
  if (handover) {
    // 答えが無い（古いサーバー）ときも、待ちの後に報告は始める
    worker.postMessage({ type: 'browser-restore-request' });
    restoreTimer = setTimeout(() => { reportsOn = true; scheduleReport(); }, restoreWaitMs);
    restoreTimer.unref?.();
  }
  return {
    close() {
      // 終わる前に最後の写しを渡す（更新のための終了では、サーバーが次の main に渡す）
      clearTimeout(restoreTimer); clearTimeout(reportTimer);
      report();
      offState?.();
    },
  };
}
module.exports = { attachBrowserViewerBridge };
