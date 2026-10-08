// 端末からの入力（押す・スクロール・文字・キー）を CDP の Input.* のコマンドの列にする。
// 内蔵ブラウザーの映像（desktop/browser-screencast.cjs）と、端末から操作する PC の Chrome の窓（core/chrome/screencast.mjs）が同じ変換を使う。

export const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 端末からの入力を CDP のコマンドの列にする。座標はページの CSS px（端末が表示の倍率から変換済み）。知らない入力は空 */
export function inputCommands(input, { width = 1600, height = 2400 } = {}) {
  if (!input || typeof input !== 'object') return [];
  const x = clamp(input.x, 0, width, 0), y = clamp(input.y, 0, height, 0);
  switch (input.type) {
    case 'tap': return [
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }],
    ];
    case 'scroll': {
      const deltaX = clamp(input.dx, -4000, 4000, 0), deltaY = clamp(input.dy, -4000, 4000, 0);
      if (!deltaX && !deltaY) return [];
      return [['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }]];
    }
    case 'text': {
      if (typeof input.text !== 'string' || !input.text || input.text.length > 2000) return [];
      return [['Input.insertText', { text: input.text }]];
    }
    case 'key': {
      const key = KEYS[input.key];
      if (!key) return [];
      const base = { key: input.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
      return [
        ['Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) }],
        ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
      ];
    }
    default: return [];
  }
}

/** 端末の映像の箱の大きさ（CSS px と倍率）を、ページの大きさに使ってよい範囲に丸める。数でなければ null */
export function deviceViewport({ width, height, scale } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.round(clamp(width, 240, 1600, 390)),
    height: Math.round(clamp(height, 240, 2400, 700)),
    scale: clamp(scale, 1, 3, 1),
  };
}

/** 端末に合わせるページの大きさのコマンド（Emulation.setDeviceMetricsOverride の引数） */
export const deviceMetrics = viewport => ({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: true });
