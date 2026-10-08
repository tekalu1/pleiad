'use strict';
// モニター単位の撮影 → 縮小 → JPEG。BitBlt で写し（win32.captureRect）、Electron の nativeImage で縮めて符号化する。
// 撮影の座標系は物理画素。縮小の倍率は docs/computer-use.md「画像の縮小と座標の戻し」。
const { ComputerError } = require('./errors.cjs');
const { pickDisplay } = require('./displays.cjs');

/** 拡大しない倍率（upscale のときは上限まで拡大もする） */
function fitScale(width, height, { maxPixels, maxEdge, upscale = false }) {
  const limit = Math.min(Math.sqrt(maxPixels / (width * height)), maxEdge / Math.max(width, height));
  return upscale ? limit : Math.min(1, limit);
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** BGRA（Windows の nativeImage の toBitmap）から明るさ（0〜255）へ */
function lumaOf(bgra, count) {
  const out = new Uint8Array(count);
  for (let i = 0, j = 0; i < count && j + 2 < bgra.length; i++, j += 4) out[i] = (bgra[j] * 29 + bgra[j + 1] * 150 + bgra[j + 2] * 77) >> 8;
  return out;
}

function createCapture({ win32, nativeImage }) {
  /**
   * @param {object} args { display, maxPixels, maxEdge, quality, region?, upscale?, gray? }
   * @param {{ displays: object[], displaysVersion: number }} state
   */
  async function screenshot(args, { displays, displaysVersion }) {
    if (!nativeImage) throw new ComputerError('unsupported', 'nativeImage is not available');
    const limits = { maxPixels: args.maxPixels ?? 1_200_000, maxEdge: args.maxEdge ?? 1568, quality: args.quality ?? 75 };
    if (!(limits.maxPixels > 0) || !(limits.maxEdge > 0)) throw new ComputerError('failed', 'maxPixels and maxEdge must be positive');
    const region = args.region;
    if (region && !(['x', 'y', 'width', 'height'].every(k => Number.isFinite(region[k])) && region.width > 0 && region.height > 0)) throw new ComputerError('failed', 'region must be { x, y, width, height }');
    const display = pickDisplay(displays, args.display);
    if (!display) throw new ComputerError('outside', `display ${args.display} does not exist`);
    const wanted = region ? intersect({ x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) }, display.bounds) : display.bounds;
    if (!wanted) throw new ComputerError('outside', 'region is outside the display');
    const raw = await win32.captureRect(wanted);
    // BitBlt の alpha は未定義。0 のままだと JPEG が黒くなるので不透明にする
    if (raw.bgra.byteOffset % 4 === 0) {
      const pixels = new Uint32Array(raw.bgra.buffer, raw.bgra.byteOffset, raw.bgra.byteLength >>> 2);
      for (let i = 0; i < pixels.length; i++) pixels[i] |= 0xff000000;
    } else for (let i = 3; i < raw.bgra.length; i += 4) raw.bgra[i] = 0xff;
    let image = nativeImage.createFromBitmap(raw.bgra, { width: raw.width, height: raw.height });
    const scale = fitScale(raw.width, raw.height, { ...limits, upscale: !!args.upscale });
    let width = raw.width, height = raw.height;
    if (scale !== 1) {
      width = Math.max(1, Math.floor(raw.width * scale)); // 1920×1080 → 1460×821（切り捨てなら上限を超えない）
      height = Math.max(1, Math.floor(raw.height * scale));
      image = image.resize({ width, height, quality: 'best' });
    }
    // gray: wait_until が前のコマと比べる小さい灰色の画素（1 画素 1 バイト。core/computer-use/settle.mjs）。JPEG は作らない
    if (args.gray) return { gray: lumaOf(image.toBitmap(), width * height), width, height, scale: width / raw.width, origin: { x: wanted.x, y: wanted.y }, displaysVersion };
    const jpeg = image.toJPEG(Math.min(100, Math.max(1, Math.round(limits.quality))));
    return {
      jpeg: new Uint8Array(jpeg), width, height, scale: width / raw.width,
      origin: { x: wanted.x, y: wanted.y }, displaysVersion,
    };
  }
  return { screenshot };
}

module.exports = { createCapture, fitScale, lumaOf };
