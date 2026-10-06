import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

// Swift port of core/remote/noise.mjs and Noise.kt (docs/remote.md §3). Noise_IK_25519_AESGCM_SHA256 and
// Noise_IKpsk2_25519_AESGCM_SHA256, written as the spec's CipherState / SymmetricState / HandshakeState.
// AESGCM nonce = 4 zero bytes + 64-bit BIG-endian counter (spec §12.4; ChaChaPoly would be little-endian).
// Checked against the cacophony vectors and the Pleiad examples in tests/remote/vectors.json (VectorsTests).

public enum NoiseConst {
    public static let DHLEN = 32
    public static let HASHLEN = 32
    public static let TAGLEN = 16
    public static let MAX_MESSAGE = 65535
    public static let MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN
    /// Per-direction message limit (docs/remote.md §3.2). Reached = error; the caller reconnects.
    public static let MAX_NONCE: UInt64 = 1 << 32
    public static let PROTOCOL_IK = "Noise_IK_25519_AESGCM_SHA256"
    public static let PROTOCOL_IKPSK2 = "Noise_IKpsk2_25519_AESGCM_SHA256"
    public static let PROLOGUE_PREFIX = "pleiad-remote/1"
}

public struct NonceExhausted: Error {}
public struct DecryptError: Error, CustomStringConvertible { public let description: String }
public struct HandshakeError: Error, CustomStringConvertible { public let description: String }

/// Noise HKDF (spec §4.3). n = 2 or 3.
func noiseHkdf(_ chainingKey: Bytes, _ ikm: Bytes, _ n: Int) -> [Bytes] {
    let temp = hmac(chainingKey, ikm)
    let o1 = hmac(temp, [1])
    let o2 = hmac(temp, o1, [2])
    return n == 2 ? [o1, o2] : [o1, o2, hmac(temp, o2, [3])]
}

public struct KeyPair {
    public let publicKey: Bytes
    public let privateKey: Bytes

    public static func generate() -> KeyPair {
        let k = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(publicKey: Bytes(k.publicKey.rawRepresentation), privateKey: Bytes(k.rawRepresentation))
    }

    public static func fromPrivate(_ priv: Bytes) throws -> KeyPair {
        KeyPair(publicKey: try X25519.publicKey(priv), privateKey: priv)
    }
}

public final class CipherState {
    private let key: SymmetricKey?
    public private(set) var n: UInt64 = 0

    init(_ k: Bytes? = nil) { key = k.map { SymmetricKey(data: $0) } }

    var hasKey: Bool { key != nil }

    private func nonce(_ n: UInt64) throws -> AES.GCM.Nonce {
        var b = Bytes(repeating: 0, count: 12)
        for i in 0..<8 { b[4 + i] = UInt8(truncatingIfNeeded: n >> (56 - 8 * UInt64(i))) }
        return try AES.GCM.Nonce(data: b)
    }

    public func encryptWithAd(_ ad: Bytes, _ plaintext: Bytes) throws -> Bytes {
        guard let key else { return plaintext }
        if n >= NoiseConst.MAX_NONCE { throw NonceExhausted() }
        guard plaintext.count <= NoiseConst.MAX_PLAINTEXT else {
            throw HandshakeError(description: "plaintext is limited to \(NoiseConst.MAX_PLAINTEXT) bytes")
        }
        let box = try AES.GCM.seal(plaintext, using: key, nonce: try nonce(n), authenticating: ad)
        n += 1
        return Bytes(box.ciphertext) + Bytes(box.tag)
    }

    /// A failure does not advance n (spec §5.1); the caller drops the connection anyway.
    public func decryptWithAd(_ ad: Bytes, _ ciphertext: Bytes) throws -> Bytes {
        guard let key else { return ciphertext }
        if n >= NoiseConst.MAX_NONCE { throw NonceExhausted() }
        guard ciphertext.count >= NoiseConst.TAGLEN else { throw DecryptError(description: "ciphertext too short") }
        let out: Bytes
        do {
            let split = ciphertext.count - NoiseConst.TAGLEN
            let box = try AES.GCM.SealedBox(nonce: try nonce(n), ciphertext: ciphertext[..<split], tag: ciphertext[split...])
            out = Bytes(try AES.GCM.open(box, using: key, authenticating: ad))
        } catch {
            throw DecryptError(description: "decryption failed (tampered, wrong key or out of order)")
        }
        n += 1
        return out
    }
}

private final class SymmetricState {
    var h: Bytes
    var ck: Bytes
    var cs = CipherState()

    init(_ protocolName: String) {
        let name = Bytes(protocolName.utf8)
        h = name.count <= NoiseConst.HASHLEN ? name + Bytes(repeating: 0, count: NoiseConst.HASHLEN - name.count) : sha256(name)
        ck = h
    }

    func mixKey(_ ikm: Bytes) {
        let o = noiseHkdf(ck, ikm, 2)
        ck = o[0]
        cs = CipherState(o[1])
    }

    func mixHash(_ data: Bytes) { h = sha256(h, data) }

    func mixKeyAndHash(_ ikm: Bytes) {
        let o = noiseHkdf(ck, ikm, 3)
        ck = o[0]
        mixHash(o[1])
        cs = CipherState(o[2])
    }

    func encryptAndHash(_ plaintext: Bytes) throws -> Bytes {
        let c = try cs.encryptWithAd(h, plaintext)
        mixHash(c)
        return c
    }

    func decryptAndHash(_ ciphertext: Bytes) throws -> Bytes {
        let p = try cs.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return p
    }

    func split() -> (CipherState, CipherState) {
        let o = noiseHkdf(ck, [], 2)
        return (CipherState(o[0]), CipherState(o[1]))
    }
}

public enum Pattern: CustomStringConvertible {
    case IK, IKpsk2

    var protocolName: String { self == .IK ? NoiseConst.PROTOCOL_IK : NoiseConst.PROTOCOL_IKPSK2 }
    var psk: Bool { self == .IKpsk2 }
    var messages: [[String]] {
        self == .IK
            ? [["e", "es", "s", "ss"], ["e", "ee", "se"]]
            : [["e", "es", "s", "ss"], ["e", "ee", "se", "psk"]]
    }
    public var description: String { self == .IK ? "IK" : "IKpsk2" }
}

/// IK / IKpsk2 handshake. The device is always the initiator; the responder side exists for the vectors and tests.
/// `ephemeral` is for the vectors only (normally a fresh key per handshake).
public final class Handshake {
    public let pattern: Pattern
    public let initiator: Bool
    private let s: KeyPair
    public private(set) var rs: Bytes?
    private let psk: Bytes?
    private let fixedE: KeyPair?
    private var e: KeyPair?
    private var re: Bytes?
    private var index = 0
    private let ss: SymmetricState

    public init(_ pattern: Pattern, initiator: Bool, prologue: Bytes, staticKey: KeyPair, remoteStatic: Bytes? = nil,
                psk: Bytes? = nil, ephemeral: Bytes? = nil) throws {
        if initiator && remoteStatic == nil { throw HandshakeError(description: "the IK initiator requires the remote (host) static public key") }
        if pattern.psk != (psk != nil) { throw HandshakeError(description: "psk mismatch for \(pattern)") }
        if let r = remoteStatic, r.count != 32 { throw HandshakeError(description: "remote static public key must be 32 bytes") }
        if let p = psk, p.count != 32 { throw HandshakeError(description: "psk must be 32 bytes") }
        self.pattern = pattern
        self.initiator = initiator
        self.s = staticKey
        self.rs = remoteStatic
        self.psk = psk
        self.fixedE = try ephemeral.map { try KeyPair.fromPrivate($0) }
        self.ss = SymmetricState(pattern.protocolName)
        ss.mixHash(prologue)
        ss.mixHash(initiator ? remoteStatic! : staticKey.publicKey)
    }

    public var isComplete: Bool { index >= pattern.messages.count }
    public var isMyTurn: Bool { !isComplete && ((index % 2 == 0) == initiator) }
    public var handshakeHash: Bytes { ss.h }

    private func dhToken(_ token: String) throws -> Bytes {
        switch token {
        case "ee": return try X25519.dh(e!.privateKey, re!)
        case "ss": return try X25519.dh(s.privateKey, rs!)
        case "es": return initiator ? try X25519.dh(e!.privateKey, rs!) : try X25519.dh(s.privateKey, re!)
        case "se": return initiator ? try X25519.dh(s.privateKey, re!) : try X25519.dh(e!.privateKey, rs!)
        default: throw HandshakeError(description: "unknown token \(token)")
        }
    }

    public func writeMessage(_ payload: Bytes = []) throws -> Bytes {
        guard isMyTurn else { throw HandshakeError(description: "not our turn to write") }
        var out = Bytes()
        for token in pattern.messages[index] {
            switch token {
            case "e":
                let eph = fixedE ?? KeyPair.generate()
                e = eph
                out += eph.publicKey
                ss.mixHash(eph.publicKey)
                if pattern.psk { ss.mixKey(eph.publicKey) }
            case "s": out += try ss.encryptAndHash(s.publicKey)
            case "psk": ss.mixKeyAndHash(psk!)
            default: ss.mixKey(try dhToken(token))
            }
        }
        out += try ss.encryptAndHash(payload)
        index += 1
        if out.count > NoiseConst.MAX_MESSAGE { throw HandshakeError(description: "handshake message too large") }
        return out
    }

    public func readMessage(_ message: Bytes) throws -> Bytes {
        guard !isComplete && !isMyTurn else { throw HandshakeError(description: "not the peer's turn to write") }
        if message.count > NoiseConst.MAX_MESSAGE { throw HandshakeError(description: "handshake message too large") }
        var off = 0
        func take(_ n: Int) throws -> Bytes {
            if message.count - off < n { throw HandshakeError(description: "handshake message too short") }
            defer { off += n }
            return Bytes(message[off..<off + n])
        }
        for token in pattern.messages[index] {
            switch token {
            case "e":
                let r = try take(NoiseConst.DHLEN)
                re = r
                ss.mixHash(r)
                if pattern.psk { ss.mixKey(r) }
            case "s":
                let len = ss.cs.hasKey ? NoiseConst.DHLEN + NoiseConst.TAGLEN : NoiseConst.DHLEN
                rs = try ss.decryptAndHash(try take(len))
            case "psk": ss.mixKeyAndHash(psk!)
            default: ss.mixKey(try dhToken(token))
            }
        }
        let payload = try ss.decryptAndHash(Bytes(message[off...]))
        index += 1
        return payload
    }

    public func split() throws -> Transport {
        guard isComplete else { throw HandshakeError(description: "handshake not complete") }
        let (c1, c2) = ss.split()
        return initiator ? Transport(c1, c2, handshakeHash) : Transport(c2, c1, handshakeHash)
    }
}

/// Established transport. One nonce per message (reordering, loss or replay = decrypt failure). Thread-safe.
public final class Transport {
    private let sendCs: CipherState
    private let recvCs: CipherState
    public let handshakeHash: Bytes
    private let lock = NSLock()

    init(_ send: CipherState, _ recv: CipherState, _ hash: Bytes) {
        sendCs = send
        recvCs = recv
        handshakeHash = hash
    }

    public func encrypt(_ plaintext: Bytes) throws -> Bytes {
        lock.lock(); defer { lock.unlock() }
        return try sendCs.encryptWithAd([], plaintext)
    }

    public func decrypt(_ ciphertext: Bytes) throws -> Bytes {
        lock.lock(); defer { lock.unlock() }
        return try recvCs.decryptWithAd([], ciphertext)
    }
}

// ── Pleiad conventions (docs/remote.md §3) ──

public enum Pleiad {
    public static func prologueFor(_ hostId: String) -> Bytes { Bytes(NoiseConst.PROLOGUE_PREFIX.utf8) + Bytes(hostId.utf8) }

    private static let B32 = Array("abcdefghijklmnopqrstuvwxyz234567".utf8)

    /// RFC 4648 base32, lower case, no padding.
    public static func base32(_ buf: Bytes) -> String {
        var bits = 0
        var value = 0
        var out = Bytes()
        for b in buf {
            value = ((value << 8) | Int(b)) & 0xffff
            bits += 8
            while bits >= 5 {
                out.append(B32[(value >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 { out.append(B32[(value << (5 - bits)) & 31]) }
        return out.utf8String
    }

    public static func hostIdFor(_ hostPublicKey: Bytes) throws -> String {
        guard hostPublicKey.count == 32 else { throw HandshakeError(description: "host public key must be 32 bytes") }
        return String(base32(sha256(hostPublicKey)).prefix(26))
    }

    /// RFC 5869 HKDF-SHA256 with empty salt, info = label (UTF-8), 32 bytes.
    public static func hkdfLabel(_ secret: Bytes, _ label: String) -> Bytes {
        let prk = hmac(Bytes(repeating: 0, count: 32), secret)   // extract: salt = HashLen zeros (RFC 5869 when salt is empty)
        return hmac(prk, Bytes(label.utf8), [1])                   // expand: one block = 32 bytes
    }

    public struct PairingKeys {
        public let psk: Bytes
        public let ticket: Bytes
        public let ticketHash: Bytes
    }

    public static func derivePairing(_ secret: Bytes) throws -> PairingKeys {
        guard secret.count == 32 else { throw HandshakeError(description: "pairing secret must be 32 bytes") }
        let psk = hkdfLabel(secret, "pleiad pair psk")
        let ticket = hkdfLabel(secret, "pleiad pair ticket")
        return PairingKeys(psk: psk, ticket: ticket, ticketHash: sha256(ticket))
    }

    /// 6-digit code: HMAC-SHA256(key = h, "pleiad pair code"), first 4 bytes BE mod 10^6, zero-padded.
    public static func confirmationCode(_ handshakeHash: Bytes) throws -> String {
        guard handshakeHash.count == 32 else { throw HandshakeError(description: "handshake hash must be 32 bytes") }
        let m = hmac(handshakeHash, Bytes("pleiad pair code".utf8))
        let v = UInt32(m[0]) << 24 | UInt32(m[1]) << 16 | UInt32(m[2]) << 8 | UInt32(m[3])
        let s = String(v % 1_000_000)
        return String(repeating: "0", count: 6 - s.count) + s
    }

    public static func formatConfirmationCode(_ code: String) -> String { "\(code.prefix(3)) \(code.dropFirst(3))" }
}
