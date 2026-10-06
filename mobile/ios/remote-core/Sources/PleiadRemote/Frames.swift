// Swift port of core/remote/frames.mjs and Frames.kt (docs/remote.md §4.1).
//   type (u8) | stream (u32, BE) | payload
// One frame = one Noise message = one binary WebSocket message to the relay.

public enum T {
    public static let HELLO = 0x01
    public static let PING = 0x02
    public static let PONG = 0x03
    public static let GOAWAY = 0x04
    public static let HTTP_REQ = 0x10
    public static let HTTP_RES = 0x11
    public static let DATA = 0x12
    public static let END = 0x13
    public static let RESET = 0x14
    public static let WS_OPEN = 0x20
    public static let WS_ACCEPT = 0x21
    public static let WS_REJECT = 0x22
    public static let WS_MSG = 0x23
    public static let WS_CLOSE = 0x24
    public static let WINDOW = 0x30

    public static let NAMES: [Int: String] = [
        HELLO: "HELLO", PING: "PING", PONG: "PONG", GOAWAY: "GOAWAY",
        HTTP_REQ: "HTTP_REQ", HTTP_RES: "HTTP_RES", DATA: "DATA", END: "END", RESET: "RESET",
        WS_OPEN: "WS_OPEN", WS_ACCEPT: "WS_ACCEPT", WS_REJECT: "WS_REJECT", WS_MSG: "WS_MSG", WS_CLOSE: "WS_CLOSE",
        WINDOW: "WINDOW",
    ]
    static let CHANNEL_ONLY: Set<Int> = [HELLO, PING, PONG, GOAWAY]
}

public enum ResetCode {
    public static let CANCEL = 0
    public static let PROTOCOL = 1
    public static let REFUSED = 2
    public static let FORBIDDEN = 3
    public static let INTERNAL = 4
    public static let FLOW_CONTROL = 5
    public static let CHANNEL_CLOSED = 6
    public static let TOO_LARGE = 7
}

public struct FrameError: Error, CustomStringConvertible {
    public let description: String
    public var tooLarge = false
    init(_ message: String, tooLarge: Bool = false) {
        description = message
        self.tooLarge = tooLarge
    }
}

public struct Frame {
    public let type: Int
    public let stream: UInt32
    public let payload: Bytes
}

public enum Frames {
    public static let HEADER_BYTES = 5
    public static let MAX_FRAME = NoiseConst.MAX_PLAINTEXT
    public static let MAX_PAYLOAD = MAX_FRAME - HEADER_BYTES
    public static let CHUNK = 60 * 1024
    public static let PROTO: Int64 = 1
    public static let WS_TEXT: UInt8 = 0x01
    public static let WS_FIN: UInt8 = 0x02

    public static func encode(_ type: Int, _ stream: UInt32, _ payload: Bytes = []) throws -> Bytes {
        guard T.NAMES[type] != nil else { throw FrameError("unknown type: \(type)") }
        guard payload.count <= MAX_PAYLOAD else { throw FrameError("payload too large (\(payload.count) > \(MAX_PAYLOAD))") }
        var out = Bytes()
        out.reserveCapacity(HEADER_BYTES + payload.count)
        out.append(UInt8(type))
        out += u32(stream)
        out += payload
        return out
    }

    public static func decode(_ buf: Bytes) throws -> Frame {
        guard buf.count >= HEADER_BYTES else { throw FrameError("frame too short") }
        guard buf.count <= MAX_FRAME else { throw FrameError("frame too large") }
        let type = Int(buf[0])
        let stream = UInt32(buf[1]) << 24 | UInt32(buf[2]) << 16 | UInt32(buf[3]) << 8 | UInt32(buf[4])
        guard let name = T.NAMES[type] else { throw FrameError("unknown type: 0x\(String(type, radix: 16))") }
        if T.CHANNEL_ONLY.contains(type) && stream != 0 { throw FrameError("\(name) is only allowed on stream 0") }
        if !T.CHANNEL_ONLY.contains(type) && type != T.WINDOW && stream == 0 { throw FrameError("\(name) is not allowed on stream 0") }
        return Frame(type: type, stream: stream, payload: Bytes(buf[HEADER_BYTES...]))
    }

    public static func jsonEncode(_ v: JSON) -> Bytes { v.data }

    /// A JSON object (anything else is a FrameError, like org.json's JSONObject constructor).
    public static func jsonDecode(_ buf: Bytes) throws -> JSON {
        guard let v = try? JSON.parse(buf), case .object = v else { throw FrameError("invalid JSON") }
        return v
    }

    public static func u16(_ n: Int) -> Bytes { [UInt8(truncatingIfNeeded: n >> 8), UInt8(truncatingIfNeeded: n)] }

    public static func readU16(_ b: Bytes) throws -> Int {
        guard b.count == 2 else { throw FrameError("bad u16 length") }
        return Int(b[0]) << 8 | Int(b[1])
    }

    public static func u32(_ n: UInt32) -> Bytes {
        [UInt8(truncatingIfNeeded: n >> 24), UInt8(truncatingIfNeeded: n >> 16), UInt8(truncatingIfNeeded: n >> 8), UInt8(truncatingIfNeeded: n)]
    }

    public static func readU32(_ b: Bytes) throws -> UInt32 {
        guard b.count == 4 else { throw FrameError("bad u32 length") }
        return UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3])
    }

    public static func encodeWsClose(_ code: Int = 1000, _ reason: String = "") -> Bytes {
        var r = Bytes(reason.utf8)
        if r.count > 123 { r = Bytes(r[..<123]) }
        return u16(code) + r
    }

    public static func decodeWsClose(_ b: Bytes) throws -> (Int, String) {
        guard b.count >= 2 else { throw FrameError("WS_CLOSE too short") }
        return (try readU16(Bytes(b[..<2])), Bytes(b[2...]).utf8String)
    }

    public static func encodeWsFragment(_ chunk: Bytes, text: Bool, fin: Bool) -> Bytes {
        [(text ? WS_TEXT : 0) | (fin ? WS_FIN : 0)] + chunk
    }

    public struct WsFragment {
        public let text: Bool
        public let fin: Bool
        public let data: Bytes
    }

    public static func decodeWsFragment(_ b: Bytes) throws -> WsFragment {
        guard let flags = b.first else { throw FrameError("WS_MSG too short") }
        if flags & ~(WS_TEXT | WS_FIN) != 0 { throw FrameError("unknown WS_MSG flag bits") }
        return WsFragment(text: flags & WS_TEXT != 0, fin: flags & WS_FIN != 0, data: Bytes(b[1...]))
    }
}

/// Reassembles WS_MSG fragments. Exceeding maxBytes throws FrameError(tooLarge: true) (RESET TOO_LARGE).
public final class WsAssembler {
    private let maxBytes: Int
    private var parts = Bytes()
    private var text: Bool?

    public init(maxBytes: Int = 64 * 1024 * 1024) { self.maxBytes = maxBytes }

    public struct Message {
        public let data: Bytes
        public let text: Bool
    }

    public func push(_ payload: Bytes) throws -> Message? {
        let f = try Frames.decodeWsFragment(payload)
        if let t = text {
            if t != f.text { throw FrameError("WS_MSG switched between text and binary mid-message") }
        } else {
            text = f.text
        }
        if parts.count + f.data.count > maxBytes { throw FrameError("WebSocket message exceeds the limit", tooLarge: true) }
        parts += f.data
        if !f.fin { return nil }
        let msg = Message(data: parts, text: text!)
        parts = []
        text = nil
        return msg
    }
}
