// worker（core/server.mjs）からの「PC のブラウザーで見る」の依頼を desktop/browser-screencast.cjs へ渡す橋
// （docs/inapp-browser.md「リモートから見る」）。desktop/browser-viewer-bridge.cjs と同じく parentPort の message でつなぐ。
//   worker -> main: { type: 'browser-screencast', id, action: start|stop|input|navigate, sessionId, ... } と
//                   { type: 'browser-screencast-ack', sessionId, frameId }（worker が間引いて送る）
//   main -> worker: 応答 { type: 'browser-screencast', id, ok, result|error }、フレーム・状態・終わり、使えることの知らせ（ready）
const { createBrowserScreencast } = require('./browser-screencast.cjs');

function attachBrowserScreencastBridge(worker, panel, { keepVisible = () => () => {} } = {}) {
  const post = message => {
    try { worker.postMessage(message); } catch {}
    if (message.type === 'browser-screencast-ended') queueMicrotask(sync);
  };
  const screencast = createBrowserScreencast(panel, { post });
  // 窓が隠れている（常駐で閉じた）間は描かれないので、見られている間だけ最小化で出す
  let release = null;
  const sync = () => {
    if (screencast.watching().length) { if (!release) release = keepVisible(); }
    else if (release) { release(); release = null; }
  };
  worker.on('message', async message => {
    if (message?.type === 'browser-screencast-ack') { screencast.ack(message.sessionId, message.frameId); return; }
    if (message?.type !== 'browser-screencast') return;
    const { id, action, sessionId } = message;
    try {
      let result = {};
      switch (action) {
        case 'start': result = await screencast.start(sessionId, message.options ?? {}); break;
        case 'stop': await screencast.stop(sessionId); break;
        case 'input': await screencast.input(sessionId, message.input); break;
        case 'navigate': await screencast.navigate(sessionId, message.nav, message.url); break;
        default: throw new Error('unknown action');
      }
      post({ type: 'browser-screencast', id, ok: true, result });
    } catch (error) {
      post({ type: 'browser-screencast', id, ok: false, error: error.message });
    } finally { sync(); }
  });
  post({ type: 'browser-screencast-ready' });
  return { close() { screencast.close(); sync(); } };
}

module.exports = { attachBrowserScreencastBridge };
