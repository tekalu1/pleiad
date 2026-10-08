import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';
import fs from 'node:fs';

export const name = 'chrome-panel-lifecycle';
export const title = '右パネル「Chrome の窓」の見始め: 窓がまだ無い会話で開く・窓が閉じて新しい窓ができたら映像が戻る（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function rig({ remote = false } = {}) {
  const commands = [];
  const windows = createWindowTable();
  let panelOpen = false;
  const preview = { openPanel: () => { panelOpen = true; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } };
  const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: { suspended: false } } : {}; },
    preview, browser: remote ? null : {}, session: () => 'conv', windows });
  const starts = () => commands.filter(([name]) => name === 'browserScreencast').length;
  const frame = seq => panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'frame', seq, data: 'AAAA', metadata: { deviceWidth: 390, deviceHeight: 700 } });
  return { panel, windows, commands, starts, frame };
}

export default async function (t) {
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window, perf: globalThis.performance };
  globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
  N.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 });
  N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
  globalThis.window = { innerHeight: 800, devicePixelRatio: 1 };
  try {
    // 窓がまだ無い会話で開く → 窓ができたら見始める
    {
      const r = rig();
      r.panel.open();
      await flush();
      t.ok('窓が無い会話で開いても、映像は始めず「接続中」のままにしない', r.starts() === 0);
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.windowEvent({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      await flush();
      t.ok('後から窓ができたら、見始める', r.starts() === 1);
    }

    // 見ている間に窓が閉じ、新しい窓ができる → 映像が戻る
    {
      const r = rig();
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      r.frame(1);
      t.ok('窓があれば開いて見始める', r.starts() === 1);
      r.windows.apply({ sessionId: 'conv', windows: 0 });
      r.panel.windowEvent({ sessionId: 'conv', windows: 0 });
      r.panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'ended' });
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [9], currentWindowId: 9 });
      r.panel.windowEvent({ sessionId: 'conv', windows: 1, windowIds: [9], currentWindowId: 9 });
      await flush();
      t.ok('窓が閉じて新しい窓ができたら、古いフレームが残っていても見直す', r.starts() === 2);
      r.frame(2);
      r.windows.apply({ sessionId: 'conv', windows: 2, windowIds: [9, 10], currentWindowId: 9 });
      r.panel.windowEvent({ sessionId: 'conv', windows: 2, windowIds: [9, 10], currentWindowId: 9 });
      await flush();
      t.ok('映像が流れている間の窓の数の変化では、見直さない', r.starts() === 2);
    }

    // 選んでいるタブをもう一度押しても、見ている映像を最初からにしない
    {
      const r = rig();
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      r.frame(1);
      r.panel.open();
      await flush();
      t.ok('開いて映像が流れているときの open は、見直さない（映像が最初からにならない）', r.starts() === 1);
      r.panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'ended' });
      r.panel.open();
      await flush();
      t.ok('映像が止まったあとの open は、見直す', r.starts() === 2);
    }

    // ビューアの無い端末（リモート）: 窓が無くなると入口のボタンが消えるので、パネルも閉じる
    {
      const r = rig({ remote: true });
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      r.frame(1);
      r.panel.windowEvent({ sessionId: 'conv', windows: 0 });
      t.ok('リモートでは、窓が閉じるとパネルも閉じる', r.panel.isOpen() === false);
    }
    {
      const r = rig();
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      r.frame(1);
      r.panel.windowEvent({ sessionId: 'conv', windows: 0 });
      t.ok('ホスト（ビューアのある画面）では、固定タブなのでパネルは残り、閉じた表示になる', r.panel.isOpen() === true);
    }

    // 狭いパネルで「止める」「引き継ぐ」を切らない: 折り返せる（nowrap + overflow:hidden で切っていた）
    {
      const css = fs.readFileSync(new URL('../../web/chrome-panel.css', import.meta.url), 'utf8');
      const rule = css.match(/\.cp-slot \.cc\{([^}]*)\}/)?.[1] ?? '';
      t.ok('状態の一行は狭いパネルで折り返せ、切らない', /flex-wrap:\s*wrap/.test(rule) && !/overflow:\s*hidden/.test(rule), rule);
    }
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle;
    if (old.window === undefined) delete globalThis.window; else globalThis.window = old.window;
  }
}
