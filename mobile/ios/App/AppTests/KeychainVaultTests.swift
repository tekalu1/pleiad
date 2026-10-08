import XCTest
import Security
import PleiadRemote
@testable import App

final class KeychainVaultTests: XCTestCase {
    func testSaveReloadAndUpdateWithoutMigratingOrSyncing() throws {
        // 実際の端末鍵に触れないよう、試験ごとに別の項目を使う。
        let account = "test-" + UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: KeychainVault.service,
                                   kSecAttrAccount as String: account]
        defer { SecItemDelete(query as CFDictionary) }
        let vault = KeychainVault(account: account)
        XCTAssertNil(try vault.load())
        try vault.save([1, 2, 3])
        XCTAssertEqual(try KeychainVault(account: account).load(), [1, 2, 3])
        try vault.save([4, 5])
        XCTAssertEqual(try vault.load(), [4, 5])
        var attributes = query
        attributes[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(attributes as CFDictionary, &result), errSecSuccess)
        let saved = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(saved[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNotEqual(saved[kSecAttrSynchronizable as String] as? Bool, true)
        XCTAssertTrue(vault.protected)
    }
}
