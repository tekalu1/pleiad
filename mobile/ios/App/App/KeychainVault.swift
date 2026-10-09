// 端末の静的鍵と中継用トークンを、同期・移行しない Keychain の 1 項目に保管する（ADR 0174）。
import Foundation
import Security
import PleiadRemote
final class KeychainVault: SecretVault {
    static let service = "dev.pleiad.app.remote"
    private let account: String

    init(account: String = "secrets") { self.account = account }

    let protected = true

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: KeychainVault.service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    func load() throws -> Bytes? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        guard st == errSecSuccess, let data = out as? Data else { throw VaultError("keychain read \(st)") }
        return Bytes(data)
    }

    func save(_ data: Bytes) throws {
        let attrs: [String: Any] = [kSecValueData as String: Data(data),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var st = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if st == errSecItemNotFound {
            var add = query
            for (k, v) in attrs { add[k] = v }
            st = SecItemAdd(add as CFDictionary, nil)
        }
        guard st == errSecSuccess else { throw VaultError("keychain write \(st)") }
    }
}
