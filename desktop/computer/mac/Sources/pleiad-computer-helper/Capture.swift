// 撮影（ADR 0173 §2）。macOS 14 以上の SCScreenshotManager。
// 頼み: { display: CGDirectDisplayID, rect: グローバルの point, width, height: 出力の画素, quality, gray, excludePid }
// 答え: { jpeg: base64, width, height } か { gray: base64（1 画素 1 バイト）, width, height }
// オーバーレイ（Pleiad の窓のうち screen-saver の段 = 1000 以上）は写さない。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import Foundation
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import ComputerProtocol

enum Capture {
    /** オーバーレイの窓の段（Electron の setAlwaysOnTop(true, 'screen-saver') = NSScreenSaverWindowLevel） */
    static let overlayLayer = 1000

    static func capture(_ args: [String: Any], reply: @escaping Reply) throws {
        try Permissions.requireScreen()
        guard let rawId = intValue(args["display"]), rawId >= 0, rawId <= Int(UInt32.max) else {
            throw HelperError(.failed, "display must be a CGDirectDisplayID")
        }
        let displayID = CGDirectDisplayID(rawId)
        let rect = try requireRect(args["rect"])
        let size = try outputSize(args)
        let quality = jpegQuality(args["quality"])
        let gray = args["gray"] as? Bool ?? false
        let excludePid = pid_t(intValue(args["excludePid"]) ?? Int(getppid()))

        let cgBounds = CGDisplayBounds(displayID)
        guard cgBounds.width > 0, cgBounds.height > 0 else { throw HelperError(.outside, "display \(rawId) does not exist") }
        let display = Rect(x: Double(cgBounds.origin.x), y: Double(cgBounds.origin.y), width: Double(cgBounds.width), height: Double(cgBounds.height))
        guard let wanted = rect.intersection(display) else { throw HelperError(.outside, "rect is outside the display") }

        let finish: (CGImage?, String?) -> Void = { image, message in
            guard let image else {
                reply(.failure(HelperError(.failed, message ?? "capture failed")))
                return
            }
            do { reply(.success(try Capture.encode(image, width: size.width, height: size.height, quality: quality, gray: gray))) } catch let error as HelperError {
                reply(.failure(error))
            } catch {
                reply(.failure(HelperError(.failed, String(describing: error))))
            }
        }

        captureWithScreenshotManager(displayID, local: wanted.local(in: display), width: size.width, height: size.height, excludePid: excludePid, finish)
    }

    @available(macOS 14.0, *)
    private static func captureWithScreenshotManager(_ displayID: CGDirectDisplayID, local: Rect, width: Int, height: Int, excludePid: pid_t,
                                                     _ finish: @escaping (CGImage?, String?) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let content else {
                finish(nil, "SCShareableContent failed: \(error?.localizedDescription ?? "unknown")")
                return
            }
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                finish(nil, "display \(displayID) is not shareable")
                return
            }
            let overlays = content.windows.filter { $0.owningApplication?.processID == excludePid && $0.windowLayer >= Capture.overlayLayer }
            let filter = SCContentFilter(display: display, excludingWindows: overlays)
            let config = SCStreamConfiguration()
            config.sourceRect = CGRect(x: local.x, y: local.y, width: local.width, height: local.height) // ディスプレイの中の point
            config.width = width // 出力の画素
            config.height = height
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                finish(image, error.map { "SCScreenshotManager failed: \($0.localizedDescription)" })
            }
        }
    }

    /** 出力の大きさへ描き直し、JPEG か明るさにする */
    static func encode(_ image: CGImage, width: Int, height: Int, quality: Double, gray: Bool) throws -> [String: Any] {
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let scaled: CGImage? = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            if gray { return image } // 明るさは pixels から読む
            return context.makeImage()
        }
        guard let scaled else { throw HelperError(.failed, "could not create a bitmap context") }
        if gray {
            let values = luma(rgba: pixels, count: width * height, bgra: false) // RGBX
            return ["gray": Data(values).base64EncodedString(), "width": width, "height": height]
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            throw HelperError(.failed, "could not create a JPEG encoder")
        }
        CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw HelperError(.failed, "JPEG encoding failed") }
        return ["jpeg": (data as Data).base64EncodedString(), "width": width, "height": height]
    }
}
#endif
