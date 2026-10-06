import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The WebSocket to the relay (openRelaySocket in core/remote/device-link.mjs, RelaySocket.kt). Incoming messages are
// queued in order: next() takes one (blocking, for the handshake), drainTo() hands the queue and everything after it
// to a sink. Call drainTo() only after the consumer's listeners are attached (the ordering race found in the desktop
// work: message 2 of the handshake and the host's HELLO can arrive in the same read).
//
// Transport: URLSessionWebSocketTask on Apple platforms (TLS, the system's proxy and network settings). Elsewhere a
// small RFC 6455 client over a TCP socket, plain ws:// to 127.0.0.1 only: it exists so `swift test` can talk to the
// local Node relay on Windows / Linux (there is no app there).

public struct RelayClosed: Error, CustomStringConvertible {
    public let code: Int
    public let reason: String
    public var description: String { "relay connection closed (\(code))" }
}

public struct RelayTimeout: Error, CustomStringConvertible { public let description: String }

/// Result of the opening: open, an HTTP status before Upgrade, a close code, or an error.
public struct OpenResult: Equatable {
    public var open = false
    public var status: Int?
    public var closeCode: Int?
    public var error: String?
}

protocol RelayDriver: AnyObject {
    func start()
    func send(_ b: Bytes) -> Bool
    var bufferedAmount: Int { get }
    func close(code: Int)
    func terminate()
}

public final class RelaySocket {
    private let cond = NSCondition()
    private var inbox: [Bytes] = []
    private var sink: ((Bytes) -> Void)?
    private var closeListeners: [(RelayClosed) -> Void] = []
    private var closedValue: RelayClosed?
    private var openResult: OpenResult?
    private let openTimeoutMs: Int
    private var driver: RelayDriver!

    public init(url: String, headers: [String: String], openTimeoutMs: Int = 10_000) {
        self.openTimeoutMs = openTimeoutMs
        #if canImport(Darwin)
        if let u = URL(string: url) {
            driver = URLSessionRelayDriver(owner: self, url: u, headers: headers, openTimeoutMs: openTimeoutMs)
        } else {
            driver = FailedDriver()
            settleOpen(OpenResult(error: "invalid URL"))
            markClosed(1006, "")
        }
        #else
        driver = TcpRelayDriver(owner: self, url: url, headers: headers, openTimeoutMs: openTimeoutMs)
        #endif
        driver.start()
    }

    public var closed: RelayClosed? {
        cond.lock(); defer { cond.unlock() }
        return closedValue
    }

    // ── from the driver ──

    func settleOpen(_ r: OpenResult) {
        cond.lock()
        if openResult == nil { openResult = r }
        cond.broadcast()
        cond.unlock()
    }

    func deliver(_ b: Bytes) {
        cond.lock()
        guard let s = sink else {
            inbox.append(b)
            cond.broadcast()
            cond.unlock()
            return
        }
        cond.unlock()
        s(b)
    }

    func markClosed(_ code: Int, _ reason: String) {
        cond.lock()
        if closedValue != nil { cond.unlock(); return }
        let c = RelayClosed(code: code, reason: reason)
        closedValue = c
        let listeners = closeListeners
        closeListeners = []
        cond.broadcast()
        cond.unlock()
        settleOpen(OpenResult(closeCode: code))
        for l in listeners { l(c) }
    }

    // ── API ──

    /// Wait for the opening (blocking).
    public func awaitOpen() -> OpenResult {
        cond.lock()
        let deadline = Date(timeIntervalSinceNow: Double(openTimeoutMs + 1000) / 1000)
        while openResult == nil {
            if !cond.wait(until: deadline) { break }
        }
        if openResult == nil { openResult = OpenResult(error: "open timeout") }
        let r = openResult!
        cond.unlock()
        return r
    }

    /// The next message (blocking). Throws RelayClosed or RelayTimeout.
    public func next(_ ms: Int = 10_000) throws -> Bytes {
        cond.lock(); defer { cond.unlock() }
        let deadline = Date(timeIntervalSinceNow: Double(ms) / 1000)
        while true {
            if !inbox.isEmpty { return inbox.removeFirst() }
            if let c = closedValue { throw c }
            if !cond.wait(until: deadline), inbox.isEmpty, closedValue == nil { throw RelayTimeout(description: "no response from host") }
        }
    }

    /// From now on, messages go to fn in order (queued ones first, synchronously here).
    public func drainTo(_ fn: @escaping (Bytes) -> Void) {
        cond.lock()
        while !inbox.isEmpty { fn(inbox.removeFirst()) }
        sink = fn
        cond.unlock()
    }

    /// Called once when the socket is closed (immediately if it already is).
    public func onClose(_ fn: @escaping (RelayClosed) -> Void) {
        cond.lock()
        let now = closedValue
        if now == nil { closeListeners.append(fn) }
        cond.unlock()
        if let now { fn(now) }
    }

    public func send(_ b: Bytes) -> Bool { closed == nil && driver.send(b) }

    public func bufferedAmount() -> Int { driver.bufferedAmount }

    public func close(_ code: Int = 1000) { driver.close(code: code) }

    public func terminate() { driver.terminate() }
}

private final class FailedDriver: RelayDriver {
    func start() {}
    func send(_ b: Bytes) -> Bool { false }
    var bufferedAmount: Int { 0 }
    func close(code: Int) {}
    func terminate() {}
}

#if canImport(Darwin)
/// URLSessionWebSocketTask. Redirects are refused (like followRedirects: false in the Kotlin port); no cookies, no cache.
private final class URLSessionRelayDriver: NSObject, RelayDriver, URLSessionWebSocketDelegate {
    private weak var owner: RelaySocket?
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let lock = NSLock()
    private var pending = 0
    private var opened = false

    init(owner: RelaySocket, url: URL, headers: [String: String], openTimeoutMs: Int) {
        self.owner = owner
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        // The request timeout may also act as an idle timer on the open socket (a pairing waits minutes for approval
        // with nothing on the wire), so keep it long: awaitOpen() enforces the opening deadline itself.
        config.timeoutIntervalForRequest = 7 * 24 * 3600
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        // The session holds its delegate (this driver) until it is invalidated when the task ends.
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        var req = URLRequest(url: url, timeoutInterval: 7 * 24 * 3600)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        task = session.webSocketTask(with: req)
        task.maximumMessageSize = 1 << 20
    }

    func start() { task.resume() }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let m):
                switch m {
                case .data(let d): self.owner?.deliver(Bytes(d))
                case .string(let s): self.owner?.deliver(Bytes(s.utf8))
                @unknown default: break
                }
                self.receive()
            case .failure:
                // The close code (if any) is set by now; otherwise didCompleteWithError reports 1006
                let code = self.task.closeCode
                if code != .invalid { self.owner?.markClosed(code.rawValue, self.task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? "") }
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock(); opened = true; lock.unlock()
        owner?.settleOpen(OpenResult(open: true))
        receive()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        owner?.markClosed(closeCode.rawValue, reason.map { String(decoding: $0, as: UTF8.self) } ?? "")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let wasOpen = opened; lock.unlock()
        let code = self.task.closeCode
        // A close code (4401, 4404, …) settles the opening too: report it before any generic error
        if code != .invalid { owner?.markClosed(code.rawValue, self.task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? "") }
        if !wasOpen {
            if let r = task.response as? HTTPURLResponse, r.statusCode != 101 {
                owner?.settleOpen(OpenResult(status: r.statusCode))
            } else {
                owner?.settleOpen(OpenResult(error: error.map { "\($0)" } ?? "closed"))
            }
        }
        owner?.markClosed(1006, "")      // no-op when already closed above
        session.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func send(_ b: Bytes) -> Bool {
        lock.lock(); pending += b.count; lock.unlock()
        task.send(.data(Data(b))) { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); self.pending -= b.count; self.lock.unlock()
        }
        return true
    }

    var bufferedAmount: Int {
        lock.lock(); defer { lock.unlock() }
        return pending
    }

    func close(code: Int) {
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    }

    func terminate() { task.cancel() }
}
#endif

/// Plain ws:// to an IPv4 loopback relay over a TCP socket (tests off Apple platforms; see the header).
final class TcpRelayDriver: RelayDriver {
    private weak var owner: RelaySocket?
    private let url: String
    private let headers: [String: String]
    private let openTimeoutMs: Int
    private let writeLock = NSLock()
    private var socket: TcpSocket?
    private let stateLock = NSLock()
    private var terminated = false

    init(owner: RelaySocket, url: String, headers: [String: String], openTimeoutMs: Int) {
        self.owner = owner
        self.url = url
        self.headers = headers
        self.openTimeoutMs = openTimeoutMs
    }

    func start() {
        spawn("pleiad-relay-ws") { [self] in run() }
    }

    private func fail(_ r: OpenResult) {
        owner?.settleOpen(r)
        owner?.markClosed(1006, "")
    }

    private func run() {
        guard let comps = URLComponents(string: url), let scheme = comps.scheme?.lowercased(), let host = comps.host else {
            return fail(OpenResult(error: "invalid URL"))
        }
        guard scheme == "ws" || scheme == "http" else { return fail(OpenResult(error: "TLS is not available on this platform (tests only)")) }
        let port = UInt16(clamping: comps.port ?? 80)
        let sock: TcpSocket
        do { sock = try TcpSocket.connect(host: host, port: port) } catch { return fail(OpenResult(error: "\(error)")) }
        stateLock.lock()
        socket = sock
        let dead = terminated
        stateLock.unlock()
        if dead { sock.close(); return fail(OpenResult(error: "terminated")) }
        let input = SocketReader(sock)
        let key = Base64URL.encodeStandard(randomBytes(16))
        var path = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
        if let q = comps.percentEncodedQuery { path += "?\(q)" }
        var req = "GET \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        req += "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
        for (k, v) in headers { req += "\(k): \(v)\r\n" }
        req += "\r\n"
        do {
            sock.setReadTimeout(ms: openTimeoutMs)
            try write(Bytes(req.utf8))
            guard let head = try HttpHead.read(input) else { sock.close(); return fail(OpenResult(error: "no response")) }
            let status = Int(head.startLine[1]) ?? 0
            if status != 101 { sock.close(); return fail(OpenResult(status: status)) }
            guard head.headers["sec-websocket-accept"] == Ws.acceptKey(key) else { sock.close(); return fail(OpenResult(error: "bad accept key")) }
            sock.setReadTimeout(ms: 0)
        } catch {
            sock.close()
            return fail(OpenResult(error: "\(error)"))
        }
        owner?.settleOpen(OpenResult(open: true))
        readLoop(sock, input)
    }

    private func readLoop(_ sock: TcpSocket, _ input: SocketReader) {
        var parts = Bytes()
        var inMessage = false
        do {
            while true {
                let f = try Ws.readFrame(input, maxPayload: 16 * 1024 * 1024, expectMasked: false)
                switch f.opcode {
                case Ws.OP_PING: try write(Ws.frame(Ws.OP_PONG, f.payload, masked: true))
                case Ws.OP_PONG: break
                case Ws.OP_CLOSE:
                    let (code, reason) = Ws.parseClose(f.payload)
                    try? write(Ws.frame(Ws.OP_CLOSE, Ws.closePayload(Ws.sendableCode(code == 1005 ? 1000 : code), ""), masked: true))
                    sock.close()
                    owner?.markClosed(code, reason)
                    return
                case Ws.OP_TEXT, Ws.OP_BINARY, Ws.OP_CONT:
                    if f.opcode == Ws.OP_CONT { if !inMessage { throw Ws.ProtocolError(closeCode: 1002, description: "unexpected continuation") } }
                    else if inMessage { throw Ws.ProtocolError(closeCode: 1002, description: "expected continuation") }
                    inMessage = true
                    parts += f.payload
                    if f.fin {
                        let m = parts
                        parts = []
                        inMessage = false
                        owner?.deliver(m)
                    }
                default: throw Ws.ProtocolError(closeCode: 1002, description: "unknown opcode")
                }
            }
        } catch {
            sock.close()
            owner?.markClosed(1006, "")
        }
    }

    private func write(_ b: Bytes) throws {
        writeLock.lock(); defer { writeLock.unlock() }
        guard let s = socket else { throw SocketError(description: "not connected") }
        try s.write(b)
    }

    func send(_ b: Bytes) -> Bool {
        do { try write(Ws.frame(Ws.OP_BINARY, b, masked: true)); return true } catch { return false }
    }

    /// Writes are synchronous, so nothing is ever buffered here.
    var bufferedAmount: Int { 0 }

    func close(code: Int) {
        try? write(Ws.frame(Ws.OP_CLOSE, Ws.closePayload(Ws.sendableCode(code), ""), masked: true))
        // The relay answers with its close frame (the read loop ends); don't wait for it longer than a second.
        stateLock.lock()
        let s = socket
        stateLock.unlock()
        guard let s else { return terminate() }   // not connected yet: give up the attempt
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { s.close() }
    }

    func terminate() {
        stateLock.lock()
        terminated = true
        let s = socket
        stateLock.unlock()
        s?.close()
    }
}
