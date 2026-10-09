import Foundation

// Swift port of core/remote/device.mjs and RemoteDevice.kt (docs/remote.md §3.1・§3.3・§7): the device's key, the
// paired hosts, pairing, and one loopback proxy per open host. No notifications on iOS (ADR 0086, ADR 0144).
//
//   SecretVault        device static key + per-host relay tokens (one JSON object). The iOS shell keeps it in the
//                      Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly); tests use FileVault.
//   <dir>/hosts.json   { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                        pairedAt, lastConnectedAt, revokedAt }] }   (no secrets; same shape as the desktop's and Android's)
//   <dir>/static/<hostId>.bin  the host's web/ shell as last confirmed (StaticCache.swift, docs/remote.md §8.6)

/// Where the secrets live, as one opaque blob. The app's implementation is the Keychain (stage 2).
public protocol SecretVault {
    /// true when the blob is protected by the OS (Keychain), false for a plain file (tests).
    var protected: Bool { get }
    func load() throws -> Bytes?
    func save(_ data: Bytes) throws
}

/// A plain file (tests, non-Apple platforms). Not for the app: secrets would sit unprotected in the sandbox.
public final class FileVault: SecretVault {
    private let file: URL
    public let protected = false
    public init(file: URL) { self.file = file }
    public func load() throws -> Bytes? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return Bytes(try Data(contentsOf: file))
    }
    public func save(_ data: Bytes) throws { try Data(data).write(to: file, options: .atomic) }
}

public struct HostRecord: Equatable {
    public var hostId: String
    public var hostName: String
    public var label: String
    public var relayUrl: String
    public var hostPublicKey: String
    public var deviceId: String
    public var port: Int
    public var pairedAt: Int64?
    public var lastConnectedAt: Int64?
    public var revokedAt: Int64?

    public init(hostId: String, hostName: String, label: String, relayUrl: String, hostPublicKey: String, deviceId: String,
                port: Int, pairedAt: Int64?, lastConnectedAt: Int64?, revokedAt: Int64?) {
        self.hostId = hostId
        self.hostName = hostName
        self.label = label
        self.relayUrl = relayUrl
        self.hostPublicKey = hostPublicKey
        self.deviceId = deviceId
        self.port = port
        self.pairedAt = pairedAt
        self.lastConnectedAt = lastConnectedAt
        self.revokedAt = revokedAt
    }

    private static func time(_ v: Int64?) -> JSON { v.map { .int($0) } ?? .null }

    public var json: JSON {
        ["hostId": .string(hostId), "hostName": .string(hostName), "label": .string(label), "relayUrl": .string(relayUrl),
         "hostPublicKey": .string(hostPublicKey), "deviceId": .string(deviceId), "port": .int(Int64(port)),
         "pairedAt": HostRecord.time(pairedAt), "lastConnectedAt": HostRecord.time(lastConnectedAt), "revokedAt": HostRecord.time(revokedAt)]
    }

    /// For the shell UI: no key material.
    public var publicJson: JSON {
        var o = json
        o.set("hostPublicKey", nil)
        return o
    }

    /// Numbers (ms) or ISO-8601 strings (as the desktop may write them).
    private static func readTime(_ v: JSON?) -> Int64? {
        switch v {
        case .int(let i)?: return i
        case .double(let d)?: return Int64(d)
        case .string(let s)?:
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) ?? ISO8601DateFormatter().date(from: s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
            return nil
        default: return nil
        }
    }

    static func from(_ o: JSON) throws -> HostRecord {
        guard let hostId = o["hostId"]?.string, let relayUrl = o["relayUrl"]?.string,
              let key = o["hostPublicKey"]?.string, let deviceId = o["deviceId"]?.string else {
            throw StateError(description: "hosts.json has a broken entry")
        }
        return HostRecord(hostId: hostId, hostName: o["hostName"]?.string ?? "", label: o["label"]?.string ?? "", relayUrl: relayUrl,
                          hostPublicKey: key, deviceId: deviceId, port: Int(o["port"]?.int ?? 0),
                          pairedAt: readTime(o["pairedAt"]), lastConnectedAt: readTime(o["lastConnectedAt"]), revokedAt: readTime(o["revokedAt"]))
    }
}

public final class DeviceStore {
    public let dir: URL
    private let hostsFile: URL
    private let vault: SecretVault
    private let lock = NSRecursiveLock()
    private var keyPair: KeyPair?

    public var protected: Bool { vault.protected }

    public init(dir: URL, vault: SecretVault? = nil) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.dir = dir
        hostsFile = dir.appendingPathComponent("hosts.json")
        self.vault = vault ?? FileVault(file: dir.appendingPathComponent("secrets.json"))
    }

    private func readSecrets() throws -> [String: JSON] {
        guard let b = try vault.load() else { return [:] }
        return try JSON.parse(b).object ?? [:]
    }

    private func writeSecrets(_ o: [String: JSON]) throws { try vault.save(JSON.object(o).data) }

    private func readHosts() throws -> [HostRecord] {
        guard FileManager.default.fileExists(atPath: hostsFile.path) else { return [] }
        let o = try JSON.parse(Bytes(try Data(contentsOf: hostsFile)))
        guard o["version"]?.int == 1, let arr = o["hosts"]?.array else { throw StateError(description: "hosts.json has an unexpected format") }
        return try arr.map(HostRecord.from)
    }

    private func writeHosts(_ list: [HostRecord]) throws {
        let o: JSON = ["version": 1, "hosts": .array(list.map(\.json))]
        try Data(o.data).write(to: hostsFile, options: .atomic)
    }

    /// The device static key (one for all hosts). Created on first use.
    public func identity() throws -> KeyPair {
        lock.lock(); defer { lock.unlock() }
        if let keyPair { return keyPair }
        var secrets = try readSecrets()
        let kp: KeyPair
        if let s = secrets["deviceKey"]?.string, let priv = Base64URL.decode(s), priv.count == 32 {
            kp = try KeyPair.fromPrivate(priv)
        } else {
            kp = KeyPair.generate()
            secrets["deviceKey"] = .string(Base64URL.encode(kp.privateKey))
            try writeSecrets(secrets)
        }
        keyPair = kp
        return kp
    }

    public func hosts() throws -> [HostRecord] {
        lock.lock(); defer { lock.unlock() }
        return try readHosts()
    }

    public func host(_ hostId: String) throws -> HostRecord? { try hosts().first { $0.hostId == hostId } }

    public func credentials(_ hostId: String) throws -> HostCreds? {
        lock.lock(); defer { lock.unlock() }
        guard let h = try readHosts().first(where: { $0.hostId == hostId }),
              let token = try readSecrets()["host:\(hostId)"]?["token"]?.string, !token.isEmpty,
              let key = Base64URL.decode(h.hostPublicKey) else { return nil }
        return HostCreds(hostId: h.hostId, hostPublicKey: key, relayUrl: h.relayUrl, deviceId: h.deviceId, token: token, hostName: h.hostName)
    }

    @discardableResult
    public func saveHost(_ c: HostCreds) throws -> HostRecord {
        lock.lock(); defer { lock.unlock() }
        guard c.hostId.utf8.count == 26, c.hostId.utf8.allSatisfy({ (97...122).contains($0) || (50...55).contains($0) }) else {
            throw StateError(description: "invalid hostId")
        }
        var secrets = try readSecrets()
        secrets["host:\(c.hostId)"] = ["token": .string(c.token)]
        try writeSecrets(secrets)
        let list = try readHosts()
        let prev = list.first { $0.hostId == c.hostId }
        let rec = HostRecord(hostId: c.hostId, hostName: PairingCodec.cleanLabel(c.hostName), label: prev?.label ?? "", relayUrl: c.relayUrl,
                             hostPublicKey: Base64URL.encode(c.hostPublicKey), deviceId: c.deviceId, port: prev?.port ?? 0,
                             pairedAt: nowMs(), lastConnectedAt: nil, revokedAt: nil)
        try writeHosts(list.filter { $0.hostId != c.hostId } + [rec])
        return rec
    }

    @discardableResult
    public func updateHost(_ hostId: String, _ patch: (inout HostRecord) -> Void) throws -> HostRecord? {
        lock.lock(); defer { lock.unlock() }
        var list = try readHosts()
        guard let i = list.firstIndex(where: { $0.hostId == hostId }) else { return nil }
        patch(&list[i])
        try writeHosts(list)
        return list[i]
    }

    @discardableResult
    public func removeHost(_ hostId: String) throws -> HostRecord? {
        lock.lock(); defer { lock.unlock() }
        var secrets = try readSecrets()
        secrets["host:\(hostId)"] = nil
        try writeSecrets(secrets)
        let list = try readHosts()
        let hit = list.first { $0.hostId == hostId }
        try writeHosts(list.filter { $0.hostId != hostId })
        return hit
    }
}

/// The device as a whole: host list, pairing, one proxy per open host.
public final class RemoteDevice {
    public let store: DeviceStore
    public let app: String
    public let name: String
    public let platform: String
    private let texts: ProxyTexts
    private let backoff: Backoff
    private let connectTimeoutMs: Int
    private let requestWaitMs: Int
    private let log: (String) -> Void
    public let loop = Loop()
    private let lock = NSRecursiveLock()
    private var proxies: [String: DeviceProxy] = [:]
    private var listeners: [Int: (String, LinkStatus) -> Void] = [:]
    private var nextListener = 0

    public init(store: DeviceStore, app: String, name: String, platform: String = "ios", texts: ProxyTexts = DefaultTexts(),
                backoff: Backoff = Backoff(), connectTimeoutMs: Int = 15_000, requestWaitMs: Int = 10_000,
                log: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.app = app
        self.name = name
        self.platform = platform
        self.texts = texts
        self.backoff = backoff
        self.connectTimeoutMs = connectTimeoutMs
        self.requestWaitMs = requestWaitMs
        self.log = log
    }

    /// 状態の購読を登録し、offStatus で解除するための番号を返す。
    @discardableResult
    public func onStatus(_ fn: @escaping (_ hostId: String, _ status: LinkStatus) -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        nextListener += 1
        listeners[nextListener] = fn
        return nextListener
    }

    public func offStatus(_ token: Int) {
        lock.lock(); listeners[token] = nil; lock.unlock()
    }

    /// Host list with the live state (nil when no proxy is open).
    public func list() throws -> [(HostRecord, LinkStatus?)] {
        try store.hosts().map { h in (h, proxy(h.hostId)?.link.status) }
    }

    /// Pair and save (blocking). An open proxy for the same host reconnects with the new credentials.
    @discardableResult
    public func pair(_ payload: String, onCode: (String) -> Void, handle: Pairing = Pairing()) throws -> HostRecord {
        let kp = try store.identity()
        let creds = try Pairing.pair(payload: payload, keyPair: kp, name: name, platform: platform, app: app, onCode: onCode, handle: handle)
        let rec = try store.saveHost(creds)
        if let px = proxy(rec.hostId), let c = try store.credentials(rec.hostId) { px.retryNow(c) }
        return rec
    }

    /// Open (or reuse) the host's proxy. Blocking (binds the port).
    public func open(_ hostId: String) throws -> DeviceProxy {
        lock.lock(); defer { lock.unlock() }
        if let px = proxies[hostId] { return px }
        guard let creds = try store.credentials(hostId) else { throw StateError(description: "unknown-host") }
        let rec = try store.host(hostId)
        let px = DeviceProxy(loop: loop, creds: creds, keyPair: try store.identity(), wantPort: rec?.port ?? 0, app: app, name: name,
                             shell: "mobile", backoff: backoff, connectTimeoutMs: connectTimeoutMs, requestWaitMs: requestWaitMs,
                             texts: texts, log: log, staticCacheFile: staticCacheFile(hostId))
        px.onStatus { [weak self] s in
            guard let self else { return }
            do {
                if s.state == "connected" {
                    try self.store.updateHost(hostId) {
                        $0.lastConnectedAt = nowMs()
                        $0.revokedAt = nil
                        if !s.hostName.isEmpty { $0.hostName = PairingCodec.cleanLabel(s.hostName) }
                    }
                }
                if s.state == "revoked" { try self.store.updateHost(hostId) { $0.revokedAt = nowMs() } }
            } catch {
                self.log("remote device: \(error)")
            }
            self.lock.lock()
            let ls = self.listeners.sorted { $0.key < $1.key }.map(\.value)
            self.lock.unlock()
            for l in ls { l(hostId, s) }
        }
        try px.start()
        if px.port != (rec?.port ?? 0) { try store.updateHost(hostId) { $0.port = px.port } }
        proxies[hostId] = px
        return px
    }

    public func proxy(_ hostId: String) -> DeviceProxy? {
        lock.lock(); defer { lock.unlock() }
        return proxies[hostId]
    }

    public func close(_ hostId: String) {
        lock.lock()
        let px = proxies.removeValue(forKey: hostId)
        lock.unlock()
        px?.close()
    }

    /// 未登録のホストなら nil。
    @discardableResult
    public func rename(_ hostId: String, _ label: String) throws -> HostRecord? {
        try store.updateHost(hostId) { $0.label = PairingCodec.cleanLabel(label) }
    }

    /// Forget the pairing here (the host still lists the device until it is revoked there).
    @discardableResult
    public func remove(_ hostId: String) throws -> HostRecord? {
        close(hostId)
        try? FileManager.default.removeItem(at: staticCacheFile(hostId))
        return try store.removeHost(hostId)
    }

    private func staticCacheFile(_ hostId: String) -> URL {
        store.dir.appendingPathComponent("static", isDirectory: true).appendingPathComponent("\(hostId).bin")
    }

    /// The app became active again: every open proxy listens again and reconnects (ADR 0144). Returns the hosts whose
    /// proxy had to move to another port (their WebView must load the new `url`).
    public func resumeForeground() -> [String] {
        lock.lock()
        let open = proxies
        lock.unlock()
        var moved: [String] = []
        for (hostId, px) in open {
            do {
                if try px.resumeForeground() {
                    moved.append(hostId)
                    try store.updateHost(hostId) { $0.port = px.port }
                }
            } catch {
                log("remote device: cannot listen again for \(hostId): \(error)")
            }
        }
        return moved
    }

    public func closeAll() {
        lock.lock()
        let all = proxies
        proxies = [:]
        lock.unlock()
        for px in all.values { px.close() }
    }
}
