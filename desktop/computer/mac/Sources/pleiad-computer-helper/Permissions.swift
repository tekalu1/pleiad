// TCC の権限（ADR 0173 §5）。画面収録は撮影の前、アクセシビリティは入力と点の下のアプリの前に確かめる。
// 無ければ code: permission と permission: screen | accessibility を返す。システム設定を開くのは main（mac.cjs）。
// 一度拒まれた・許可した直後の結果はこのプロセスの中では古いままのことがあるので、main は permission の後にヘルパーを起こし直す。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import Foundation
import CoreGraphics
import ApplicationServices
import Carbon.HIToolbox
import ComputerProtocol

enum Permissions {
    static func status() -> [String: Any] {
        ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    }

    static func requireScreen() throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(.permission, "Screen Recording permission is not granted", extra: ["permission": "screen"])
        }
    }

    static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw HelperError(.permission, "Accessibility permission is not granted", extra: ["permission": "accessibility"])
        }
    }

    /** OS の確かめの窓を出す（初回だけ出る。2 回目からは何も出ないので、main がシステム設定を開く） */
    static func request(_ which: String) -> Bool {
        switch which {
        case "screen":
            return CGRequestScreenCaptureAccess()
        case "accessibility":
            // kAXTrustedCheckOptionPrompt の値
            return AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        default:
            return false
        }
    }
}

/** ロック・ログイン窓・安全な入力（パスワード欄）の判定（ADR 0173 §10） */
enum Session {
    static func state() -> [String: Any] {
        var locked = true
        var onConsole = false
        if let dict = CGSessionCopyCurrentDictionary() as? [String: Any] {
            locked = (dict["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
            onConsole = (dict["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? true
        }
        return ["locked": locked || !onConsole, "secureInput": IsSecureEventInputEnabled()]
    }
}
#endif
