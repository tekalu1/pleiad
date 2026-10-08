// アプリの特定と起動（ADR 0173 §4）。ここは事実（pid・bundle id・.app のパス・名前）だけを返し、
// AppInfo の id・Pleiad 自身の判定・名前の検索の点数は main（desktop/computer/mac-apps.cjs）が付ける。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import AppKit
import ApplicationServices
import ComputerProtocol

enum Apps {
    static let searchFolders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]

    /** pid → { pid, bundleId?, bundlePath?, executable?, name?, regular } */
    static func info(pid: pid_t) -> [String: Any]? {
        guard pid > 0 else { return nil }
        var out: [String: Any] = ["pid": Int(pid)]
        if let app = NSRunningApplication(processIdentifier: pid) {
            if let id = app.bundleIdentifier { out["bundleId"] = id }
            if let url = app.bundleURL { out["bundlePath"] = url.path }
            if let url = app.executableURL { out["executable"] = url.path }
            if let name = app.localizedName { out["name"] = name }
            out["regular"] = app.activationPolicy == .regular
        } else {
            out["regular"] = false
        }
        // 窓を持つプロセスはふつう NSRunningApplication に載る。載らないもの（パスも分からない）は特定できない扱い
        return out["executable"] == nil && out["bundlePath"] == nil ? nil : out
    }

    /** { x, y, excludePid }。点の下の窓の持ち主。AX で特定できない・Pleiad の窓に当たったときは窓の一覧を上から見る */
    static func at(_ args: [String: Any]) throws -> [String: Any]? {
        try Permissions.requireAccessibility()
        guard let x = doubleValue(args["x"]), let y = doubleValue(args["y"]) else { return nil }
        let excludePid = pid_t(intValue(args["excludePid"]) ?? Int(getppid()))
        if AXIsProcessTrusted() {
            var element: AXUIElement?
            if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &element) == .success, let element {
                var pid: pid_t = 0
                if AXUIElementGetPid(element, &pid) == .success, pid > 0, pid != excludePid { return info(pid: pid) }
            }
        }
        return windowOwner(at: CGPoint(x: x, y: y), excludePid: excludePid).flatMap { info(pid: $0) }
    }

    /** 画面の上の窓を前から順に見て、点を含む最初の窓の持ち主（Pleiad のオーバーレイと透明な窓は飛ばす） */
    private static func windowOwner(at point: CGPoint, excludePid: pid_t) -> pid_t? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in list {
            let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            if pid <= 0 || alpha <= 0 { continue }
            if pid == excludePid && layer >= Capture.overlayLayer { continue }
            guard let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            if bounds.contains(point) { return pid }
        }
        return nil
    }

    static func foreground() -> [String: Any]? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return info(pid: app.processIdentifier)
    }

    /** 動いている普通のアプリと、決まったフォルダーの .app */
    static func list() -> [String: Any] {
        let running = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { info(pid: $0.processIdentifier) }
        var installed: [[String: Any]] = []
        let fm = FileManager.default
        for folder in searchFolders + [NSHomeDirectory() + "/Applications"] {
            guard let names = try? fm.contentsOfDirectory(atPath: folder) else { continue }
            for name in names.sorted() where name.hasSuffix(".app") {
                let path = folder + "/" + name
                var entry: [String: Any] = ["bundlePath": path, "name": fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")]
                if let id = Bundle(path: path)?.bundleIdentifier { entry["bundleId"] = id }
                installed.append(entry)
            }
        }
        return ["running": running, "installed": installed]
    }

    /** { path: .app }。動いていれば前に出す（openApplication がそうする） */
    static func launch(_ args: [String: Any], reply: @escaping Reply) throws {
        guard let path = args["path"] as? String, path.hasPrefix("/"), path.hasSuffix(".app") else { throw HelperError(.notFound, "path must be an absolute .app path") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw HelperError(.notFound, "application not found: \(path)")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration) { app, error in
            if let app, let data = Apps.info(pid: app.processIdentifier) {
                reply(.success(["app": data]))
            } else {
                reply(.failure(HelperError(.failed, "openApplication failed: \(error?.localizedDescription ?? "unknown")")))
            }
        }
    }

    /** { pid }。前に出す */
    static func activate(_ args: [String: Any]) throws -> Bool {
        guard let pid = intValue(args["pid"]), let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            throw HelperError(.notFound, "process is not running")
        }
        return app.activate()
    }
}
#endif
