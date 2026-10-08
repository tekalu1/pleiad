import Foundation
import XCTest
@testable import PleiadRemote
final class ShellBridgeTests: XCTestCase {
    private let hostId = "trleh4p5diok2b3hxpcck5nsba"

    private func record(revokedAt: Int64? = nil) -> HostRecord {
        HostRecord(hostId: hostId, hostName: "desk", label: "", relayUrl: "https://relay.example", hostPublicKey: "key",
                   deviceId: "dev", port: 51234, pairedAt: 1, lastConnectedAt: nil, revokedAt: revokedAt)
    }

    func testHostEntryHasNoKeyAndAState() {
        let closed = ShellBridge.hostEntry(record(), nil)
        XCTAssertNil(closed["hostPublicKey"])
        XCTAssertEqual(closed["state"]?.string, "closed")
        XCTAssertEqual(closed["open"]?.bool, false)
        XCTAssertEqual(closed["hostId"]?.string, hostId)
        XCTAssertEqual(ShellBridge.hostEntry(record(revokedAt: 5), nil)["state"]?.string, "revoked")
        let live = ShellBridge.hostEntry(record(revokedAt: 5), LinkStatus("connected"))
        XCTAssertEqual(live["state"]?.string, "connected")
        XCTAssertEqual(live["open"]?.bool, true)
    }

    func testStatusEventNamesTheHost() {
        let e = ShellBridge.statusEvent(hostId, LinkStatus("host-offline", closeCode: 4404))
        XCTAssertEqual(e["hostId"]?.string, hostId)
        XCTAssertEqual(e["state"]?.string, "host-offline")
        XCTAssertEqual(e["closeCode"]?.int, 4404)
    }

    func testFailuresHaveTheCodesThePageTranslates() {
        let p = ShellBridge.failure(PairError("denied", "by user", closeCode: 4403))
        XCTAssertEqual(p.code, "denied")
        XCTAssertEqual(p.data?["detail"]?.string, "by user")
        XCTAssertEqual(p.data?["closeCode"]?.int, 4403)
        XCTAssertEqual(ShellBridge.failure(PairError("expired")).data?["closeCode"], .null)
        XCTAssertEqual(ShellBridge.failure(VaultError("keychain -25308")).code, "storage")
        XCTAssertEqual(ShellBridge.failure(StateError(description: "unknown-host")).code, "unknown-host")
        XCTAssertEqual(ShellBridge.failure(StateError(description: "hosts.json has a broken entry")).code, "internal")
    }

    func testOfferRejectsABrokenPayload() {
        XCTAssertThrowsError(try ShellBridge.offer("pleiad://pair?v=1&h=x", known: { _ in false })) { e in
            XCTAssertEqual(ShellBridge.failure(e).code, "payload")
        }
        XCTAssertThrowsError(try ShellBridge.offer(nil, known: { _ in false }))
    }

    func testFoundationValues() {
        let o = ShellBridge.foundationObject(["a": 1, "b": .null, "c": [true, "x"], "d": ["e": .double(1.5)]])
        XCTAssertEqual(o["a"] as? Int64, 1)
        XCTAssertTrue(o["b"] is NSNull)
        XCTAssertEqual((o["c"] as? [Any])?.count, 2)
        XCTAssertEqual((o["d"] as? [String: Any])?["e"] as? Double, 1.5)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(o))
    }

    func testThemeColorsAreHexOnly() {
        XCTAssertTrue(ShellBridge.color("#1b1c23")! == (0x1b, 0x1c, 0x23))
        XCTAssertTrue(ShellBridge.color("#FFFFFF")! == (255, 255, 255))
        for bad in [nil, "", "#fff", "1b1c23", "#1b1c2", "#1b1c234", "#gggggg", "red", "#１２３４５６", "#+12345"] {
            XCTAssertNil(ShellBridge.color(bad), bad ?? "nil")
        }
    }

    func testPairLinks() {
        XCTAssertTrue(ShellBridge.isPairLink(scheme: "pleiad", host: "pair"))
        XCTAssertTrue(ShellBridge.isPairLink(scheme: "PLEIAD", host: "Pair"))
        XCTAssertFalse(ShellBridge.isPairLink(scheme: "pleiad", host: "open"))
        XCTAssertFalse(ShellBridge.isPairLink(scheme: "https", host: "pair"))
    }

    func testHostScriptFillsInLiterals() {
        let template = "const ORIGIN = __PLY_ORIGIN__; const info = __PLY_INFO__; window[__PLY_RECEIVER__] = 1;"
        let s = ShellBridge.hostScript(template: template, info: ["hostName": "a\"b</script>\u{2028}"],
                                       origin: "http://127.0.0.1:51234", receiver: "__ply_r_abc")
        XCTAssertEqual(s, "const ORIGIN = \"http://127.0.0.1:51234\"; const info = {\"hostName\":\"a\\\"b</script>\\u2028\"}; window[\"__ply_r_abc\"] = 1;")
        XCTAssertFalse(s.contains("__PLY_"))
        let d = ShellBridge.deliver(receiver: "__ply_r_abc", message: ["type": "status"])
        XCTAssertEqual(d, "(() => { const f = window[\"__ply_r_abc\"]; if (typeof f === 'function') f(\"{\\\"type\\\":\\\"status\\\"}\"); })()")
    }

    func testStatusListenersCanStop() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ply-shell-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let device = RemoteDevice(store: try DeviceStore(dir: dir), app: "test", name: "t")
        let a = device.onStatus { _, _ in }
        let b = device.onStatus { _, _ in }
        XCTAssertNotEqual(a, b)
        device.offStatus(a)
        device.offStatus(a)
        XCTAssertNil(try device.rename(hostId, "x"))
    }
}
