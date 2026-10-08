import Foundation
import XCTest
@testable import PleiadRemote

/// `node` on PATH (PLEIAD_NODE overrides), or nil.
func findNode() -> URL? {
    let env = ProcessInfo.processInfo.environment
    if let n = env["PLEIAD_NODE"], !n.isEmpty { return URL(fileURLWithPath: n) }
    #if os(Windows)
    let names = ["node.exe"]
    let sep: Character = ";"
    #else
    let names = ["node"]
    let sep: Character = ":"
    #endif
    let path = env.first { $0.key.uppercased() == "PATH" }?.value ?? ""
    for dir in path.split(separator: sep) where !dir.isEmpty {
        for n in names {
            let u = URL(fileURLWithPath: String(dir)).appendingPathComponent(n)
            if FileManager.default.isExecutableFile(atPath: u.path) { return u }
        }
    }
    return nil
}

/// Reads a pipe line by line on its own thread.
final class LineReader {
    init(_ handle: FileHandle, _ onLine: @escaping (String) -> Void) {
        spawn("test-line-reader") {
            var buf = Bytes()
            while true {
                let d = handle.availableData
                if d.isEmpty { break }
                buf += d
                while let i = buf.firstIndex(of: 0x0a) {
                    onLine(Bytes(buf[..<i]).utf8String.trimmingCharacters(in: .whitespacesAndNewlines))
                    buf.removeFirst(i + 1)
                }
            }
        }
    }
}

/// A minimal WebSocket client for the proxy's /ws (text messages), on the package's own socket and framing code.
final class TestWsClient {
    let socket: TcpSocket
    let messages = BlockingQueue<String>()

    init(port: Int, path: String) throws {
        socket = try TcpSocket.connect(host: "127.0.0.1", port: UInt16(port))
        let key = Base64URL.encodeStandard(randomBytes(16))
        try socket.write(Bytes(("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n").utf8))
        let input = SocketReader(socket)
        guard let head = try HttpHead.read(input), head.startLine[1] == "101" else { throw SocketError(description: "no 101") }
        guard head.headers["sec-websocket-accept"] == Ws.acceptKey(key) else { throw SocketError(description: "bad accept") }
        let messages = self.messages
        spawn("test-ws-read") {
            var parts = Bytes()
            while let f = try? Ws.readFrame(input, maxPayload: 64 << 20, expectMasked: false) {
                if f.opcode == Ws.OP_CLOSE { break }
                if f.opcode == Ws.OP_TEXT || f.opcode == Ws.OP_CONT {
                    parts += f.payload
                    if f.fin { messages.put(parts.utf8String); parts = [] }
                }
            }
            messages.put("<closed>")
        }
    }

    func send(_ text: String) throws { try socket.write(Ws.frame(Ws.OP_TEXT, Bytes(text.utf8), masked: true)) }

    func close() {
        try? socket.write(Ws.frame(Ws.OP_CLOSE, Ws.closePayload(1000, ""), masked: true))
        socket.close()
    }
}

/// Cross-implementation test: the Swift device against the real Node relay (relay/server.mjs) and a fake-backend host
/// (core/server.mjs), started by mobile/scripts/fake-host.mjs — the same scenario as InteropTest.kt. No LLM, no network
/// beyond 127.0.0.1. Skipped when node is not on PATH (fails instead with PLEIAD_INTEROP=on) or PLEIAD_INTEROP=off.
/// Needs the root `npm ci`.
final class InteropTests: XCTestCase {
    private static var proc: Process?
    private static var stdin: FileHandle?
    private static let lines = BlockingQueue<JSON>()
    private static var offer = ""
    private static var dir: URL?
    private static var device: RemoteDevice?
    private static var skipReason: String?
    private static var setupError: String?

    private static func event(_ name: String, _ ms: Int = 60_000) throws -> JSON {
        let end = Date(timeIntervalSinceNow: Double(ms) / 1000)
        while true {
            let left = Int(end.timeIntervalSinceNow * 1000)
            if left <= 0 { throw StateError(description: "no '\(name)' from fake-host") }
            guard let o = lines.poll(left) else { continue }
            if o["event"]?.string == name { return o }
            if o["event"]?.string == "error" { throw StateError(description: o.serialized) }
        }
    }

    private static func send(_ cmd: String) {
        stdin?.write(Data("\(cmd)\n".utf8))
    }

    override class func setUp() {
        let mode = ProcessInfo.processInfo.environment["PLEIAD_INTEROP"] ?? "auto"
        if mode == "off" { skipReason = "PLEIAD_INTEROP=off"; return }
        guard let node = findNode() else {
            // PLEIAD_INTEROP=on (CI): a missing node is a failure, not a skip
            if mode == "on" { setupError = "node not found on PATH" } else { skipReason = "node not available" }
            return
        }
        let repo = repoRoot()
        let p = Process()
        p.executableURL = node
        p.arguments = [repo.appendingPathComponent("mobile/scripts/fake-host.mjs").path, "--auto-approve"]
        p.currentDirectoryURL = repo
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { skipReason = "node not available: \(error)"; return }
        proc = p
        stdin = inPipe.fileHandleForWriting
        _ = LineReader(outPipe.fileHandleForReading) { l in
            if let o = try? JSON.parse(l), o.object != nil { lines.put(o) }
        }
        _ = LineReader(errPipe.fileHandleForReading) { _ in }
        do {
            _ = try event("ready", 120_000)
            offer = try event("offer")["payload"]?.string ?? ""
            let d = FileManager.default.temporaryDirectory.appendingPathComponent("pleiad-swift-device-\(UUID().uuidString)")
            dir = d
            device = RemoteDevice(store: try DeviceStore(dir: d), app: "swift-test", name: "swift-pad",
                                  backoff: Backoff(minMs: 200, maxMs: 1000, stableMs: 1000), connectTimeoutMs: 5000, requestWaitMs: 5000)
        } catch {
            setupError = "\(error)"
        }
    }

    override class func tearDown() {
        device?.closeAll()
        if let p = proc {
            send("quit")
            let end = Date(timeIntervalSinceNow: 15)
            while p.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.1) }
            if p.isRunning { p.terminate() }
        }
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    override func setUpWithError() throws {
        if let r = InteropTests.skipReason { throw XCTSkip(r) }
        if let e = InteropTests.setupError { XCTFail("fake-host: \(e)"); throw XCTSkip("fake-host did not start") }
    }

    private struct Got {
        let status: Int
        let headers: [String: String]
        let body: Bytes
    }

    /// Raw socket so we control the Host header.
    private func get(_ port: Int, _ path: String, host: String? = nil, headers: [(String, String)] = [], method: String = "GET") throws -> Got {
        let s = try TcpSocket.connect(host: "127.0.0.1", port: UInt16(port))
        defer { s.close() }
        s.setReadTimeout(ms: 15_000)
        var req = "\(method) \(path) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\n"
        for (k, v) in headers { req += "\(k): \(v)\r\n" }
        req += "\r\n"
        try s.write(Bytes(req.utf8))
        let input = SocketReader(s)
        guard let head = try HttpHead.read(input) else { throw SocketError(description: "no response") }
        var body = Bytes()
        while let b = try input.readByte() { body.append(b) }
        return Got(status: Int(head.startLine[1]) ?? 0, headers: head.headers, body: body)
    }

    private func waitState(_ device: RemoteDevice, _ hostId: String, _ want: String, _ ms: Int = 15_000) {
        let end = Date(timeIntervalSinceNow: Double(ms) / 1000)
        while Date() < end {
            if device.proxy(hostId)?.link.state == want { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        XCTFail("state \(want) not reached (now \(device.proxy(hostId)?.link.state ?? "none"))")
    }

    func testPairOpenProxyWsResumeAndRevoke() throws {
        let device = InteropTests.device!
        // ---- pairing (auto-approved by the host; the code matches the host's)
        let shown = Box<String?>(nil)
        let rec = try device.pair(InteropTests.offer, onCode: { shown.value = $0 })
        let req = try InteropTests.event("request")
        XCTAssertEqual(req["code"]?.string, shown.value, "the device shows the host's confirmation code")
        XCTAssertEqual("ios", req["platform"]?.string)
        XCTAssertEqual("swift-pad", req["name"]?.string)
        XCTAssertEqual("fake-host", rec.hostName)
        let creds = try XCTUnwrap(try device.store.credentials(rec.hostId))
        let hostsJson = try String(contentsOf: InteropTests.dir!.appendingPathComponent("hosts.json"), encoding: .utf8)
        XCTAssertFalse(hostsJson.contains(creds.token), "hosts.json has no token")

        // ---- open the proxy
        let px = try device.open(rec.hostId)
        waitState(device, rec.hostId, "connected")
        XCTAssertEqual("fake-host", px.link.status.hostName)
        let port = px.port
        XCTAssertEqual(port, try device.store.host(rec.hostId)?.port)

        // auth and firewall of the local proxy
        XCTAssertEqual(401, try get(port, "/").status)
        XCTAssertEqual(403, try get(port, "/?token=\(px.token)", host: "evil.example:\(port)").status)
        XCTAssertEqual(405, try get(port, "/?token=\(px.token)", method: "POST").status)
        let page = try get(port, "/?token=\(px.token)", headers: [("Accept", "text/html")])
        XCTAssertEqual(200, page.status)
        XCTAssertTrue(page.body.utf8String.contains("<html"), "index.html of the host")
        let setCookie = try XCTUnwrap(page.headers["set-cookie"])
        XCTAssertTrue(setCookie.hasPrefix("\(DeviceProxy.PROXY_COOKIE)="), "proxy cookie set")
        XCTAssertFalse(page.body.utf8String.contains("agent_host_token="), "the host's cookie never reaches the device")
        let cookie = String(setCookie.split(separator: ";")[0])
        let js = try get(port, "/client.mjs", headers: [("Cookie", cookie)])
        XCTAssertEqual(200, js.status)
        XCTAssertGreaterThan(js.body.count, 1000)
        XCTAssertEqual(403, try get(port, "/mcp/agents", headers: [("Cookie", cookie)]).status, "the host's internal MCP routes are blocked")

        // ---- /ws through the proxy: `ready` arrives (early message kept), then a command round trip
        let ws = try TestWsClient(port: port, path: "/ws?token=\(px.token)")
        func nextMsg(_ pred: (JSON) -> Bool) throws -> JSON {
            let end = Date(timeIntervalSinceNow: 15)
            while Date() < end {
                guard let m = ws.messages.poll(500) else { continue }
                if m == "<closed>" { throw StateError(description: "the proxy closed the WebSocket") }
                if let o = try? JSON.parse(m), pred(o) { return o }
            }
            throw StateError(description: "message not received")
        }
        XCTAssertEqual("ready", try nextMsg { $0["kind"]?.string == "ready" }["kind"]?.string)
        // a large message (loadSession-sized) passes the 60 KiB fragmentation both ways: the draft text goes up in one
        // command (saveDraft takes up to 2 MB of text) and comes back in one response (loadSession returns the draft).
        @discardableResult
        func command(_ id: String, _ name: String, _ args: JSON) throws -> JSON {
            try ws.send((["kind": "command", "command": .string(name), "id": .string(id), "args": args] as JSON).serialized)
            let r = try nextMsg { $0["kind"]?.string == "response" && $0["id"]?.string == id }
            XCTAssertEqual(r["ok"], .bool(true), String("\(name): \(r.serialized)".prefix(300)))
            return r
        }
        try command("k1", "listSessions", [:])
        let sessionId = try XCTUnwrap(try command("k2", "newSession", ["backend": "fake", "cwd": .string(repoRoot().path)])["result"]?["sessionId"]?.string)
        let bigText = String(repeating: "x", count: 900_000)
        try command("k3", "saveDraft", ["sessionId": .string(sessionId), "text": .string(bigText)])
        let loaded = try command("k4", "loadSession", ["sessionId": .string(sessionId)])
        XCTAssertEqual(bigText.count, loaded["result"]?["draft"]?["text"]?.string?.count, "the large draft comes back whole")
        ws.close()

        // ---- back from the background (iOS reclaims the listener): same port, reconnects, the cookie still works
        XCTAssertFalse(try px.resumeForeground(), "the proxy keeps its port (and so its origin)")
        XCTAssertEqual(port, px.port)
        waitState(device, rec.hostId, "connected")
        XCTAssertEqual(200, try get(port, "/client.mjs", headers: [("Cookie", cookie)]).status)

        // ---- revoke on the host: state revoked, the page shows the revoked notice
        InteropTests.send("revoke \(rec.deviceId)")
        _ = try InteropTests.event("revoked")
        waitState(device, rec.hostId, "revoked")
        let gone = try get(port, "/", headers: [("Cookie", cookie), ("Accept", "text/html")])
        XCTAssertEqual(503, gone.status)
        XCTAssertTrue(gone.body.utf8String.contains("data-remote-state=\"revoked\""))
        XCTAssertNotNil(try device.store.host(rec.hostId)?.revokedAt)
    }

    /// cleanLabel and normalizeRelayUrl give the same results as core/remote/pairing.mjs for the same inputs.
    func testPairingRulesMatchNode() throws {
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: repoRoot().appendingPathComponent("tests/remote/vectors.json"))) as! [String: Any]
        let pairing = (vectors["pleiad"] as! [String: Any])["pairing"] as! [String: Any]
        let labels = (pairing["cleanLabels"] as! [[String: String]]).compactMap { $0["input"] }
        let relays: [String] = [" HTTPS://Relay.Example:443/base/ ", "http://127.0.0.1:8787/", "http://[::1]:8787", "wss://relay.example:8443",
                                "http://relay.example", "ftp://relay.example", "https://u:p@relay.example", "https://relay.example/?a=1",
                                "https://relay.example/?", "https://relay.example/#", "https://relay.example//", ""]
        let input: JSON = ["labels": .array(labels.map { .string($0) }), "relays": .array(relays.map { .string($0) })]
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("pleiad-parity-\(UUID().uuidString).json")
        try Data(input.data).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let module = repoRoot().appendingPathComponent("core/remote/pairing.mjs")
        let script = """
        import fs from 'node:fs';
        import { pathToFileURL } from 'node:url';
        const { cleanLabel, normalizeRelayUrl } = await import(pathToFileURL(process.argv[1]).href);
        const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
        const relay = r => { try { return normalizeRelayUrl(r); } catch { return null; } };
        process.stdout.write(JSON.stringify({ labels: input.labels.map(s => cleanLabel(s)), relays: input.relays.map(relay) }));
        """
        let p = Process()
        p.executableURL = try XCTUnwrap(findNode())
        p.arguments = ["--input-type=module", "-e", script, module.path, tmp.path]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let node = try JSON.parse(Bytes(data))
        for (i, s) in labels.enumerated() {
            XCTAssertEqual(node["labels"]?.array?[i].string, PairingCodec.cleanLabel(s), "cleanLabel #\(i)")
        }
        for (i, r) in relays.enumerated() {
            let mine = try? PairingCodec.normalizeRelayUrl(r)
            XCTAssertEqual(node["relays"]?.array?[i].string, mine, "normalizeRelayUrl \(r)")
        }
    }
}
