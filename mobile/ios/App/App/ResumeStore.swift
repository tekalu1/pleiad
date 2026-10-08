// 前回のホスト ID だけを覚える。一覧へ戻ったときとホストを削除したときに消す。
import Foundation
enum ResumeStore {
    private static let key = "resume.hostId"

    static func hostId() -> String? { UserDefaults.standard.string(forKey: key) }

    static func remember(_ hostId: String) { UserDefaults.standard.set(hostId, forKey: key) }
    static func forget(_ hostId: String? = nil) {
        if hostId == nil || UserDefaults.standard.string(forKey: key) == hostId { UserDefaults.standard.removeObject(forKey: key) }
    }
}
