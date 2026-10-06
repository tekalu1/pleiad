#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public struct X25519Error: Error, CustomStringConvertible {
    public let description: String
}

/// X25519 (RFC 7748) with Curve25519.KeyAgreement only (CryptoKit / swift-crypto). No crypto of our own.
/// Keys are raw 32-byte arrays, the same shape as core/remote/noise.mjs and X25519.kt.
/// Checked against RFC 7748 §5.2/§6.1 and tests/remote/vectors.json.
public enum X25519 {
    public static func publicKey(_ privateKey: Bytes) throws -> Bytes {
        guard privateKey.count == 32 else { throw X25519Error(description: "private key must be 32 bytes") }
        let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        return Bytes(k.publicKey.rawRepresentation)
    }

    /// DH(priv, pub). An all-zero result (small-order peer key) is rejected like noise.mjs.
    public static func dh(_ privateKey: Bytes, _ publicKey: Bytes) throws -> Bytes {
        guard privateKey.count == 32 else { throw X25519Error(description: "private key must be 32 bytes") }
        guard publicKey.count == 32 else { throw X25519Error(description: "public key must be 32 bytes") }
        let out: Bytes
        do {
            let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
            let p = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
            let s = try k.sharedSecretFromKeyAgreement(with: p)
            out = s.withUnsafeBytes { Bytes($0) }
        } catch {
            // swift-crypto (BoringSSL) refuses the all-zero result itself
            throw X25519Error(description: "X25519 failed (invalid peer key)")
        }
        if out.allSatisfy({ $0 == 0 }) { throw X25519Error(description: "X25519 result is zero (invalid peer key)") }
        return out
    }
}
