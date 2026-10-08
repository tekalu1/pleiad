// 殻とプロキシの案内。共通の web の辞書と同じ文言を使う。
import Foundation
import PleiadRemote
enum ShellTexts {
    static var isJapanese: Bool { Bundle.main.preferredLocalizations.first?.hasPrefix("ja") == true }

    private static func pick(_ en: String, _ ja: String) -> String { isJapanese ? ja : en }

    static var revoked: String { pick("This device was revoked on the host", "この端末はホストで取り消されました") }
    static var hostOffline: String { pick("Can't reach the host", "ホストにつながりません") }
    static var pageRevoked: String { pick("Pair this device again.", "もう一度ペアリングしてください。") }
    static var pageHostOffline: String {
        pick("Make sure Pleiad is running on the host. This page opens automatically once connected.",
             "ホストの Pleiad が起動しているか確かめてください。つながり次第、自動で開きます。")
    }
    static var pageOffline: String {
        pick("Can't reach the relay. Check your network. This page opens automatically once connected.",
             "中継につながりません。ネットワークを確かめてください。つながり次第、自動で開きます。")
    }
    static var tokenRequired: String { pick("A token is required (open this from the app)", "トークンが要る（アプリから開いてください）") }
    static var lost: String { pick("Lost the connection to the host", "ホストとの接続が切れました") }
    static var backToHosts: String { pick("Back to hosts", "ホスト一覧に戻る") }
    static var hostOpenFailed: String { pick("Couldn't open this host. Go back and try again.", "このホストを開けませんでした。戻ってもう一度試してください。") }
    static var linkHostOnly: String { pick("localhost links open only on the host's PC.", "localhost のリンクはホストの PC でだけ開けます。") }
    static var sheetClose: String { pick("Close", "閉じる") }
    static var scanCancel: String { pick("Cancel", "キャンセル") }
    static var scanHint: String { pick("Point the camera at the QR code on the host", "ホストに出ている QR コードにカメラを向けてください") }
}
struct ProxyWords: ProxyTexts {
    func locale() -> String { ShellTexts.isJapanese ? "ja" : "en" }
    func title(_ state: String) -> String { state == "revoked" ? ShellTexts.revoked : ShellTexts.hostOffline }
    func body(_ state: String) -> String {
        switch state {
        case "revoked": return ShellTexts.pageRevoked
        case "host-offline": return ShellTexts.pageHostOffline
        default: return ShellTexts.pageOffline
        }
    }
    func tokenRequired() -> String { ShellTexts.tokenRequired }
    func lost() -> String { ShellTexts.lost }
    func backToHosts() -> String { ShellTexts.backToHosts }
}
