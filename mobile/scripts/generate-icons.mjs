#!/usr/bin/env node
// モバイル版のアイコンとスプラッシュを、正本の SVG（web/favicon.svg・web/brand/pleiad-icon.svg）から全サイズ書き出す。
// 依存なし（Node の組み込みだけ。SVG のパスを自前で塗り、zlib で PNG にする）。形の決まりは docs/android-releases.md「アイコンとスプラッシュ」。
//
//   node mobile/scripts/generate-icons.mjs            書き出す
//   node mobile/scripts/generate-icons.mjs --check    コミット済みの PNG が今の SVG から出る画素と一致するかだけ見る（書かない）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = path.join(ROOT, 'mobile/android/app/src/main/res')
const XCASSETS = path.join(ROOT, 'mobile/ios/App/App/Assets.xcassets')
const PLAY_ICON = path.join(ROOT, 'docs/play-store/icon-512.png')

// ---- 正本 -----------------------------------------------------------------------------------
// 完成形（青い地＋白い印）は web/favicon.svg、印のパスと線画の色は web/brand/pleiad-icon.svg。2 つのパスが違えば止める。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const faviconSvg = read('web/favicon.svg')
const brandSvg = read('web/brand/pleiad-icon.svg')
const pathsOf = (svg) => [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => ({
  d: /\sd="([^"]+)"/.exec(m[0])[1],
  fill: /\sfill="([^"]+)"/.exec(m[0])[1],
}))
const FAV = pathsOf(faviconSvg)
const BRAND = pathsOf(brandSvg)
if (FAV.length !== 3 || BRAND.length !== 3 || FAV.some((p, i) => p.d !== BRAND[i].d)) {
  throw new Error('web/favicon.svg と web/brand/pleiad-icon.svg の印のパスが一致しません。正本を揃えてから実行してください')
}
const hex = (s) => {
  const m = /^#([0-9a-f]{6})$/i.exec(s)
  if (!m) throw new Error(`色を読めません: ${s}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const varFallback = (fill) => hex(/#[0-9a-fA-F]{6}/.exec(fill)[0]) // var(--ink, #1c2247) → #1c2247
const GROUND = hex(/<rect\b[^>]*\sfill="([^"]+)"/.exec(faviconSvg)[1]) // 地 #3a499e
const MARK_COLORS = FAV.map((p) => hex(p.fill)) // 本体・折り目・尾 = 白・#dfe3f2・白
const SPLASH_LIGHT = { ground: [255, 255, 255], marks: BRAND.map((p) => varFallback(p.fill)) } // #1c2247・#3a499e・#3a499e
// 暗い版の色は web/tokens.css の暗いテーマ（--surface-paper・--ink・--ink-blue）と同じ
const SPLASH_DARK = { ground: hex('#1b1c23'), marks: [hex('#dfe3f2'), hex('#9eabde'), hex('#9eabde')] }
const FOLD_MONO_ALPHA = 0.55 // テーマアイコン: 折り目だけ薄く残す

// ---- パス → 多角形 ---------------------------------------------------------------------------
function flatten(d, steps = 40) {
  const toks = d.match(/[MLHVCZ]|-?\d+(?:\.\d+)?/g)
  const polys = []
  let cur = [0, 0], start = [0, 0], poly = null, cmd = null, i = 0
  const num = () => parseFloat(toks[i++])
  while (i < toks.length) {
    if (/[MLHVCZ]/.test(toks[i])) {
      cmd = toks[i++]
      if (cmd === 'Z') { if (poly) polys.push(poly); poly = null; cur = start; continue }
    }
    if (cmd === 'M') { cur = [num(), num()]; start = cur; poly = [cur]; cmd = 'L' }
    else if (cmd === 'L') { cur = [num(), num()]; poly.push(cur) }
    else if (cmd === 'H') { cur = [num(), cur[1]]; poly.push(cur) }
    else if (cmd === 'V') { cur = [cur[0], num()]; poly.push(cur) }
    else if (cmd === 'C') {
      const [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()]
      const [x0, y0] = cur
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t
        poly.push([u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x,
          u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y])
      }
      cur = [x, y]
    } else throw new Error(`未対応のパスの命令: ${cmd}`)
  }
  if (poly) polys.push(poly)
  return polys
}
const PIECES = FAV.map((p) => flatten(p.d)) // 本体・折り目・尾（印の座標。96 の格子）
const xs = [], ys = []
for (const piece of PIECES) for (const poly of piece) for (const [x, y] of poly) { xs.push(x); ys.push(y) }
const BOX = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
const MARK_W = BOX.x1 - BOX.x0 // 80
const MARK_CX = (BOX.x0 + BOX.x1) / 2
const MARK_CY = (BOX.y0 + BOX.y1) / 2

// ---- 描画（縦 SS 本の走査線 × 横は面積で数える） -----------------------------------------------
const SS = 12
// 多角形の集まりの被覆率（0〜1）を w×h の Float32Array に。map は座標を画素へ移す
function coverage(polys, w, h, map) {
  const cov = new Float32Array(w * h)
  const edges = []
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = map(poly[i])
      const [bx, by] = map(poly[(i + 1) % poly.length])
      if (ay !== by) edges.push(ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay])
    }
  }
  forEachSpan(edges, w, h, (row, xa, xb) => addSpan(cov, row, w, xa, xb))
  return cov
}
function forEachSpan(edges, w, h, emit) {
  const buckets = new Map() // 走査線（サブ行）→ 交点
  for (const [x0, y0, x1, y1] of edges) {
    const r0 = Math.max(0, Math.ceil(y0 * SS - 0.5)), r1 = Math.min(h * SS - 1, Math.ceil(y1 * SS - 0.5) - 1)
    for (let r = r0; r <= r1; r++) {
      const y = (r + 0.5) / SS
      const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)
      let a = buckets.get(r)
      if (!a) buckets.set(r, (a = []))
      a.push(x)
    }
  }
  for (const [r, xsr] of buckets) {
    xsr.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xsr.length; i += 2) emit(Math.floor(r / SS), xsr[i], xsr[i + 1])
  }
}
function addSpan(cov, row, w, xa, xb) {
  xa = Math.max(0, xa); xb = Math.min(w, xb)
  if (xb <= xa) return
  const ia = Math.floor(xa), ib = Math.min(w - 1, Math.floor(xb))
  const wgt = 1 / SS
  if (ia === ib) { cov[row * w + ia] += (xb - xa) * wgt; return }
  cov[row * w + ia] += (ia + 1 - xa) * wgt
  for (let x = ia + 1; x < ib; x++) cov[row * w + x] += wgt
  cov[row * w + ib] += (xb - ib) * wgt
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// キャンバス（色 3 つを alpha 掛けで持つ premultiplied の Float32）
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Float32Array(w * h * 4) }
  fill([r, g, b], a = 1) {
    for (let i = 0; i < this.px.length; i += 4) { this.px[i] = r * a; this.px[i + 1] = g * a; this.px[i + 2] = b * a; this.px[i + 3] = a }
  }
  // 印を塗る。縁の画素でも本体・折り目・尾の割合で色を混ぜてから地に重ねる（折り目の縁が地の色と二重に混ざらない）。
  // 本体は印の全体（折り目・尾も含む）。折り目・尾はその中の部分
  paintMark([body, fold, tail], colors, alphas) {
    for (let p = 0, i = 0; p < body.length; p++, i += 4) {
      const cb = clamp01(body[p])
      if (cb === 0) continue
      let rf = clamp01(fold[p] / cb), rt = clamp01(tail[p] / cb)
      if (rf + rt > 1) { const s = rf + rt; rf /= s; rt /= s }
      const rb = 1 - rf - rt, w = [rb, rf, rt]
      let a = 0
      const f = [0, 0, 0]
      for (let n = 0; n < 3; n++) {
        a += w[n] * alphas[n]
        for (let c = 0; c < 3; c++) f[c] += w[n] * colors[n][c] * alphas[n]
      }
      for (let c = 0; c < 3; c++) this.px[i + c] += (f[c] - this.px[i + c]) * cb
      this.px[i + 3] += (a - this.px[i + 3]) * cb
    }
  }
  // 外形（丸・角丸）で切り抜く
  mask(cov) {
    for (let p = 0, i = 0; p < cov.length; p++, i += 4) {
      const c = clamp01(cov[p])
      this.px[i] *= c; this.px[i + 1] *= c; this.px[i + 2] *= c; this.px[i + 3] *= c
    }
  }
  toRGBA() {
    const out = Buffer.alloc(this.w * this.h * 4)
    for (let p = 0, i = 0; p < this.w * this.h; p++, i += 4) {
      const a = this.px[i + 3]
      out[i + 3] = Math.round(a * 255)
      if (a > 0) for (let c = 0; c < 3; c++) out[i + c] = Math.round(clamp01(this.px[i + c] / a / 255) * 255)
    }
    return out
  }
  toRGB() { // 透過なし（iOS のアイコン・スプラッシュ）。地が全面を塗っている前提
    const out = Buffer.alloc(this.w * this.h * 3)
    for (let p = 0, i = 0, o = 0; p < this.w * this.h; p++, i += 4, o += 3) {
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(clamp01(this.px[i + c] / 255) * 255)
    }
    return out
  }
}

function shapeCoverage(shape, size) {
  const c = size / 2, pts = []
  if (shape === 'circle') {
    for (let i = 0; i < 720; i++) pts.push([c + c * Math.cos((i / 720) * 2 * Math.PI), c + c * Math.sin((i / 720) * 2 * Math.PI)])
  } else {
    const r = size * (22 / 96) // web/favicon.svg の rx
    for (const [ox, oy, a0] of [[size - r, r, -90], [size - r, size - r, 0], [r, size - r, 90], [r, r, 180]]) {
      for (let i = 0; i <= 30; i++) { const a = ((a0 + (i / 30) * 90) * Math.PI) / 180; pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]) }
    }
  }
  return coverage([pts], size, size, (q) => q)
}

// 印を (cx,cy) を中心に、幅 markPx で置いて塗る。alphas は本体・折り目・尾の濃さ（テーマアイコンは折り目だけ薄い）
function drawMark(cv, cx, cy, markPx, colors, alphas = [1, 1, 1]) {
  const k = markPx / MARK_W
  const map = ([x, y]) => [(x - MARK_CX) * k + cx, (y - MARK_CY) * k + cy]
  cv.paintMark(PIECES.map((piece) => coverage(piece, cv.w, cv.h, map)), colors, alphas)
}

// ---- PNG -----------------------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
function encodePng(w, h, channels, raw) { // channels 3 = RGB、4 = RGBA
  const stride = w * channels
  const scan = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) { scan[y * (stride + 1)] = 0; raw.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride) }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scan, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
// 書いた PNG（フィルター 0 だけ）を RGB(A) の生の画素へ。--check が使う
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ch = 0; const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0 }
    if (type === 'IDAT') idat.push(data)
    pos += len + 12
  }
  if (!ch) return null
  const scan = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    if (scan[y * (stride + 1)] !== 0) return null // 他のフィルターは読まない（外から差し替えられたファイル。--check は不一致として扱う）
    scan.copy(raw, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { w, h, ch, raw }
}

// ---- 作るもの -------------------------------------------------------------------------------
// 形（モックで承認済み 2026-10-09）: 地 #3a499e に白い印。印の幅は見える範囲（Android は 108dp のうち中央の 72dp・iOS と Play は全面）の 60%。
// adaptive の 108dp のレイヤーでは印の幅 43.2dp。66dp の円（どのランチャーの形でも欠けない範囲）に収まる。
const MARK_FRAC = 0.6
const VISIBLE_DP = 72, LAYER_DP = 108

function iconFull(size, shape) { // 地を全面に塗った正方形。shape: undefined（全面）・'round'（円）・'squircle'（角丸）
  const cv = new Canvas(size, size)
  cv.fill(GROUND)
  drawMark(cv, size / 2, size / 2, size * MARK_FRAC, MARK_COLORS)
  if (shape) cv.mask(shapeCoverage(shape === 'round' ? 'circle' : 'rrect', size))
  return cv
}
function adaptiveLayer(size, kind) { // 108dp のレイヤー。kind: 'foreground'（透過の上に印）・'monochrome'（アルファだけ）
  const cv = new Canvas(size, size)
  const markPx = size * (VISIBLE_DP / LAYER_DP) * MARK_FRAC
  if (kind === 'foreground') drawMark(cv, size / 2, size / 2, markPx, MARK_COLORS)
  else drawMark(cv, size / 2, size / 2, markPx, [[0, 0, 0], [0, 0, 0], [0, 0, 0]], [1, FOLD_MONO_ALPHA, 1])
  return cv
}
function splashImage(w, h, theme, markFracOfShort) { // 平らな地に印を中央へ。印の幅は短い辺の割合
  const cv = new Canvas(w, h)
  cv.fill(theme.ground)
  drawMark(cv, w / 2, h / 2, Math.min(w, h) * markFracOfShort, theme.marks)
  return cv
}

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const SPLASH_SIZES = { // 今ある splash.png の大きさのまま（drawable は mdpi の 480×320）
  port: { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] },
  land: { mdpi: [480, 320], hdpi: [800, 480], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] },
}
const SPLASH_MARK_FRAC = 0.3 // Android: 短い辺の 30%
const IOS_SPLASH_MARK_FRAC = 0.14 // iOS: 2732 の正方形の 14%（scaleAspectFill で縦長の端末の幅の約 30% になる）

function outputs() {
  const list = [] // { file, w, h, ch, make }
  const add = (file, w, h, ch, make) => list.push({ file, w, h, ch, make })
  for (const [d, m] of Object.entries(DENSITY)) {
    const dir = path.join(RES, `mipmap-${d}`)
    const legacy = Math.round(48 * m), layer = Math.round(108 * m)
    add(path.join(dir, 'ic_launcher.png'), legacy, legacy, 4, () => iconFull(legacy, 'squircle'))
    add(path.join(dir, 'ic_launcher_round.png'), legacy, legacy, 4, () => iconFull(legacy, 'round'))
    add(path.join(dir, 'ic_launcher_foreground.png'), layer, layer, 4, () => adaptiveLayer(layer, 'foreground'))
    add(path.join(dir, 'ic_launcher_monochrome.png'), layer, layer, 4, () => adaptiveLayer(layer, 'monochrome'))
  }
  // スプラッシュ: 明（drawable）と暗（-night）。向きの修飾子は night より前（port-night-hdpi）
  for (const [theme, night] of [[SPLASH_LIGHT, ''], [SPLASH_DARK, '-night']]) {
    add(path.join(RES, `drawable${night}`, 'splash.png'), 480, 320, 3, () => splashImage(480, 320, theme, SPLASH_MARK_FRAC))
    for (const [orient, sizes] of Object.entries(SPLASH_SIZES)) {
      for (const [d, [w, h]] of Object.entries(sizes)) {
        add(path.join(RES, `drawable-${orient}${night}-${d}`, 'splash.png'), w, h, 3, () => splashImage(w, h, theme, SPLASH_MARK_FRAC))
      }
    }
  }
  add(path.join(XCASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'), 1024, 1024, 3, () => iconFull(1024))
  for (const [theme, names] of [[SPLASH_LIGHT, ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']],
    [SPLASH_DARK, ['splash-2732x2732-dark.png', 'splash-2732x2732-dark-1.png', 'splash-2732x2732-dark-2.png']]]) {
    let cache = null
    for (const n of names) add(path.join(XCASSETS, 'Splash.imageset', n), 2732, 2732, 3, () => (cache ??= splashImage(2732, 2732, theme, IOS_SPLASH_MARK_FRAC)))
  }
  add(PLAY_ICON, 512, 512, 4, () => iconFull(512)) // Google Play の「アプリのアイコン」。全面の正方形（角は Google が丸める）
  return list
}

// ---- 実行 -----------------------------------------------------------------------------------
const args = process.argv.slice(2)
const check = args.includes('--check')
const bytesOf = (o, cv) => (o.ch === 4 ? cv.toRGBA() : cv.toRGB())

let bad = 0
for (const o of outputs()) {
  const cv = o.make()
  const raw = bytesOf(o, cv)
  if (check) {
    const have = fs.existsSync(o.file) ? decodePng(fs.readFileSync(o.file)) : null
    if (!have || have.w !== o.w || have.h !== o.h || have.ch !== o.ch || !have.raw.equals(raw)) { bad++; console.error(`古い・欠けています: ${path.relative(ROOT, o.file)}`) }
  } else {
    fs.mkdirSync(path.dirname(o.file), { recursive: true })
    fs.writeFileSync(o.file, encodePng(o.w, o.h, o.ch, raw))
  }
}
if (check) {
  if (bad) { console.error(`${bad} 件が今の SVG と合いません。node mobile/scripts/generate-icons.mjs で書き直してください`); process.exit(1) }
  console.log('モバイルのアイコン・スプラッシュは今の SVG と一致しています')
} else console.log('書き出しました')
