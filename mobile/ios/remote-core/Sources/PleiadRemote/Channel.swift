import Foundation

// Swift port of core/remote/channel.mjs and Channel.kt (docs/remote.md §4): streams multiplexed over the encrypted
// channel with HTTP/2-style credit flow control. Everything here runs on one [Loop] (like Node's event loop in the JS
// version). Callbacks (StreamListener / ChannelListener) are invoked on the loop and must not block; downstream writes
// happen elsewhere and call `release()` when done (release may be called from any thread; it posts to the loop).

public enum ChannelConst {
    public static let STREAM_WINDOW = 256 * 1024
    public static let CHANNEL_WINDOW = 1024 * 1024
    public static let MAX_STREAMS = 64
    public static let PING_INTERVAL_MS = 20_000
    public static let PING_MISSES = 3
    public static let MAX_BUFFERED = 4 * 1024 * 1024
    public static let MAX_WS_MESSAGE = 64 * 1024 * 1024
    public static let MAX_WINDOW = (1 << 31) - 1
}

/// code: "protocol" | "version" | "decrypt" | "timeout" | "transport" | "closed" | a GOAWAY code.
public struct ChannelError: Error, CustomStringConvertible {
    public let code: String
    public let message: String
    public let remote: Bool
    public init(_ code: String, _ message: String? = nil, remote: Bool = false) {
        self.code = code
        self.message = message ?? code
        self.remote = remote
    }
    public var description: String { "\(code): \(message)" }
}

public struct StreamResetError: Error, CustomStringConvertible {
    public let code: Int
    public var description: String { "stream reset (\(code))" }
}

struct StateError: Error, CustomStringConvertible { let description: String }

public typealias Completion = (Error?) -> Void

/// Release callback: returns the flow-control credit for a delivered chunk. Callable once, from any thread.
public typealias Release = () -> Void

/// The receiving side's callbacks for one stream (defaults: release the credit, ignore the rest).
public final class StreamListener {
    public var onResponse: (JSON) -> Void = { _ in }
    public var onData: (Bytes, @escaping Release) -> Void = { _, release in release() }
    public var onEnd: () -> Void = {}
    public var onAccept: () -> Void = {}
    public var onReject: (Int) -> Void = { _ in }
    public var onMessage: (Bytes, Bool, @escaping Release) -> Void = { _, _, release in release() }
    public var onClose: (Int, String) -> Void = { _, _ in }
    public var onReset: (Int, Bool) -> Void = { _, _ in }
    public var onFinish: () -> Void = {}
    public init() {}
}

public final class ChannelListener {
    public var onHello: (JSON) -> Void = { _ in }
    /// Host side only. Return false to refuse (RESET REFUSED).
    public var onStream: (Stream) -> Bool = { _ in false }
    public var onGoaway: (String, String) -> Void = { _, _ in }
    public var onClose: (ChannelError?) -> Void = { _ in }
    public init() {}
}

public final class Stream {
    public let channel: Channel        // strong: a proxy thread may still hold the stream after the link dropped the channel
    public let id: UInt32
    public let kind: String            // "http" | "ws"
    public let request: JSON
    public let incoming: Bool
    public var listener = StreamListener()
    public internal(set) var response: JSON?
    public internal(set) var accepted = false
    var sendWindow: Int
    var recvWindow: Int
    public internal(set) var localDone = false
    public internal(set) var remoteDone = false
    public private(set) var destroyed = false
    public private(set) var resetCode: Int?
    private var queue: [Item] = []
    private var unreleased = 0
    let assembler: WsAssembler?

    private enum Kind { case ctl, data, ws }

    private final class Item {
        let kind: Kind
        let type: Int
        let payload: Bytes
        let after: (() -> Void)?
        let data: Bytes
        var off = 0
        let text: Bool
        let done: Completion
        init(_ kind: Kind, type: Int = 0, payload: Bytes = [], after: (() -> Void)? = nil, data: Bytes = [], text: Bool = false, done: @escaping Completion) {
            self.kind = kind
            self.type = type
            self.payload = payload
            self.after = after
            self.data = data
            self.text = text
            self.done = done
        }
    }

    init(_ channel: Channel, _ id: UInt32, _ kind: String, _ request: JSON, _ incoming: Bool) {
        self.channel = channel
        self.id = id
        self.kind = kind
        self.request = request
        self.incoming = incoming
        sendWindow = channel.streamWindow
        recvWindow = channel.streamWindow
        assembler = kind == "ws" ? WsAssembler(maxBytes: channel.maxWsMessage) : nil
    }

    public var closed: Bool { destroyed || (localDone && remoteDone) }

    // ── send (loop only) ──

    public func respond(_ head: JSON, done: @escaping Completion = { _ in }) {
        guard expect("http", incomingOnly: true, done) else { return }
        ctl(T.HTTP_RES, Frames.jsonEncode(head), nil, done)
    }

    public func write(_ data: Bytes, done: @escaping Completion = { _ in }) {
        guard expect("http", done) else { return }
        if localDone { return done(StateError(description: "this direction has already ended")) }
        enqueue(Item(.data, data: data, done: done))
    }

    public func end(done: @escaping Completion = { _ in }) {
        guard expect("http", done) else { return }
        if localDone { return done(nil) }
        ctl(T.END, [], { [weak self] in self?.localDone = true }, done)
        localDone = true
    }

    public func accept(done: @escaping Completion = { _ in }) {
        guard expect("ws", incomingOnly: true, done) else { return }
        ctl(T.WS_ACCEPT, [], nil, done)
    }

    public func reject(_ status: Int = 502, done: @escaping Completion = { _ in }) {
        guard expect("ws", incomingOnly: true, done) else { return }
        if localDone { return done(nil) }
        localDone = true
        remoteDone = true
        ctl(T.WS_REJECT, Frames.u16(status), nil, done)
    }

    public func send(_ data: Bytes, text: Bool, done: @escaping Completion = { _ in }) {
        guard expect("ws", done) else { return }
        if localDone { return done(StateError(description: "WebSocket is already closed")) }
        enqueue(Item(.ws, data: data, text: text, done: done))
    }

    public func close(_ code: Int = 1000, _ reason: String = "", done: @escaping Completion = { _ in }) {
        guard expect("ws", done) else { return }
        if localDone { return done(nil) }
        localDone = true
        ctl(T.WS_CLOSE, Frames.encodeWsClose(code, reason), nil, done)
    }

    public func reset(_ code: Int = ResetCode.CANCEL) {
        if destroyed { return }
        channel.sendNow(T.RESET, id, Frames.u16(code))
        destroy(code, remote: false)
    }

    private func expect(_ kind: String, incomingOnly: Bool = false, _ done: Completion) -> Bool {
        if self.kind != kind { done(StateError(description: "not available on a \(self.kind) stream")); return false }
        if incomingOnly && !incoming { done(StateError(description: "only the receiving side can use this")); return false }
        return true
    }

    private func ctl(_ type: Int, _ payload: Bytes, _ after: (() -> Void)?, _ done: @escaping Completion) {
        enqueue(Item(.ctl, type: type, payload: payload, after: after, done: done))
    }

    private func enqueue(_ item: Item) {
        if destroyed { return item.done(StreamResetError(code: resetCode ?? ResetCode.CHANNEL_CLOSED)) }
        queue.append(item)
        channel.pump()
    }

    /// Send the head of the queue if the windows allow.
    func sendOne() -> Bool {
        guard let item = queue.first, !destroyed else { return false }
        let ch = channel
        if item.kind == .ctl {
            ch.sendNow(item.type, id, item.payload)
            queue.removeFirst()
            item.after?()
            item.done(nil)
            maybeFinish()
            return true
        }
        let remaining = item.data.count - item.off
        let avail = min(sendWindow, ch.sendWindow)
        if item.kind == .data {
            if remaining == 0 { queue.removeFirst(); item.done(nil); return true }
            let n = min(Frames.CHUNK, remaining, avail)
            if n <= 0 { return false }
            let chunk = Bytes(item.data[item.off..<item.off + n])
            sendWindow -= n
            ch.sendWindow -= n
            item.off += n
            ch.sendNow(T.DATA, id, chunk)
        } else {
            // WS_MSG: the 1-byte flag counts against the window
            if avail < 1 { return false }
            let n = min(Frames.CHUNK, remaining, avail - 1)
            if n == 0 && remaining > 0 { return false }
            let fin = n == remaining
            let payload = Frames.encodeWsFragment(Bytes(item.data[item.off..<item.off + n]), text: item.text, fin: fin)
            sendWindow -= payload.count
            ch.sendWindow -= payload.count
            item.off += n
            ch.sendNow(T.WS_MSG, id, payload)
            if !fin { return true }
        }
        if item.off >= item.data.count { queue.removeFirst(); item.done(nil) }
        return true
    }

    // ── receive ──

    func releaser(_ n: Int) -> Release {
        unreleased += n
        let once = Once()
        // Holds the stream strongly (like the Kotlin closure): a finished stream is already forgotten by the channel, and
        // its late release must still return the channel's credit, or the channel window shrinks for good.
        return {
            guard once.fire() else { return }
            self.channel.loop.exec {
                guard !self.destroyed else { return }
                self.unreleased -= n
                self.channel.returnCredit(self, n)
            }
        }
    }

    func onFlow(_ n: Int) throws {
        if n > recvWindow { throw ChannelError("protocol", "stream \(id) exceeded its window") }
        recvWindow -= n
    }

    func destroy(_ code: Int, remote: Bool) {
        if destroyed { return }
        destroyed = true
        resetCode = code
        let err = StreamResetError(code: code)
        let items = queue
        queue = []
        for it in items { it.done(err) }
        if unreleased > 0 && !channel.closed { channel.returnCredit(nil, unreleased) }
        unreleased = 0
        channel.forget(self)
        listener.onReset(code, remote)
    }

    func rejectQueued(_ err: Error) {
        let items = queue
        queue = []
        for it in items { it.done(err) }
    }

    func maybeFinish() {
        if destroyed || !localDone || !remoteDone || !queue.isEmpty { return }
        channel.forget(self)
        listener.onFinish()
    }
}

/// Fires once, from any thread.
final class Once {
    private let lock = NSLock()
    private var done = false
    func fire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

public final class Channel {
    public let loop: Loop
    public let role: String                 // "device" | "host"
    private let sendFn: (Bytes) throws -> Void
    private let transport: Transport?
    private let hello: JSON
    let streamWindow: Int
    private let maxStreams: Int
    private let pingIntervalMs: Int
    private let pingMisses: Int
    private let bufferedAmount: (() -> Int)?
    private let maxBuffered: Int
    let maxWsMessage: Int

    public var listener = ChannelListener()
    var sendWindow: Int
    private var recvWindow: Int
    private var streams: [UInt32: Stream] = [:]
    private var order: [UInt32] = []        // stream ids in opening order (pump fairness, like a LinkedHashMap)
    private var nextId: UInt32
    private var lastPeerId: UInt32 = 0
    public private(set) var started = false
    public private(set) var peerHello: JSON?
    public private(set) var closed = false
    public private(set) var closeError: ChannelError?
    private var missedPings = 0
    private var pings: [String: (Error?) -> Void] = [:]
    private var pingTimer: Cancellable?
    private var retryTimer: Cancellable?
    private var pumping = false
    private var pumpAgain = false

    public init(loop: Loop, role: String, send: @escaping (Bytes) throws -> Void, transport: Transport? = nil, hello: JSON = [:],
                streamWindow: Int = ChannelConst.STREAM_WINDOW, channelWindow: Int = ChannelConst.CHANNEL_WINDOW,
                maxStreams: Int = ChannelConst.MAX_STREAMS, pingIntervalMs: Int = ChannelConst.PING_INTERVAL_MS,
                pingMisses: Int = ChannelConst.PING_MISSES, bufferedAmount: (() -> Int)? = nil,
                maxBuffered: Int = ChannelConst.MAX_BUFFERED, maxWsMessage: Int = ChannelConst.MAX_WS_MESSAGE) {
        precondition(role == "device" || role == "host", "role must be device or host")
        self.loop = loop
        self.role = role
        self.sendFn = send
        self.transport = transport
        self.hello = hello
        self.streamWindow = streamWindow
        self.sendWindow = channelWindow
        self.recvWindow = channelWindow
        self.maxStreams = maxStreams
        self.pingIntervalMs = pingIntervalMs
        self.pingMisses = pingMisses
        self.bufferedAmount = bufferedAmount
        self.maxBuffered = maxBuffered
        self.maxWsMessage = maxWsMessage
        self.nextId = role == "device" ? 1 : 2
    }

    public var streamCount: Int { streams.count }

    public func start() {
        if started { return }
        started = true
        sendNow(T.HELLO, 0, Frames.jsonEncode(hello.with("proto", .int(Frames.PROTO))))
        if pingIntervalMs > 0 { schedulePing() }
    }

    private func schedulePing() {
        pingTimer = loop.schedule(pingIntervalMs) { [weak self] in
            guard let self, !self.closed else { return }
            self.tick()
            if !self.closed { self.schedulePing() }
        }
    }

    public func openHttp(_ head: JSON) throws -> Stream { try open("http", T.HTTP_REQ, head) }
    public func openWs(_ head: JSON) throws -> Stream { try open("ws", T.WS_OPEN, head) }

    private func open(_ kind: String, _ type: Int, _ head: JSON) throws -> Stream {
        guard started else { throw StateError(description: "cannot open before start()") }
        if closed { throw ChannelError("closed", "channel is closed") }
        guard role == "device" else { throw StateError(description: "the host does not open streams") }
        if streams.count >= maxStreams { throw ChannelError("streams", "too many concurrent streams") }
        let payload = Frames.jsonEncode(head)
        if payload.count > Frames.MAX_PAYLOAD { throw FrameError("request head too large") }
        let id = nextId
        nextId &+= 2
        let s = Stream(self, id, kind, head, false)
        add(s)
        sendNow(type, id, payload)
        return s
    }

    public func ping(_ done: @escaping (Error?) -> Void = { _ in }) {
        if closed { return done(ChannelError("closed", "channel is closed")) }
        let data = randomBytes(8)
        pings[data.hexString] = done
        sendNow(T.PING, 0, data)
    }

    private func tick() {
        if missedPings >= pingMisses {
            close(ChannelError("timeout", "\(pingMisses) PINGs went unanswered"))
            return
        }
        missedPings += 1
        ping()
    }

    public func goaway(_ code: String, _ reason: String = "") {
        if closed { return }
        sendNow(T.GOAWAY, 0, Frames.jsonEncode(["code": .string(code), "reason": .string(reason)]))
        close(ChannelError(code, reason))
    }

    public func close(_ err: ChannelError? = nil) {
        if closed { return }
        closed = true
        closeError = err
        pingTimer?.cancel()
        retryTimer?.cancel()
        for id in order { streams[id]?.destroy(ResetCode.CHANNEL_CLOSED, remote: false) }
        let ps = Array(pings.values)
        pings = [:]
        for p in ps { p(err ?? ChannelError("closed", "channel closed")) }
        // Drop the listener after the last call: its closures usually capture this channel (no GC to break the cycle)
        let l = listener
        listener = ChannelListener()
        l.onClose(err)
    }

    // ── send (internal) ──

    func sendNow(_ type: Int, _ stream: UInt32, _ payload: Bytes) {
        if closed { return }
        let bytes: Bytes
        do {
            let frame = try Frames.encode(type, stream, payload)
            bytes = try transport?.encrypt(frame) ?? frame
        } catch {
            // NonceExhausted (2^32 messages) or a frame we cannot encode: close; the link reconnects (§3.2)
            close(ChannelError("transport", "\(error)"))
            return
        }
        do { try sendFn(bytes) } catch { close(ChannelError("transport", "\(error)")) }
    }

    /// Send what the windows allow, one frame per stream in turn. Also call when the transport drained.
    public func pump() {
        if closed { return }
        if pumping { pumpAgain = true; return }
        pumping = true
        defer { pumping = false }
        repeat {
            pumpAgain = false
            var progressed = true
            while progressed && !closed {
                progressed = false
                for id in order {
                    guard let s = streams[id] else { continue }
                    if outboundBlocked() { return }
                    if s.sendOne() { progressed = true }
                }
            }
        } while pumpAgain && !closed
    }

    private func outboundBlocked() -> Bool {
        guard let b = bufferedAmount else { return false }
        if b() <= maxBuffered { return false }
        if retryTimer == nil {
            retryTimer = loop.schedule(10) { [weak self] in
                self?.retryTimer = nil
                self?.pump()
            }
        }
        return true
    }

    func returnCredit(_ stream: Stream?, _ n: Int) {
        if n <= 0 || closed { return }
        if let s = stream, !s.destroyed, !s.remoteDone {
            s.recvWindow += n
            sendNow(T.WINDOW, s.id, Frames.u32(UInt32(n)))
        }
        recvWindow += n
        sendNow(T.WINDOW, 0, Frames.u32(UInt32(n)))
    }

    private func add(_ s: Stream) {
        streams[s.id] = s
        order.append(s.id)
    }

    func forget(_ stream: Stream) {
        if streams[stream.id] === stream {
            streams[stream.id] = nil
            order.removeAll { $0 == stream.id }
        }
    }

    // ── receive ──

    /// One message (ciphertext) from the transport. Loop only.
    public func receive(_ bytes: Bytes) {
        if closed { return }
        let frame: Bytes
        do {
            frame = try transport?.decrypt(bytes) ?? bytes
        } catch {
            close(ChannelError("decrypt", "\(error)"))
            return
        }
        do {
            try dispatch(try Frames.decode(frame))
        } catch let e as FrameError {
            goaway("protocol", e.description)
        } catch let e as ChannelError {
            if e.code == "protocol" { goaway("protocol", e.message) } else { close(e) }
        } catch {
            close(ChannelError("internal", "\(error)"))
        }
    }

    private func dispatch(_ f: Frame) throws {
        let type = f.type
        let id = f.stream
        let payload = f.payload
        if peerHello == nil && type != T.HELLO { throw ChannelError("protocol", "first frame is not HELLO") }
        switch type {
        case T.HELLO:
            if peerHello != nil { throw ChannelError("protocol", "duplicate HELLO") }
            let h = try Frames.jsonDecode(payload)
            peerHello = h
            if h["proto"] != .int(Frames.PROTO) {
                goaway("version", "unsupported proto \(h["proto"]?.text ?? "null")")
                return
            }
            listener.onHello(h)
            return
        case T.PING:
            if payload.count != 8 { throw FrameError("PING must be 8 bytes") }
            sendNow(T.PONG, 0, payload)
            return
        case T.PONG:
            missedPings = 0
            pings.removeValue(forKey: payload.hexString)?(nil)
            return
        case T.GOAWAY:
            let g = (try? Frames.jsonDecode(payload)) ?? ["code": "unknown"]
            let code = g["code"].map { $0 == .null ? "unknown" : $0.text } ?? "unknown"
            let reason = g["reason"].map { $0 == .null ? "" : $0.text } ?? ""
            listener.onGoaway(code, reason)
            close(ChannelError(code, reason, remote: true))
            return
        case T.WINDOW:
            let inc = Int(try Frames.readU32(payload))
            if inc == 0 { throw FrameError("WINDOW increment is 0") }
            if id == 0 {
                if sendWindow + inc > ChannelConst.MAX_WINDOW { throw FrameError("channel window overflow") }
                sendWindow += inc
            } else {
                guard let s = streams[id] else { try checkKnown(id); return }
                if s.sendWindow + inc > ChannelConst.MAX_WINDOW { throw FrameError("stream window overflow") }
                s.sendWindow += inc
            }
            pump()
            return
        case T.HTTP_REQ, T.WS_OPEN:
            try onOpen(type, id, payload)
            return
        default:
            break
        }

        let flow = (type == T.DATA || type == T.WS_MSG) ? payload.count : 0
        if flow > recvWindow { throw ChannelError("protocol", "channel window exceeded") }
        recvWindow -= flow
        guard let s = streams[id] else {
            try checkKnown(id)
            if flow > 0 { returnCredit(nil, flow) }
            return
        }
        if flow > 0 { try s.onFlow(flow) }

        switch type {
        case T.HTTP_RES:
            try need(s, "http", !s.incoming && s.response == nil)
            let head = try Frames.jsonDecode(payload)
            s.response = head
            s.listener.onResponse(head)
        case T.DATA:
            try need(s, "http", !s.remoteDone)
            s.listener.onData(payload, s.releaser(flow))
        case T.END:
            try need(s, "http", !s.remoteDone)
            s.remoteDone = true
            s.listener.onEnd()
            s.maybeFinish()
        case T.RESET:
            s.destroy(try Frames.readU16(payload), remote: true)
        case T.WS_ACCEPT:
            try need(s, "ws", !s.incoming && !s.accepted && !s.remoteDone)
            s.accepted = true
            s.listener.onAccept()
        case T.WS_REJECT:
            try need(s, "ws", !s.incoming && !s.accepted && !s.remoteDone)
            let status = try Frames.readU16(payload)
            s.remoteDone = true
            s.localDone = true
            s.rejectQueued(StateError(description: "WebSocket rejected (\(status))"))
            s.listener.onReject(status)
            s.maybeFinish()
        case T.WS_MSG:
            try need(s, "ws", !s.remoteDone && (s.incoming || s.accepted))
            let msg: WsAssembler.Message?
            do {
                msg = try s.assembler!.push(payload)
            } catch let e as FrameError where e.tooLarge {
                s.releaser(flow)()
                s.reset(ResetCode.TOO_LARGE)
                return
            }
            guard let msg else {
                // A middle fragment is now in the assembler (bounded by maxWsMessage): return its credit at once.
                s.releaser(flow)()
                return
            }
            s.listener.onMessage(msg.data, msg.text, s.releaser(flow))
        case T.WS_CLOSE:
            try need(s, "ws", !s.remoteDone)
            let (code, reason) = try Frames.decodeWsClose(payload)
            s.remoteDone = true
            s.listener.onClose(code, reason)
            s.maybeFinish()
        default:
            throw FrameError("\(T.NAMES[type] ?? "?") is not allowed here")
        }
    }

    private func need(_ s: Stream, _ kind: String, _ ok: Bool) throws {
        if s.kind != kind || !ok { throw ChannelError("protocol", "frame does not match stream \(s.id)") }
    }

    private func checkKnown(_ id: UInt32) throws {
        let mine = (id % 2 == 1) == (role == "device")
        if mine ? id >= nextId : id > lastPeerId { throw ChannelError("protocol", "stream \(id) is not open") }
    }

    private func onOpen(_ type: Int, _ id: UInt32, _ payload: Bytes) throws {
        if role != "host" { throw ChannelError("protocol", "devices do not accept streams") }
        if id % 2 != 1 || id <= lastPeerId { throw ChannelError("protocol", "invalid stream id \(id)") }
        lastPeerId = id
        let head = try Frames.jsonDecode(payload)
        if streams.count >= maxStreams { sendNow(T.RESET, id, Frames.u16(ResetCode.REFUSED)); return }
        let s = Stream(self, id, type == T.HTTP_REQ ? "http" : "ws", head, true)
        add(s)
        if !listener.onStream(s) {
            forget(s)
            sendNow(T.RESET, id, Frames.u16(ResetCode.REFUSED))
        }
    }
}
