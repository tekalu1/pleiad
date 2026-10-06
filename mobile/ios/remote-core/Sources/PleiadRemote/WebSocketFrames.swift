import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Minimal RFC 6455 framing: the server side for the loopback proxy (the WebView is the only client), and the client
/// side for the portable relay socket (RelaySocket off Apple platforms) and the tests.
enum Ws {
    static let OP_CONT = 0x0
    static let OP_TEXT = 0x1
    static let OP_BINARY = 0x2
    static let OP_CLOSE = 0x8
    static let OP_PING = 0x9
    static let OP_PONG = 0xA

    static func acceptKey(_ key: String) -> String {
        let digest = Insecure.SHA1.hash(data: Bytes((key.trimmingCharacters(in: .whitespaces) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        return Base64URL.encodeStandard(Bytes(digest))
    }

    /// Close codes that may be sent in a close frame (the same rule as sendableCode in device-proxy.mjs).
    static func sendableCode(_ code: Int) -> Int {
        (code == 1000 || (1001...1003).contains(code) || (1007...1014).contains(code) || (3000...4999).contains(code)) ? code : 1000
    }

    struct RawFrame {
        let fin: Bool
        let opcode: Int
        let payload: Bytes
    }

    struct ProtocolError: Error, CustomStringConvertible {
        let closeCode: Int
        let description: String
    }

    /// Read one frame. Server side: client frames must be masked; client side (masked: false): server frames must not be.
    static func readFrame(_ input: SocketReader, maxPayload: Int, expectMasked: Bool = true) throws -> RawFrame {
        let h = try input.readFully(2)
        let b0 = Int(h[0])
        let b1 = Int(h[1])
        if b0 & 0x70 != 0 { throw ProtocolError(closeCode: 1002, description: "RSV bits set") }
        let fin = b0 & 0x80 != 0
        let opcode = b0 & 0x0f
        let masked = b1 & 0x80 != 0
        if masked != expectMasked {
            throw ProtocolError(closeCode: 1002, description: expectMasked ? "client frames must be masked" : "server frames must not be masked")
        }
        var len = UInt64(b1 & 0x7f)
        if len == 126 {
            let e = try input.readFully(2)
            len = UInt64(e[0]) << 8 | UInt64(e[1])
        } else if len == 127 {
            let e = try input.readFully(8)
            len = 0
            for x in e { len = len << 8 | UInt64(x) }
            if len >> 63 != 0 { throw ProtocolError(closeCode: 1009, description: "frame too large") }
        }
        if opcode >= 0x8 && (len > 125 || !fin) { throw ProtocolError(closeCode: 1002, description: "bad control frame") }
        if len > UInt64(maxPayload) { throw ProtocolError(closeCode: 1009, description: "frame too large") }
        let mask = masked ? try input.readFully(4) : []
        var payload = try input.readFully(Int(len))
        if masked { for i in 0..<payload.count { payload[i] ^= mask[i & 3] } }
        return RawFrame(fin: fin, opcode: opcode, payload: payload)
    }

    /// One frame as bytes: unmasked (server) or masked with a random key (client).
    static func frame(_ opcode: Int, _ payload: Bytes, fin: Bool = true, masked: Bool = false) -> Bytes {
        var out = Bytes()
        out.reserveCapacity(payload.count + 14)
        out.append(UInt8((fin ? 0x80 : 0) | opcode))
        let m: UInt8 = masked ? 0x80 : 0
        let n = payload.count
        if n < 126 {
            out.append(m | UInt8(n))
        } else if n <= 0xffff {
            out += [m | 126, UInt8(n >> 8), UInt8(n & 0xff)]
        } else {
            out.append(m | 127)
            for i in stride(from: 7, through: 0, by: -1) { out.append(UInt8(truncatingIfNeeded: UInt64(n) >> (8 * UInt64(i)))) }
        }
        if masked {
            let key = randomBytes(4)
            out += key
            for (i, b) in payload.enumerated() { out.append(b ^ key[i & 3]) }
        } else {
            out += payload
        }
        return out
    }

    static func closePayload(_ code: Int, _ reason: String) -> Bytes {
        var r = Bytes(reason.utf8)
        if r.count > 123 { r = Bytes(r[..<123]) }
        return [UInt8(truncatingIfNeeded: code >> 8), UInt8(truncatingIfNeeded: code)] + r
    }

    static func parseClose(_ payload: Bytes) -> (Int, String) {
        let code = payload.count >= 2 ? Int(payload[0]) << 8 | Int(payload[1]) : 1005
        let reason = payload.count > 2 ? Bytes(payload[2...]).utf8String : ""
        return (code, reason)
    }
}

/// An HTTP/1.1 request or response head (lower-case header names; repeated headers joined like Node / the Kotlin port).
struct HttpHead {
    let startLine: [String]
    let headers: [String: String]

    static let MAX = 32 * 1024

    /// Read up to the blank line. nil when the stream ends first, the head is too large or malformed.
    static func read(_ input: SocketReader) throws -> HttpHead? {
        var buf = Bytes()
        var state = 0
        while true {
            guard let c = try input.readByte() else { return nil }
            buf.append(c)
            if buf.count > MAX { return nil }
            switch (c, state) {
            case (0x0d, 0), (0x0d, 2): state += 1
            case (0x0a, 1), (0x0a, 3): state += 1
            default: state = 0
            }
            if state == 4 { break }
        }
        // ISO-8859-1, like the Kotlin port (header bytes map 1:1 to code points)
        let text = String(buf.map { Character(Unicode.Scalar($0)) })
        let lines = text.components(separatedBy: "\r\n")
        let start = lines[0].split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        if start.count < 3 { return nil }
        var headers = [String: String]()
        for line in lines.dropFirst() where !line.isEmpty {
            guard let i = line.firstIndex(of: ":"), i != line.startIndex else { continue }
            let k = line[..<i].trimmingCharacters(in: .whitespaces).lowercased()
            let v = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
            if let prev = headers[k] { headers[k] = k == "cookie" ? "\(prev); \(v)" : "\(prev), \(v)" } else { headers[k] = v }
        }
        return HttpHead(startLine: start, headers: headers)
    }
}
