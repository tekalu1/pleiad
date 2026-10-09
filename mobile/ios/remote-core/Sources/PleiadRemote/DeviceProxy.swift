import Foundation

// Swift port of core/remote/device-proxy.mjs and DeviceProxy.kt (docs/remote.md §7.1・§7.4・§8.3 option A, ADR 0144):
// one per host, listening on 127.0.0.1, carrying the WebView's HTTP and /ws over the DeviceLink channel. The UI is the
// host's web/ unchanged.
//
// Auth is the same shape as the host's server (so web/ needs no change):
//   - the WebView opens http://127.0.0.1:<p>/?token=<proxy token>; a matching ?token= gets an HttpOnly SameSite=Strict
//     cookie back, later css/js/images pass by cookie. /ws needs ?token= (web/client.mjs adds it).
//   - Host header must be 127.0.0.1:<p> (DNS rebinding) -> 403; no/wrong token -> 401
//   - HTTP GET and HEAD only (405 otherwise); WebSocket only on /ws
// The token is random per start and never sent to the host (?token= and the cookie are dropped here).
//
// Threads: one per local connection. It blocks on socket I/O and on a queue of events coming from the loop, so the
// loop never blocks. Credit (release) is returned after the bytes were written to the local socket (§4.3).
// The WebSocket's early host messages (WS_ACCEPT and `ready` arrive in the same read) are queued from the moment the
// stream is opened, so nothing is lost before the 101 is written (the ordering race from the desktop work).
// Every HTTP response is `Connection: close` (no keep-alive bookkeeping; loopback connections are cheap).
// With a staticCacheFile, the web/ shell is answered from the device's saved bundle once the host confirmed it on the
// page load (StaticCache.swift, docs/remote.md §8.6); auth, Host and method checks come first, as for any request.
//
// iOS: the system reclaims the listening socket while the app is suspended. The shell calls resumeForeground() when
// the app becomes active again: it listens on the same port (same origin, so web/'s localStorage and the cookie stay)
// and checks the link (DeviceLink.checkNow: PING, reconnect without a PONG in 3 s) (ADR 0144).

/// Strings the proxy shows (the app supplies them from its localization).
public protocol ProxyTexts {
    func locale() -> String
    func title(_ state: String) -> String
    func body(_ state: String) -> String
    func tokenRequired() -> String
    func lost() -> String
    /// The notice page's button back to the host list (shown only where the app provides window.backToHosts).
    func backToHosts() -> String
}

extension ProxyTexts {
    public func locale() -> String { "en" }
}

public struct DefaultTexts: ProxyTexts {
    public init() {}
    public func title(_ state: String) -> String { state == "revoked" ? "This device was revoked on the host" : "Can't reach the host" }
    public func body(_ state: String) -> String {
        switch state {
        case "revoked": return "Pair this device again."
        case "host-offline": return "Make sure Pleiad is running on the host. This page opens automatically once connected."
        default: return "Can't reach the relay. Check your network. This page opens automatically once connected."
        }
    }
    public func tokenRequired() -> String { "A token is required (open this from the app)" }
    public func lost() -> String { "Lost the connection to the host" }
    public func backToHosts() -> String { "Back to hosts" }
}

/// Writes to a socket through a buffer (BufferedOutputStream in the Kotlin port).
private final class Out {
    let socket: TcpSocket
    private var buf = Bytes()
    init(_ socket: TcpSocket) { self.socket = socket }
    func write(_ b: Bytes) throws {
        buf += b
        if buf.count >= 64 * 1024 { try flush() }
    }
    func write(_ s: String) throws { try write(Bytes(s.utf8)) }
    func flush() throws {
        if buf.isEmpty { return }
        let b = buf
        buf = []
        try socket.write(b)
    }
}

public final class DeviceProxy {
    public static let PROXY_COOKIE = "pleiad_remote_token"
    private static let WS_PAUSE_ABOVE = 256 * 1024
    private static let MAX_WS_MESSAGE = 64 * 1024 * 1024
    private static let STATIC_FETCH_MS = 120_000
    private static let PASS_REQUEST: Set<String> = [
        "accept", "accept-language", "accept-encoding", "cache-control", "pragma",
        "if-none-match", "if-modified-since", "if-range", "range", "user-agent",
    ]
    private static let DROP_RESPONSE: Set<String> = [
        "set-cookie", "set-cookie2", "connection", "keep-alive", "transfer-encoding", "upgrade",
        "proxy-authenticate", "proxy-connection", "te", "trailer",
    ]
    private static let REASONS: [Int: String] = [
        101: "Switching Protocols", 200: "OK", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently",
        302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
        405: "Method Not Allowed", 416: "Range Not Satisfiable", 500: "Internal Server Error", 502: "Bad Gateway",
        503: "Service Unavailable",
    ]

    public static func escapeHtml(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    public let loop: Loop
    public let link: DeviceLink
    private let wantPort: Int
    private let requestWaitMs: Int
    private let texts: ProxyTexts
    private let log: (String) -> Void
    public let token: String = Base64URL.encode(randomBytes(32))
    private let lock = NSLock()
    private var _port = 0
    private var _creds: HostCreds
    private var server: TcpListener?
    private var sockets: [ObjectIdentifier: TcpSocket] = [:]
    private var _closed = false
    public let staticCache: StaticCache?
    private var staticCheck: StaticCheck?

    /// One check of the saved shell; the requests that arrive meanwhile wait for the same answer.
    private final class StaticCheck {
        private let cond = NSCondition()
        private var done = false
        private var result: StaticBundle?
        func finish(_ b: StaticBundle?) { cond.lock(); result = b; done = true; cond.broadcast(); cond.unlock() }
        func wait(_ ms: Int) -> StaticBundle? {
            cond.lock(); defer { cond.unlock() }
            let deadline = Date(timeIntervalSinceNow: Double(ms) / 1000)
            while !done { if !cond.wait(until: deadline) { break } }
            return result
        }
    }

    public init(loop: Loop, creds: HostCreds, keyPair: KeyPair, wantPort: Int = 0, app: String = "", name: String = "",
                shell: String = "mobile", backoff: Backoff = Backoff(), connectTimeoutMs: Int = 15_000,
                requestWaitMs: Int = 10_000, texts: ProxyTexts = DefaultTexts(), log: @escaping (String) -> Void = { _ in },
                staticCacheFile: URL? = nil) {
        self.loop = loop
        self.link = DeviceLink(loop: loop, creds: creds, keyPair: keyPair, app: app, name: name, shell: shell, backoff: backoff,
                               connectTimeoutMs: connectTimeoutMs, log: log)
        self.wantPort = (1024...65535).contains(wantPort) ? wantPort : 0
        self.requestWaitMs = requestWaitMs
        self.texts = texts
        self.log = log
        self._creds = creds
        self.staticCache = staticCacheFile.map { StaticCache(file: $0, log: log) }
    }

    public var port: Int { lock.lock(); defer { lock.unlock() }; return _port }
    public var creds: HostCreds { lock.lock(); defer { lock.unlock() }; return _creds }
    public var closed: Bool { lock.lock(); defer { lock.unlock() }; return _closed }

    /// The URL the WebView opens (contains the token: never log it).
    public var url: String { "http://127.0.0.1:\(port)/?token=\(token)" }

    public func onStatus(_ fn: @escaping (LinkStatus) -> Void) { link.onStatus(fn) }

    private func listen(_ want: Int) throws -> TcpListener {
        do {
            return try TcpListener(port: want)
        } catch {
            if want == 0 { throw error }
            log("remote proxy: port \(want) unavailable (\(error))")
            return try TcpListener(port: 0)
        }
    }

    private func serve(_ ss: TcpListener) {
        lock.lock()
        server = ss
        _port = ss.port
        lock.unlock()
        spawn("pleiad-proxy-accept") { [weak self] in self?.acceptLoop(ss) }
    }

    /// Listen and start connecting. Blocking (binds the socket); call off the main thread.
    @discardableResult
    public func start() throws -> DeviceProxy {
        serve(try listen(wantPort))
        link.start()
        return self
    }

    /// Back in the foreground (iOS reclaims listening sockets of suspended apps): listen again on the same port and
    /// check the link (reconnect now when it is down or does not answer a PING). Returns true when the port had to change (the shell then reloads the WebView with `url`).
    @discardableResult
    public func resumeForeground() throws -> Bool {
        if closed { return false }
        let old = port
        lock.lock()
        let prev = server
        server = nil
        lock.unlock()
        prev?.close()
        serve(try listen(old))
        link.checkNow()
        return port != old
    }

    public func retryNow(_ newCreds: HostCreds? = nil) {
        if let newCreds {
            lock.lock(); _creds = newCreds; lock.unlock()
        }
        link.retryNow(newCreds)
    }

    public func close() {
        lock.lock()
        if _closed { lock.unlock(); return }
        _closed = true
        let s = server
        let open = Array(sockets.values)
        sockets = [:]
        lock.unlock()
        link.stop()
        s?.close()
        for c in open { c.close() }
    }

    private func acceptLoop(_ ss: TcpListener) {
        while !closed {
            guard let s = try? ss.accept() else { break }
            lock.lock()
            if _closed { lock.unlock(); s.close(); break }
            sockets[ObjectIdentifier(s)] = s
            lock.unlock()
            spawn("pleiad-proxy-conn") { [weak self] in
                self?.handle(s)
                self?.forget(s)
                s.close()
            }
        }
    }

    private func forget(_ s: TcpSocket) {
        lock.lock()
        sockets[ObjectIdentifier(s)] = nil
        lock.unlock()
    }

    // ── request parsing ──

    private struct Request {
        let method: String
        let target: String
        let headers: [String: String]
    }

    private func tokenEq(_ given: String?) -> Bool {
        guard let given else { return false }
        return constantTimeEqual(Bytes(given.utf8), Bytes(token.utf8))
    }

    private static func formDecode(_ s: Substring) -> String? {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    }

    private func tokenFromCookie(_ header: String?) -> String? {
        for part in (header ?? "").split(separator: ";") {
            let kv = part.trimmingCharacters(in: .whitespaces)
            guard let i = kv.firstIndex(of: "="), i != kv.startIndex else { continue }
            if kv[..<i] == DeviceProxy.PROXY_COOKIE { return DeviceProxy.formDecode(kv[kv.index(after: i)...]) }
        }
        return nil
    }

    /// Split the target into path and query params; returns (path, raw query without token, token).
    private func splitTarget(_ target: String) -> (String, String, String?)? {
        guard target.hasPrefix("/") else { return nil }
        let q = target.firstIndex(of: "?")
        let path = q.map { String(target[..<$0]) } ?? target
        let query = q.map { target[target.index(after: $0)...] } ?? ""
        var token: String?
        var kept: [Substring] = []
        for p in query.split(separator: "&") {
            let i = p.firstIndex(of: "=")
            guard let k = DeviceProxy.formDecode(i.map { p[..<$0] } ?? p) else { return nil }
            if k == "token" {
                if token == nil {
                    guard let v = DeviceProxy.formDecode(i.map { p[p.index(after: $0)...] } ?? "") else { return nil }
                    token = v
                }
            } else {
                kept.append(p)
            }
        }
        return (path, kept.joined(separator: "&"), token)
    }

    private func writeSimple(_ out: Out, _ status: Int, _ contentType: String?, _ body: Bytes, _ extra: [(String, String)] = []) {
        var head = "HTTP/1.1 \(status) \(DeviceProxy.REASONS[status] ?? "")\r\n"
        if let contentType { head += "Content-Type: \(contentType)\r\n" }
        for (k, v) in extra { head += "\(k): \(v)\r\n" }
        head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        try? out.write(head)
        try? out.write(body)
        try? out.flush()
    }

    public func unavailablePage(_ state: String) -> String {
        let revoked = state == "revoked"
        let title = texts.title(state)
        let body = texts.body(state)
        let hostName = creds.hostName
        let esc = DeviceProxy.escapeHtml
        return """
<!doctype html>
<html lang="\(esc(texts.locale()))"><head><meta charset="utf-8">\(revoked ? "" : "<meta http-equiv=\"refresh\" content=\"5\">")
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>\(esc(title))</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#333;background:#f6f6f4}
main{max-width:28rem;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#666}
button{margin-top:20px;padding:10px 16px;font:inherit;color:inherit;background:transparent;border:1px solid #9995;border-radius:8px}button[hidden]{display:none}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#1c1c1c}p{color:#aaa}}</style></head>
<body><main data-remote-state="\(esc(state))"><h1>\(esc(title))</h1><p>\(esc(body))</p>\(hostName.isEmpty ? "" : "<p>\(esc(hostName))</p>")<button type="button" id="back-to-hosts" hidden>\(esc(texts.backToHosts()))</button></main>
<script>/* the app's host window injects window.backToHosts; without it (a plain browser) the button stays hidden */
var b=document.getElementById('back-to-hosts');if(typeof window.backToHosts==='function'){b.hidden=false;b.onclick=function(){window.backToHosts()}}</script></body></html>

"""
    }

    private func unavailable(_ out: Out, _ req: Request, _ state: String, _ message: String?) {
        let wantsHtml = req.method == "GET" && (req.headers["accept"] ?? "").contains("text/html")
        let extra = [("Cache-Control", "no-store"), ("X-Pleiad-Remote-State", state)]
        if wantsHtml {
            writeSimple(out, 503, "text/html; charset=utf-8", Bytes(unavailablePage(state).utf8), extra)
        } else {
            writeSimple(out, 502, "text/plain; charset=utf-8", Bytes((message ?? texts.title("host-offline")).utf8), extra)
        }
    }

    // ── connection ──

    private enum Ev {
        case ready(Channel?, LinkUnavailable?)
        case opened(Stream?, Error?)
        case response(JSON)
        case data(Bytes, Release)
        case end
        case reset(Int)
        case accept
        case reject(Int)
        case message(Bytes, Bool, Release)
        case close(Int, String)
        case pong(Bytes)
        case localClose(Int, String)
        case localGone

        func release() {
            switch self {
            case .data(_, let r), .message(_, _, let r): r()
            default: break
            }
        }
    }

    private func handle(_ s: TcpSocket) {
        s.setReadTimeout(ms: 30_000)
        let input = SocketReader(s)
        let out = Out(s)
        guard let head = try? HttpHead.read(input) else { return }
        let req = Request(method: head.startLine[0].uppercased(), target: head.startLine[1], headers: head.headers)
        if req.headers["host"] != "127.0.0.1:\(port)" { return writeSimple(out, 403, "text/plain; charset=utf-8", Bytes("forbidden".utf8)) }
        guard let (path, restQuery, qToken) = splitTarget(req.target) else { return writeSimple(out, 400, nil, []) }
        let forwardPath = restQuery.isEmpty ? path : "\(path)?\(restQuery)"
        let isUpgrade = (req.headers["upgrade"] ?? "").lowercased() == "websocket"
        if isUpgrade {
            if path != "/ws" { return writeSimple(out, 404, nil, []) }
            if !tokenEq(qToken) { return writeSimple(out, 401, nil, []) }
            return handleWs(s, input, out, req, forwardPath)
        }
        let queryOk = tokenEq(qToken)
        if !queryOk && !tokenEq(tokenFromCookie(req.headers["cookie"])) {
            return writeSimple(out, 401, "text/plain; charset=utf-8", Bytes(texts.tokenRequired().utf8))
        }
        if req.method != "GET" && req.method != "HEAD" {
            return writeSimple(out, 405, "text/plain; charset=utf-8", Bytes("method not allowed".utf8), [("Allow", "GET, HEAD")])
        }
        handleHttp(s, out, req, path, restQuery, queryOk)
    }

    private func awaitChannel(_ q: BlockingQueue<Ev>) -> (Channel?, LinkUnavailable?) {
        link.ready(requestWaitMs) { ch, err in q.put(.ready(ch, err)) }
        if case .ready(let ch, let err)? = q.poll(requestWaitMs + 5_000) { return (ch, err) }
        return (nil, LinkUnavailable(state: "offline"))
    }

    /// One GET over the channel, read whole (blocking; for the static bundle).
    private func fetchOver(_ ch: Channel, _ path: String, _ headers: [String: String]) throws -> StaticFetch {
        let q = BlockingQueue<Ev>()
        let head: JSON = ["method": .string("GET"), "path": .string(path), "headers": .object(headers.mapValues { .string($0) })]
        loop.post {
            do {
                let st = try ch.openHttp(head)
                let l = StreamListener()
                l.onResponse = { q.put(.response($0)) }
                l.onData = { q.put(.data($0, $1)) }
                l.onEnd = { q.put(.end) }
                l.onReset = { code, _ in q.put(.reset(code)) }
                st.listener = l
                st.end()
                q.put(.opened(st, nil))
            } catch {
                q.put(.opened(nil, error))
            }
        }
        let deadline = Date(timeIntervalSinceNow: Double(DeviceProxy.STATIC_FETCH_MS) / 1000)
        func left() -> Int { max(1, Int(deadline.timeIntervalSinceNow * 1000)) }
        guard case .opened(let opened, let openErr)? = q.poll(left()) else { throw StateError(description: "static bundle: timeout") }
        guard let stream = opened else { throw openErr ?? StateError(description: "static bundle: cannot open") }
        var status = 0
        var got: [String: String] = [:]
        var body = Bytes()
        do {
            while true {
                guard deadline.timeIntervalSinceNow > 0, let ev = q.poll(left()) else { throw StateError(description: "static bundle: timeout") }
                switch ev {
                case .response(let h):
                    status = Int(h["status"]?.int ?? 0)
                    for (k, v) in h["headers"]?.object ?? [:] {
                        got[k.lowercased()] = v.array?.map { $0.text }.joined(separator: ", ") ?? v.text
                    }
                case .data(let chunk, let release):
                    defer { release() }
                    if body.count + chunk.count > StaticBundleCodec.MAX_BYTES { throw StateError(description: "static bundle: too large") }
                    body += chunk
                case .end:
                    return StaticFetch(status: status, headers: headers, body: body)
                case .reset(let code):
                    throw StateError(description: "static bundle: reset \(code)")
                default: break
                }
            }
        } catch {
            loop.post { if !stream.destroyed { stream.reset(ResetCode.CANCEL) } }
            for ev in q.drain() { ev.release() }
            throw error
        }
    }

    /// The bundle that may be served now, or nil. A page load always asks the host again; other requests share the last answer.
    private func localBundle(_ cache: StaticCache, _ ch: Channel, pageLoad: Bool) -> StaticBundle? {
        lock.lock()
        let check: StaticCheck
        var started = false
        if let c = staticCheck, !pageLoad {
            check = c
        } else {
            check = StaticCheck()
            staticCheck = check
            started = true
        }
        lock.unlock()
        if started {
            spawn("pleiad-proxy-static") { [weak self] in
                check.finish(cache.check { p, h in
                    guard let self else { throw StateError(description: "closed") }
                    return try self.fetchOver(ch, p, h)
                })
            }
        }
        return check.wait(DeviceProxy.STATIC_FETCH_MS + 5_000)
    }

    private func writeLocal(_ out: Out, _ req: Request, _ file: StaticFile, _ queryOk: Bool) {
        var text = "HTTP/1.1 200 OK\r\ncontent-type: \(file.type)\r\ncontent-length: \(file.body.count)\r\n"
        if queryOk { text += "set-cookie: \(DeviceProxy.PROXY_COOKIE)=\(token); HttpOnly; SameSite=Strict; Path=/\r\n" }
        text += "connection: close\r\n\r\n"
        try? out.write(text)
        if req.method != "HEAD" { try? out.write(file.body) }
        try? out.flush()
    }

    private func handleHttp(_ s: TcpSocket, _ out: Out, _ req: Request, _ path: String, _ restQuery: String, _ queryOk: Bool) {
        let forwardPath = restQuery.isEmpty ? path : "\(path)?\(restQuery)"
        let q = BlockingQueue<Ev>()
        let (readyCh, readyErr) = awaitChannel(q)
        guard let ch = readyCh else { return unavailable(out, req, readyErr?.state ?? "offline", nil) }
        if let cache = staticCache, restQuery.isEmpty {
            let pageLoad = path == "/" || path == "/index.html"
            if let file = localBundle(cache, ch, pageLoad: pageLoad)?.files[pageLoad ? "/index.html" : path] {
                return writeLocal(out, req, file, queryOk)
            }
        }
        var headers = [String: JSON]()
        for (k, v) in req.headers where DeviceProxy.PASS_REQUEST.contains(k) { headers[k] = .string(v) }
        let head: JSON = ["method": .string(req.method), "path": .string(forwardPath), "headers": .object(headers)]
        loop.post {
            do {
                let st = try ch.openHttp(head)
                let l = StreamListener()
                l.onResponse = { q.put(.response($0)) }
                l.onData = { q.put(.data($0, $1)) }
                l.onEnd = { q.put(.end) }
                l.onReset = { code, _ in q.put(.reset(code)) }
                st.listener = l
                st.end()
                q.put(.opened(st, nil))
            } catch {
                q.put(.opened(nil, error))
            }
        }
        guard case .opened(let opened, let openErr) = q.take() else { return }
        guard let stream = opened else { return unavailable(out, req, "offline", openErr.map { "\($0)" }) }
        var headersSent = false
        do {
            while true {
                guard let ev = q.poll(10 * 60 * 1000) else { break }
                switch ev {
                case .response(let h):
                    var status = Int(h["status"]?.int ?? 502)
                    if !(100...599).contains(status) { status = 502 }
                    var text = "HTTP/1.1 \(status) \(DeviceProxy.REASONS[status] ?? "")\r\n"
                    for (k, v) in h["headers"]?.object ?? [:] {
                        let key = k.lowercased()
                        if DeviceProxy.DROP_RESPONSE.contains(key) || key.hasPrefix("proxy-") { continue }
                        let values = v.array?.map { $0.text } ?? [v.text]
                        for value in values where !value.contains("\r") && !value.contains("\n") { text += "\(key): \(value)\r\n" }
                    }
                    if queryOk { text += "set-cookie: \(DeviceProxy.PROXY_COOKIE)=\(token); HttpOnly; SameSite=Strict; Path=/\r\n" }
                    text += "connection: close\r\n\r\n"
                    try out.write(text)
                    headersSent = true
                case .data(let chunk, let release):
                    defer { release() }
                    try out.write(chunk)
                    if q.isEmpty { try out.flush() }
                case .end:
                    try out.flush()
                    return
                case .reset(let code):
                    if headersSent { try? out.flush(); s.close(); return }
                    switch code {
                    case ResetCode.FORBIDDEN: return writeSimple(out, 403, "text/plain; charset=utf-8", Bytes("forbidden".utf8))
                    case ResetCode.CHANNEL_CLOSED: return unavailable(out, req, link.state == "connected" ? "offline" : link.state, texts.lost())
                    default: return writeSimple(out, 502, "text/plain; charset=utf-8", Bytes("bad gateway".utf8))
                    }
                default: break
                }
            }
        } catch {
            // The WebView cancelled the load: drop the stream too, and return the credit of anything still queued
            loop.post { if !stream.destroyed { stream.reset(ResetCode.CANCEL) } }
            for ev in q.drain() { ev.release() }
        }
    }

    private func handleWs(_ s: TcpSocket, _ input: SocketReader, _ out: Out, _ req: Request, _ forwardPath: String) {
        guard let key = req.headers["sec-websocket-key"], req.headers["sec-websocket-version"] == "13" else {
            return writeSimple(out, 400, nil, [])
        }
        let q = BlockingQueue<Ev>()
        guard let ch = awaitChannel(q).0 else { return writeSimple(out, 502, nil, []) }
        let protocols = (req.headers["sec-websocket-protocol"] ?? "").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let head: JSON = ["path": .string(forwardPath), "protocols": .array(protocols.map { .string($0) })]
        loop.post {
            do {
                let st = try ch.openWs(head)
                // From here on every host event is queued (early messages wait for the 101 below)
                let l = StreamListener()
                l.onAccept = { q.put(.accept) }
                l.onReject = { q.put(.reject($0)) }
                l.onMessage = { q.put(.message($0, $1, $2)) }
                l.onClose = { q.put(.close($0, $1)) }
                l.onReset = { code, _ in q.put(.reset(code)) }
                st.listener = l
                q.put(.opened(st, nil))
            } catch {
                q.put(.opened(nil, error))
            }
        }
        guard case .opened(let opened, _) = q.take(), let stream = opened else { return writeSimple(out, 502, nil, []) }
        // Wait for the host's answer; keep messages until then
        var early: [Ev] = []
        var outcome: Int?
        while outcome == nil {
            switch q.poll(requestWaitMs + 20_000) {
            case nil: outcome = 502
            case .accept?: outcome = 101
            case .reject(let status)?: outcome = status
            case .reset(let code)?: outcome = code == ResetCode.FORBIDDEN ? 403 : 502
            case let ev?: early.append(ev)
            }
        }
        if outcome != 101 {
            loop.post { if !stream.destroyed { stream.reset(ResetCode.CANCEL) } }
            for ev in early { ev.release() }
            return writeSimple(out, outcome!, nil, [])
        }
        var resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        resp += "Sec-WebSocket-Accept: \(Ws.acceptKey(key))\r\n"
        if let p = protocols.first { resp += "Sec-WebSocket-Protocol: \(p)\r\n" }
        resp += "\r\n"
        do {
            try out.write(resp)
            try out.flush()
        } catch {
            loop.post { if !stream.destroyed { stream.reset(ResetCode.CANCEL) } }
            for ev in early { ev.release() }
            return
        }
        s.setReadTimeout(ms: 0)
        // Put the early events back in front of the queue
        if !early.isEmpty { q.prepend(early) }
        bridge(s, input, out, stream, q)
    }

    /// The local WebSocket <-> the stream. This thread writes; a second thread reads the WebView's frames.
    private func bridge(_ s: TcpSocket, _ input: SocketReader, _ out: Out, _ stream: Stream, _ q: BlockingQueue<Ev>) {
        let inflight = NSCondition()
        var inflightBytes = 0
        var localClosed = false
        let loop = self.loop
        spawn("pleiad-proxy-ws-read") {
            var parts = Bytes()
            var msgOpcode = -1
            do {
                while true {
                    let f = try Ws.readFrame(input, maxPayload: DeviceProxy.MAX_WS_MESSAGE)
                    switch f.opcode {
                    case Ws.OP_PING: q.put(.pong(f.payload))
                    case Ws.OP_PONG: break
                    case Ws.OP_CLOSE:
                        let (code, reason) = Ws.parseClose(f.payload)
                        q.put(.localClose(code, reason))
                        return
                    case Ws.OP_TEXT, Ws.OP_BINARY, Ws.OP_CONT:
                        if f.opcode == Ws.OP_CONT {
                            if msgOpcode < 0 { throw Ws.ProtocolError(closeCode: 1002, description: "unexpected continuation") }
                        } else {
                            if msgOpcode >= 0 { throw Ws.ProtocolError(closeCode: 1002, description: "expected continuation") }
                            msgOpcode = f.opcode
                        }
                        if parts.count + f.payload.count > DeviceProxy.MAX_WS_MESSAGE { throw Ws.ProtocolError(closeCode: 1009, description: "message too large") }
                        parts += f.payload
                        if f.fin {
                            let data = parts
                            let text = msgOpcode == Ws.OP_TEXT
                            parts = []
                            msgOpcode = -1
                            inflight.lock(); inflightBytes += data.count; inflight.unlock()
                            loop.post {
                                let release = {
                                    inflight.lock(); inflightBytes -= data.count; inflight.broadcast(); inflight.unlock()
                                }
                                if stream.destroyed || stream.localDone { release(); return }
                                stream.send(data, text: text) { err in
                                    release()
                                    if err != nil { q.put(.localGone) }
                                }
                            }
                            // Back-pressure: stop reading the WebView while too much is in flight to the host
                            inflight.lock()
                            while inflightBytes > DeviceProxy.WS_PAUSE_ABOVE && !localClosed {
                                _ = inflight.wait(until: Date(timeIntervalSinceNow: 1))
                            }
                            inflight.unlock()
                        }
                    default: throw Ws.ProtocolError(closeCode: 1002, description: "unknown opcode")
                    }
                }
            } catch let e as Ws.ProtocolError {
                q.put(.localClose(e.closeCode, ""))
            } catch {
                q.put(.localGone)
            }
        }

        var sentClose = false
        defer {
            inflight.lock(); localClosed = true; inflight.broadcast(); inflight.unlock()
            s.close()
            // Credit for anything we'll never deliver
            for ev in q.drain() { ev.release() }
            // Late host messages after this point: release immediately, and release what got queued before the swap
            loop.post {
                if !stream.destroyed { stream.listener = StreamListener() }
                for ev in q.drain() { ev.release() }
            }
        }
        do {
            events: while true {
                let ev = q.take()
                switch ev {
                case .message(let data, let text, let release):
                    defer { release() }
                    if !sentClose {
                        try out.write(Ws.frame(text ? Ws.OP_TEXT : Ws.OP_BINARY, data))
                        if q.isEmpty { try out.flush() }
                    }
                case .pong(let payload):
                    if !sentClose { try out.write(Ws.frame(Ws.OP_PONG, payload)); try out.flush() }
                case .close(let c, let reason):
                    // The host closed: pass it on, answer the host, and end the local socket
                    let code = Ws.sendableCode(c)
                    if !sentClose { try out.write(Ws.frame(Ws.OP_CLOSE, Ws.closePayload(code, reason))); try out.flush(); sentClose = true }
                    loop.post { if !stream.destroyed { stream.close(code, reason) } }
                    break events
                case .localClose(let c, let reason):
                    // The WebView closed (or broke the protocol): echo the close, then tell the host
                    let code = Ws.sendableCode(c == 1005 ? 1000 : c)
                    if !sentClose { try? out.write(Ws.frame(Ws.OP_CLOSE, Ws.closePayload(code, ""))); try? out.flush(); sentClose = true }
                    loop.post { if !stream.destroyed { stream.close(code, reason) } }
                    break events
                case .reset:
                    break events        // channel lost / host dropped it: 1006 to the WebView (no close frame)
                case .localGone:
                    loop.post { if !stream.destroyed { stream.close(Ws.sendableCode(1006), "") } }
                    break events
                default:
                    break
                }
            }
        } catch {
            loop.post { if !stream.destroyed && !stream.localDone { stream.close(1000, "") } }
        }
    }
}
