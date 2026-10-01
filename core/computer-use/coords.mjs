// 画像の座標と物理座標（仮想デスクトップの画素）の写像（docs/computer-use.md「画像の縮小と座標の戻し」）。
// 考え方は sshh12/windows-computer-use-mcp の coords.py（MIT）に倣った。モデルには掛け算をさせず、ここで戻す。

/** 撮影の上限（定数。設定には出さない） */
export const SHOT_LIMITS = Object.freeze({ maxPixels: 1_200_000, maxEdge: 1568, quality: 75 });

/** 物理の幅・高さから、画像にするときの倍率（画像の画素 / 物理画素）。拡大はしない */
export function fitScale(width, height, { maxPixels = SHOT_LIMITS.maxPixels, maxEdge = SHOT_LIMITS.maxEdge } = {}) {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(1, Math.sqrt(maxPixels / (width * height)), maxEdge / Math.max(width, height));
}

const finite = n => typeof n === 'number' && Number.isFinite(n);

/**
 * 最後の撮影（shot: { scale, origin, width, height }）の画像の座標を物理座標へ。画像の外は丸めずに null。
 * 範囲は [0, width) × [0, height)
 */
export function toPhysical(shot, x, y) {
  if (!shot || !finite(x) || !finite(y)) return null;
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) return null;
  return { x: shot.origin.x + Math.round(x / shot.scale), y: shot.origin.y + Math.round(y / shot.scale) };
}

/** 物理座標を最後の撮影の画像の座標へ（範囲の外でもそのまま返す。外かどうかは inShot で見る） */
export function toImage(shot, px, py) {
  return { x: Math.round((px - shot.origin.x) * shot.scale), y: Math.round((py - shot.origin.y) * shot.scale) };
}

/** 画像の座標が撮影の範囲に入るか */
export const inShot = (shot, x, y) => x >= 0 && y >= 0 && x < shot.width && y < shot.height;

/**
 * zoom の範囲 [x0, y0, x1, y1]（最後の撮影の座標）を物理の { x, y, width, height } へ。不正・範囲外は null。
 * 端は含める（x1・y1 は画像の幅・高さまで）
 */
export function regionToPhysical(shot, region) {
  if (!shot || !Array.isArray(region) || region.length !== 4 || !region.every(finite)) return null;
  const [x0, y0, x1, y1] = region;
  if (x0 < 0 || y0 < 0 || x1 > shot.width || y1 > shot.height || x1 <= x0 || y1 <= y0) return null;
  const a = { x: shot.origin.x + Math.round(x0 / shot.scale), y: shot.origin.y + Math.round(y0 / shot.scale) };
  const b = { x: shot.origin.x + Math.round(x1 / shot.scale), y: shot.origin.y + Math.round(y1 / shot.scale) };
  const width = b.x - a.x, height = b.y - a.y;
  return width > 0 && height > 0 ? { x: a.x, y: a.y, width, height } : null;
}

/** 物理の点を含むディスプレイ（displays: [{ id, index, bounds }]）。無ければ null */
export function displayAt(displays, px, py) {
  return (displays ?? []).find(d => px >= d.bounds.x && py >= d.bounds.y && px < d.bounds.x + d.bounds.width && py < d.bounds.y + d.bounds.height) ?? null;
}
