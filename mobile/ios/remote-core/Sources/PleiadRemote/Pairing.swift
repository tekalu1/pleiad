import Foundation

// Swift port of core/remote/pairing.mjs, pairWithHost() in core/remote/device.mjs and Pairing.kt (docs/remote.md §3.3).
// QR: pleiad://pair?v=1&r=<relay URL>&h=<hostId>&k=<host public key b64url>&s=<pairing secret b64url>&n=<host name>

public let PAIR_SCHEME = "pleiad://pair"
public let PAIR_VERSION = "1"
public let PAIRING_TTL_MS = 5 * 60 * 1000

/// A failure with a stable code; the shell translates the code (strings live in the app, not here).
/// code: payload | relay-url | denied | expired | ticket | rate | host-offline | offline | cancelled | aborted | timeout |
///       handshake | bad-response. detail: a sub-code (e.g. the payload problem) or the relay close code.
public struct PairError: Error, CustomStringConvertible, Equatable {
    public let code: String
    public let detail: String
    public let closeCode: Int?
    public init(_ code: String, _ detail: String = "", closeCode: Int? = nil) {
        self.code = code
        self.detail = detail
        self.closeCode = closeCode
    }
    public var description: String { detail.isEmpty ? code : "\(code) (\(detail))" }
}

public struct PairingOffer {
    public let relayUrl: String
    public let hostId: String
    public let publicKey: Bytes
    public let secret: Bytes
    public let hostName: String
}

/// What the device keeps per host. token is secret.
public struct HostCreds: Equatable {
    public let hostId: String
    public let hostPublicKey: Bytes
    public let relayUrl: String
    public let deviceId: String
    public let token: String
    public let hostName: String

    public init(hostId: String, hostPublicKey: Bytes, relayUrl: String, deviceId: String, token: String, hostName: String) {
        self.hostId = hostId
        self.hostPublicKey = hostPublicKey
        self.relayUrl = relayUrl
        self.deviceId = deviceId
        self.token = token
        self.hostName = hostName
    }
}

public enum PairingCodec {
    private static let LOOPBACK: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

    /// normalizeRelayUrl: https / wss only; http / ws only on loopback. Drops a trailing "/". Throws PairError("relay-url", sub).
    public static func normalizeRelayUrl(_ value: String?) throws -> String {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return "" }
        guard let u = URLComponents(string: raw), let schemeRaw = u.scheme else { throw PairError("relay-url", "invalid") }
        let scheme = schemeRaw.lowercased()
        let secure = scheme == "https" || scheme == "wss"
        let plain = scheme == "http" || scheme == "ws"
        if !secure && !plain { throw PairError("relay-url", "httpsOnly") }
        guard var host = u.percentEncodedHost?.lowercased(), !host.isEmpty else { throw PairError("relay-url", "invalid") }
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        if plain && !LOOPBACK.contains(host) { throw PairError("relay-url", "httpsOnlyLoopback") }
        if u.percentEncodedUser != nil || u.percentEncodedPassword != nil { throw PairError("relay-url", "noUserinfo") }
        // like URL.search / URL.hash in pairing.mjs: a bare "?" or "#" is empty and passes
        if !(u.percentEncodedQuery ?? "").isEmpty || !(u.percentEncodedFragment ?? "").isEmpty { throw PairError("relay-url", "noQuery") }
        let defaultPort = secure ? 443 : 80
        let port = (u.port == nil || u.port == defaultPort) ? "" : ":\(u.port!)"
        var path = u.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        return "\(scheme)://\(host)\(port)\(path)"
    }

    public static func relayWsUrl(_ relayUrl: String, _ route: String) throws -> String {
        let n = try normalizeRelayUrl(relayUrl)
        guard let i = n.range(of: "://") else { throw PairError("relay-url", "invalid") }
        let scheme = n.hasPrefix("https") || n.hasPrefix("wss") ? "wss" : "ws"
        return "\(scheme)://\(n[i.upperBound...])\(route)"
    }

    /// application/x-www-form-urlencoded decoding ("+" is a space, like URLDecoder / URLSearchParams).
    private static func formDecode(_ s: Substring) throws -> String {
        guard let v = s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding else { throw PairError("payload", "broken") }
        return v
    }

    private static func query(_ s: Substring) throws -> [String: String] {
        var out = [String: String]()
        for part in s.split(separator: "&", omittingEmptySubsequences: true) {
            let i = part.firstIndex(of: "=")
            let k = try formDecode(i.map { part[..<$0] } ?? part)
            let v = try i.map { try formDecode(part[part.index(after: $0)...]) } ?? ""
            if out[k] == nil { out[k] = v }            // URLSearchParams.get returns the first
        }
        return out
    }

    public static func b64urlEncode(_ b: Bytes) -> String { Base64URL.encode(b) }
    public static func b64urlDecode(_ s: String) -> Bytes? { Base64URL.decode(s) }

    /// parsePairingPayload. Throws PairError("payload", sub) with sub = notCode | unsupportedVersion | broken | hostIdMismatch.
    public static func parse(_ text: String?) throws -> PairingOffer {
        let s = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("\(PAIR_SCHEME)?") else { throw PairError("payload", "notCode") }
        let q = try query(s.dropFirst(PAIR_SCHEME.count + 1))
        if q["v"] != PAIR_VERSION { throw PairError("payload", "unsupportedVersion") }
        let publicKey = Base64URL.decode(q["k"] ?? "") ?? []
        let secret = Base64URL.decode(q["s"] ?? "") ?? []
        if publicKey.count != 32 || secret.count != 32 { throw PairError("payload", "broken") }
        let hostId = (q["h"] ?? "").lowercased()
        if hostId != (try Pleiad.hostIdFor(publicKey)) { throw PairError("payload", "hostIdMismatch") }
        let relay: String
        do { relay = try normalizeRelayUrl(q["r"]) } catch let e as PairError { throw PairError("payload", "relay-\(e.detail)") }
        if relay.isEmpty { throw PairError("payload", "broken") }
        return PairingOffer(relayUrl: relay, hostId: hostId, publicKey: publicKey, secret: secret, hostName: q["n"] ?? "")
    }

    /// JS `\s` (and String.prototype.trim): the whitespace set of core/remote/pairing.mjs's cleanLabel.
    private static func isJsSpace(_ v: UInt32) -> Bool {
        switch v {
        case 0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: return true
        default: return false
        }
    }

    /// cleanLabel: drop control characters, collapse whitespace, trim, cap the length in UTF-16 units — the same
    /// as cleanLabel in core/remote/pairing.mjs (JS `\s` is Unicode-aware, so U+3000 and U+00A0 collapse too).
    public static func cleanLabel(_ value: String?, max: Int = 64) -> String {
        var scalars = String.UnicodeScalarView()
        var pendingSpace = false
        for u in (value ?? "").unicodeScalars {
            let v = u.value
            let control = v <= 0x1f || (0x7f...0x9f).contains(v) || v == 0x2028 || v == 0x2029
            if control || isJsSpace(v) {
                pendingSpace = true
                continue
            }
            if pendingSpace && !scalars.isEmpty { scalars.append(" ") }
            pendingSpace = false
            scalars.append(u)
        }
        var units = Array(String(scalars).utf16)
        if units.count <= max { return String(decoding: units, as: UTF16.self) }
        units = Array(units[..<max])
        // JS would keep a lone lead surrogate here; a Swift string cannot hold one, so it is dropped
        if let last = units.last, UTF16.isLeadSurrogate(last) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }
}

/// A running pairing. cancel() aborts it (the blocking pair() then throws PairError("aborted")).
public final class Pairing {
    private let lock = NSLock()
    private var _cancelled = false
    private var _socket: RelaySocket?

    public init() {}

    public var cancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return _cancelled
    }

    var socket: RelaySocket? {
        get { lock.lock(); defer { lock.unlock() }; return _socket }
        set { lock.lock(); _socket = newValue; lock.unlock() }
    }

    public func cancel() {
        lock.lock()
        _cancelled = true
        let s = _socket
        lock.unlock()
        s?.terminate()
    }

    private static func forClose(_ code: Int) -> PairError {
        switch code {
        case 4401: return PairError("ticket", closeCode: code)
        case 4429: return PairError("rate", closeCode: code)
        case 4404, 4408: return PairError("host-offline", closeCode: code)
        default: return PairError("cancelled", closeCode: code)
        }
    }

    /// Pair with the host (blocking; run off the main thread). onCode(6 digits) is called after the handshake, then this
    /// waits for the host's approval. Returns the credentials to store.
    public static func pair(
        payload: String,
        keyPair: KeyPair,
        name: String,
        platform: String = "ios",
        app: String = "",
        onCode: (String) -> Void = { _ in },
        handle: Pairing = Pairing(),
        timeoutMs: Int = PAIRING_TTL_MS + 30_000,
        connectTimeoutMs: Int = 15_000
    ) throws -> HostCreds {
        let p = try PairingCodec.parse(payload)
        let keys = try Pleiad.derivePairing(p.secret)
        if handle.cancelled { throw PairError("aborted") }
        let sock = RelaySocket(
            url: try PairingCodec.relayWsUrl(p.relayUrl, "/v1/device"),
            headers: ["x-pleiad-host": p.hostId, "x-pleiad-pairing": PairingCodec.b64urlEncode(keys.ticket)],
            openTimeoutMs: connectTimeoutMs
        )
        handle.socket = sock
        if handle.cancelled { sock.terminate() }
        defer {
            handle.socket = nil
            if sock.closed == nil { sock.close(1000) } else { sock.terminate() }
        }
        do {
            let o = sock.awaitOpen()
            if handle.cancelled { throw PairError("aborted") }
            if !o.open {
                if let c = o.closeCode, c != 1006 { throw forClose(c) }
                throw PairError("offline", o.status.map(String.init) ?? (o.error ?? ""))
            }
            let hs = try Handshake(.IKpsk2, initiator: true, prologue: Pleiad.prologueFor(p.hostId), staticKey: keyPair,
                                   remoteStatic: p.publicKey, psk: keys.psk)
            let hello: JSON = ["proto": 1, "name": .string(PairingCodec.cleanLabel(name)), "platform": .string(platform), "app": .string(app)]
            _ = sock.send(try hs.writeMessage(hello.data))
            let m2: Bytes
            do {
                m2 = try sock.next(connectTimeoutMs)
            } catch let e as RelayClosed {
                if handle.cancelled { throw PairError("aborted") }
                throw forClose(e.code)
            } catch is RelayTimeout {
                throw PairError("host-offline", "noResponse")
            }
            do { _ = try hs.readMessage(m2) } catch { throw PairError("handshake", "keyMismatch") }
            let transport = try hs.split()
            let code = try Pleiad.confirmationCode(hs.handshakeHash)
            _ = sock.send(try transport.encrypt((["type": "pair"] as JSON).data))
            onCode(code)
            let msg: JSON
            do {
                msg = try JSON.parse(try transport.decrypt(try sock.next(timeoutMs)))
            } catch let e as RelayClosed {
                if handle.cancelled { throw PairError("aborted") }
                throw forClose(e.code)
            } catch is RelayTimeout {
                throw PairError("timeout")
            } catch {
                if handle.cancelled { throw PairError("aborted") }
                throw PairError("handshake", "unreadable")
            }
            switch msg["type"]?.string {
            case "denied": throw PairError("denied")
            case "expired": throw PairError("expired")
            case "approved": break
            default: throw PairError("bad-response")
            }
            guard let deviceId = msg["deviceId"]?.string, let token = msg["token"]?.string else { throw PairError("bad-response") }
            let hostName = PairingCodec.cleanLabel(msg["hostName"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? p.hostName)
            return HostCreds(hostId: p.hostId, hostPublicKey: p.publicKey, relayUrl: p.relayUrl, deviceId: deviceId, token: token, hostName: hostName)
        } catch let e as PairError {
            if handle.cancelled && e.code != "aborted" { throw PairError("aborted") }
            throw e
        }
    }
}
