import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

// Byte helpers shared by the port. Bytes are [UInt8] everywhere (CryptoKit's Data only at the boundary).

public typealias Bytes = [UInt8]

/// Hex to bytes (vectors and tests). Invalid input is a programming error.
public func hex(_ s: String) -> Bytes {
    let chars = Array(s.utf8)
    precondition(chars.count % 2 == 0, "odd hex length")
    func nibble(_ c: UInt8) -> UInt8 {
        switch c {
        case 48...57: return c - 48
        case 97...102: return c - 87
        case 65...70: return c - 55
        default: preconditionFailure("not hex")
        }
    }
    var out = Bytes()
    out.reserveCapacity(chars.count / 2)
    var i = 0
    while i < chars.count {
        out.append(nibble(chars[i]) << 4 | nibble(chars[i + 1]))
        i += 2
    }
    return out
}

extension Array where Element == UInt8 {
    public var hexString: String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(count * 2)
        for b in self {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    var utf8String: String { String(decoding: self, as: UTF8.self) }
}

extension String {
    var bytes: Bytes { Bytes(utf8) }
}

/// Cryptographically secure random bytes (SystemRandomNumberGenerator: arc4random / BCryptGenRandom / getrandom).
public func randomBytes(_ n: Int) -> Bytes {
    var g = SystemRandomNumberGenerator()
    var out = Bytes(repeating: 0, count: n)
    var i = 0
    while i < n {
        var v = g.next()
        for _ in 0..<8 where i < n {
            out[i] = UInt8(truncatingIfNeeded: v)
            v >>= 8
            i += 1
        }
    }
    return out
}

public func sha256(_ parts: Bytes...) -> Bytes {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return Bytes(h.finalize())
}

func hmac(_ key: Bytes, _ parts: Bytes...) -> Bytes {
    // An empty HMAC key equals one zero byte (keys are zero-padded to the block size), like the Kotlin port.
    var m = HMAC<SHA256>(key: SymmetricKey(data: key.isEmpty ? Bytes([0]) : key))
    for p in parts { m.update(data: p) }
    return Bytes(m.finalize())
}

/// Constant-time comparison (tokens).
func constantTimeEqual(_ a: Bytes, _ b: Bytes) -> Bool {
    if a.count != b.count { return false }
    var acc: UInt8 = 0
    for i in 0..<a.count { acc |= a[i] ^ b[i] }
    return acc == 0
}

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

enum Base64URL {
    static func encode(_ b: Bytes) -> String {
        Data(b).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict base64url (with or without padding). nil on anything else (like java.util.Base64's URL decoder).
    static func decode(_ s: String) -> Bytes? {
        var t = s
        while t.hasSuffix("=") { t.removeLast() }
        for c in t.utf8 {
            let ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 95
            if !ok { return nil }
        }
        if t.utf8.count % 4 == 1 { return nil }
        t = t.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.utf8.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t).map { Bytes($0) }
    }

    static func encodeStandard(_ b: Bytes) -> String { Data(b).base64EncodedString() }
}
