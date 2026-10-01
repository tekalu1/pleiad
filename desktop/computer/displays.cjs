'use strict';
// モニターの一覧（物理画素の仮想デスクトップ座標）。index は 1 から数えてモデルに見せる番号。
// 主モニターを 1 にし、残りは左から右・上から下。id は GDI のデバイス名（`\.\DISPLAY1`）。

function listDisplays(win32) {
  const monitors = win32.monitors();
  const ordered = [...monitors].sort((a, b) => (b.primary - a.primary) || (a.x - b.x) || (a.y - b.y));
  return ordered.map((m, i) => ({
    id: m.device || `monitor-${m.handle}`,
    index: i + 1,
    bounds: { x: m.x, y: m.y, width: m.width, height: m.height },
    scale: Math.round((m.dpi / 96) * 10000) / 10000,
    primary: !!m.primary,
  }));
}

/** 全モニターを囲む矩形（SendInput の VIRTUALDESK の基準） */
function virtualBounds(displays) {
  if (!displays.length) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...displays.map(d => d.bounds.x));
  const top = Math.min(...displays.map(d => d.bounds.y));
  const right = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const containsPoint = (displays, x, y) => displays.some(d => x >= d.bounds.x && y >= d.bounds.y && x < d.bounds.x + d.bounds.width && y < d.bounds.y + d.bounds.height);

/** 検査用の署名。変わったら座標の基準が変わったとみなす */
const signature = displays => JSON.stringify(displays.map(d => [d.id, d.bounds, d.scale, d.primary]));

/** args.display（1 からの番号。文字列なら id）で選ぶ。無ければ主モニター */
function pickDisplay(displays, ref) {
  if (ref === undefined || ref === null) return displays.find(d => d.primary) ?? displays[0] ?? null;
  if (typeof ref === 'number') return displays.find(d => d.index === ref) ?? null;
  return displays.find(d => d.id === ref) ?? null;
}

module.exports = { listDisplays, virtualBounds, containsPoint, signature, pickDisplay };
