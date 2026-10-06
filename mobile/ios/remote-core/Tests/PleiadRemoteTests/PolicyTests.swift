import Foundation
import XCTest
@testable import PleiadRemote

/// The same cases as LinkPolicyTest.kt and tests/unit/remote-links.mjs (desktop linkTarget).
final class LinkPolicyTests: XCTestCase {
    private let proxy = 51234

    private func of(_ url: String) -> LinkTarget {
        guard let u = URLComponents(string: url) else { return .blocked }
        return LinkPolicy.classify(scheme: u.scheme, host: u.host, port: u.port, path: u.path,
                                   hasUserInfo: u.user != nil || u.password != nil, proxyPort: proxy)
    }

    func testSnapshotOnTheProxyOnly() {
        XCTAssertEqual(.snapshot, of("http://127.0.0.1:\(proxy)/visualization-snapshot?sessionId=s&id=i"))
        XCTAssertEqual(.blocked, of("http://127.0.0.1:\(proxy)/"))
        XCTAssertEqual(.blocked, of("http://127.0.0.1:\(proxy)/local-file?path=x"))
        XCTAssertEqual(.blocked, of("http://127.0.0.1:\(proxy)/visualization-snapshot/x"))
        // Another port on the device is not this window's proxy
        XCTAssertEqual(.hostOnly, of("http://127.0.0.1:\(proxy + 1)/visualization-snapshot?id=i"))
        XCTAssertEqual(.hostOnly, of("https://127.0.0.1:\(proxy)/visualization-snapshot?id=i"))
    }

    func testWebPagesGoToTheBrowser() {
        XCTAssertEqual(.external, of("https://example.com/a?b=c"))
        XCTAssertEqual(.external, of("http://example.org/"))
        XCTAssertEqual(.external, of("http://192.168.1.10:3000/"))
        XCTAssertEqual(.blocked, of("https://user:pass@example.com/"))
        XCTAssertEqual(.blocked, of("intent://scan/#Intent;scheme=zxing;end"))
        XCTAssertEqual(.blocked, of("file:///var/x.html"))
        XCTAssertEqual(.blocked, of("javascript:alert(1)"))
    }

    func testLoopbackIsTheHostsPc() {
        for u in ["http://localhost:3000/", "http://LOCALHOST/", "http://app.localhost:5173/", "http://127.0.0.1:5173/",
                  "http://127.1.2.3/", "http://0.0.0.0:8080/", "http://[::1]:3000/", "https://localhost./"] {
            XCTAssertEqual(.hostOnly, of(u), u)
        }
        XCTAssertTrue(LinkPolicy.isLoopbackHost("::ffff:7f00:1"))
        XCTAssertTrue(LinkPolicy.isLoopbackHost("[::ffff:127.0.0.1]"))
        XCTAssertTrue(LinkPolicy.isLoopbackHost("[::1]"))
        XCTAssertFalse(LinkPolicy.isLoopbackHost("localhost.example.com"))
        XCTAssertFalse(LinkPolicy.isLoopbackHost("128.0.0.1"))
        XCTAssertFalse(LinkPolicy.isLoopbackHost(nil))
    }
}

/// The same cases as ResumePolicyTest.kt.
final class ResumePolicyTests: XCTestCase {
    private func host(_ id: String, revokedAt: Int64? = nil) -> HostRecord {
        HostRecord(hostId: id, hostName: "pc-\(id)", label: "", relayUrl: "https://relay.example", hostPublicKey: "key",
                   deviceId: "dev", port: 0, pairedAt: 1, lastConnectedAt: 2, revokedAt: revokedAt)
    }

    private lazy var hosts = [host("a"), host("b", revokedAt: 5)]

    private func decide(_ saved: String?, fresh: Bool = true, launcher: Bool = true, list: [HostRecord]? = nil) -> ResumeDecision {
        ResumePolicy.decide(saved: saved, hosts: list ?? hosts, freshStart: fresh, launcherStart: launcher)
    }

    func testOpensTheSavedHostOnAFreshLauncherStart() {
        XCTAssertEqual(ResumeDecision("a", false), decide("a"))
    }

    func testShowsTheListWhenNothingIsSaved() {
        XCTAssertEqual(ResumeDecision(nil, false), decide(nil))
        XCTAssertEqual(ResumeDecision(nil, false), decide(""))
    }

    func testShowsTheListWhenRestoredOrOpenedByAPairLink() {
        XCTAssertEqual(ResumeDecision(nil, false), decide("a", fresh: false))
        XCTAssertEqual(ResumeDecision(nil, false), decide("a", launcher: false))
    }

    func testForgetsAHostThatIsGoneOrRevoked() {
        XCTAssertEqual(ResumeDecision(nil, true), decide("gone"))
        XCTAssertEqual(ResumeDecision(nil, true), decide("b"))
        XCTAssertEqual(ResumeDecision(nil, true), decide("a", list: []))
        // Even when it would not have opened anyway: it does not qualify any more
        XCTAssertEqual(ResumeDecision(nil, true), decide("b", fresh: false))
    }
}

/// The notice page the proxy shows while the host is unreachable (docs/remote.md §8.2), like UnavailablePageTest.kt.
final class UnavailablePageTests: XCTestCase {
    private let loop = Loop(name: "test-loop")
    private let creds = HostCreds(hostId: "h", hostPublicKey: Bytes(repeating: 0, count: 32), relayUrl: "https://relay.example",
                                  deviceId: "d", token: "t", hostName: "desk")

    override func tearDown() { loop.shutdown() }

    private func page(_ state: String, _ texts: ProxyTexts = DefaultTexts()) -> String {
        DeviceProxy(loop: loop, creds: creds, keyPair: KeyPair.generate(), texts: texts).unavailablePage(state)
    }

    func testHasAButtonBackToTheHostList() {
        for state in ["offline", "host-offline", "revoked"] {
            let html = page(state)
            // Hidden until the app's host window provides window.backToHosts; the page has no CSP, so the inline script runs
            XCTAssertTrue(html.contains(#"<button type="button" id="back-to-hosts" hidden>Back to hosts</button>"#), state)
            XCTAssertTrue(html.contains("window.backToHosts()"), state)
            XCTAssertTrue(html.contains("typeof window.backToHosts==='function'"), state)
        }
    }

    private struct Japanese: ProxyTexts {
        let base = DefaultTexts()
        func title(_ state: String) -> String { base.title(state) }
        func body(_ state: String) -> String { base.body(state) }
        func tokenRequired() -> String { base.tokenRequired() }
        func lost() -> String { base.lost() }
        func backToHosts() -> String { "<b>一覧</b>" }
    }

    func testTheButtonTextComesFromTheAppAndIsEscaped() {
        XCTAssertTrue(page("offline", Japanese()).contains(">&lt;b&gt;一覧&lt;/b&gt;</button>"))
    }

    func testKeepsTheAutoRefreshExceptWhenRevoked() {
        XCTAssertTrue(page("offline").contains(#"<meta http-equiv="refresh" content="5">"#))
        XCTAssertFalse(page("revoked").contains(#"http-equiv="refresh""#))
        XCTAssertFalse(page("offline").contains("Content-Security-Policy"))
    }
}

/// The QR payload and relay URL rules (core/remote/pairing.mjs). Node parity for the same inputs is in InteropTests.
final class PairingCodecTests: XCTestCase {
    private func offer(_ fields: [String: String]) -> String {
        "pleiad://pair?" + fields.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }.joined(separator: "&")
    }

    func testParsesAValidOffer() throws {
        let kp = KeyPair.generate()
        let secret = randomBytes(32)
        let hostId = try Pleiad.hostIdFor(kp.publicKey)
        let o = try PairingCodec.parse(offer(["v": "1", "r": "https://relay.example/", "h": hostId.uppercased(),
                                              "k": Base64URL.encode(kp.publicKey), "s": Base64URL.encode(secret), "n": "desk top"]))
        XCTAssertEqual("https://relay.example", o.relayUrl)
        XCTAssertEqual(hostId, o.hostId)
        XCTAssertEqual(kp.publicKey, o.publicKey)
        XCTAssertEqual(secret, o.secret)
        XCTAssertEqual("desk top", o.hostName)
    }

    func testRejectsBrokenOffers() throws {
        let kp = KeyPair.generate()
        let k = Base64URL.encode(kp.publicKey)
        let s = Base64URL.encode(randomBytes(32))
        let h = try Pleiad.hostIdFor(kp.publicKey)
        func sub(_ text: String) -> String? { do { _ = try PairingCodec.parse(text); return nil } catch let e as PairError { return e.detail } catch { return "?" } }
        XCTAssertEqual("notCode", sub("https://example.com"))
        XCTAssertEqual("unsupportedVersion", sub(offer(["v": "2", "r": "https://r.example", "h": h, "k": k, "s": s])))
        XCTAssertEqual("broken", sub(offer(["v": "1", "r": "https://r.example", "h": h, "k": "abc", "s": s])))
        XCTAssertEqual("hostIdMismatch", sub(offer(["v": "1", "r": "https://r.example", "h": "aaaaaaaaaaaaaaaaaaaaaaaaaa", "k": k, "s": s])))
        XCTAssertEqual("relay-httpsOnlyLoopback", sub(offer(["v": "1", "r": "http://r.example", "h": h, "k": k, "s": s])))
        XCTAssertEqual("broken", sub(offer(["v": "1", "h": h, "k": k, "s": s])))
    }

    func testRelayUrls() throws {
        XCTAssertEqual("https://relay.example/base", try PairingCodec.normalizeRelayUrl(" HTTPS://Relay.Example:443/base/ "))
        XCTAssertEqual("http://127.0.0.1:8787", try PairingCodec.normalizeRelayUrl("http://127.0.0.1:8787/"))
        XCTAssertEqual("http://[::1]:8787", try PairingCodec.normalizeRelayUrl("http://[::1]:8787"))
        XCTAssertEqual("wss://relay.example:8443", try PairingCodec.normalizeRelayUrl("wss://relay.example:8443"))
        XCTAssertEqual("", try PairingCodec.normalizeRelayUrl("  "))
        XCTAssertEqual("wss://relay.example/v1/device", try PairingCodec.relayWsUrl("https://relay.example", "/v1/device"))
        XCTAssertEqual("ws://127.0.0.1:8787/v1/device", try PairingCodec.relayWsUrl("http://127.0.0.1:8787", "/v1/device"))
        for (bad, sub) in [("ftp://relay.example", "httpsOnly"), ("http://relay.example", "httpsOnlyLoopback"),
                           ("https://u:p@relay.example", "noUserinfo"), ("https://relay.example/?a=1", "noQuery"),
                           ("https://relay.example/#x", "noQuery")] {
            XCTAssertThrowsError(try PairingCodec.normalizeRelayUrl(bad), bad) { XCTAssertEqual(($0 as? PairError)?.detail, sub, bad) }
        }
    }

    func testCleanLabel() {
        XCTAssertEqual("a b c", PairingCodec.cleanLabel("  a\n\tb\u{7}  c  "))
        XCTAssertEqual("机 の上", PairingCodec.cleanLabel("机\u{3000}\u{3000}の上"))
        XCTAssertEqual(String(repeating: "x", count: 64), PairingCodec.cleanLabel(String(repeating: "x", count: 100)))
        XCTAssertEqual("", PairingCodec.cleanLabel(nil))
    }
}
