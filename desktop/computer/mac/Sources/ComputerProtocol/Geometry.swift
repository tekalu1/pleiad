// 座標（ADR 0173 §8）。単位は CoreGraphics のグローバル座標の point（主ディスプレイの左上が原点、y は下向き）。
// 撮る範囲と出力の大きさは main（desktop/computer/mac.cjs）が決めて渡す。ここは受け取った値の検査と、ディスプレイの中の座標への変換だけ。
import Foundation

public struct Rect: Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Double { x + width }
    public var maxY: Double { y + height }

    public func contains(x px: Double, y py: Double) -> Bool {
        px >= x && py >= y && px < maxX && py < maxY
    }

    public func intersection(_ other: Rect) -> Rect? {
        let left = max(x, other.x), top = max(y, other.y)
        let right = min(maxX, other.maxX), bottom = min(maxY, other.maxY)
        return right > left && bottom > top ? Rect(x: left, y: top, width: right - left, height: bottom - top) : nil
    }

    /** グローバルの矩形を、display の左上を原点にした矩形へ（SCStreamConfiguration.sourceRect の座標） */
    public func local(in display: Rect) -> Rect {
        Rect(x: x - display.x, y: y - display.y, width: width, height: height)
    }
}

/** 出力の画像の上限（1 辺）。main の上限（長辺 1568、upscale の zoom でも 2 倍の Retina の範囲）より十分大きく、壊れた値だけを止める */
public let maxOutputEdge = 8192

/** 出力の幅・高さ（画素）の検査。範囲の外は failed */
public func outputSize(_ args: [String: Any]) throws -> (width: Int, height: Int) {
    guard let width = intValue(args["width"]), let height = intValue(args["height"]),
          width > 0, height > 0, width <= maxOutputEdge, height <= maxOutputEdge else {
        throw HelperError(.failed, "width and height must be 1...\(maxOutputEdge)")
    }
    return (width, height)
}

/** JPEG の品質（1〜100 の整数）を ImageIO の 0〜1 へ */
public func jpegQuality(_ value: Any?) -> Double {
    let q = intValue(value) ?? 75
    return Double(min(100, max(1, q))) / 100
}

/** BGRA か RGBA の画素から明るさ（0〜255）。desktop/computer/capture.cjs の lumaOf と同じ重み */
public func luma(rgba: [UInt8], count: Int, bgra: Bool) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: count)
    var j = 0
    for i in 0..<count {
        guard j + 2 < rgba.count else { break }
        let (b, g, r) = bgra ? (Int(rgba[j]), Int(rgba[j + 1]), Int(rgba[j + 2])) : (Int(rgba[j + 2]), Int(rgba[j + 1]), Int(rgba[j]))
        out[i] = UInt8((b * 29 + g * 150 + r * 77) >> 8)
        j += 4
    }
    return out
}
