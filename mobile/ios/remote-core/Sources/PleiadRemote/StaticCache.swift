import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if canImport(Compression)
import Compression
#endif

// Swift port of StaticCache.kt / core/remote/static-cache.mjs and the reader of core/remote/static-bundle.mjs
// (docs/remote.md §8.6, ADR 0901): the device keeps the host's web/ shell as one bundle per host, and asks the host on
// every page load (/ and /index.html) whether it is still current (GET /static-bundle?have=<key>: 304 when unchanged,
// one round trip). While a checked bundle is held, the proxy answers the WebView's static requests itself.
// An old host without the endpoint (404) or a failed check gives nil, and the proxy forwards to the host as before.
//
// Bundle (big-endian): "PLSB" | u32 header length | header JSON (UTF-8) | the bodies in files order
//   header: { format: 1, key, files: [{ path, type, size }] }
//   key = sha256 hex over, per file in order, "<path>\n<type>\n<size>\n" and the body. Recomputed here, so a torn or
//   corrupted file is never used. Saved uncompressed at <dir>/static/<hostId>.bin (atomic write).
// Transfer: raw deflate where the Compression framework exists (Apple), uncompressed elsewhere (Windows / Linux tests).

public struct StaticFile {
    public let type: String
    public let body: Bytes
}

public struct StaticBundle {
    public let key: String
    public let files: [String: StaticFile]
}

/// One HTTP response read whole (header names lower-cased).
public struct StaticFetch {
    public let status: Int
    public let headers: [String: String]
    public let body: Bytes
    public init(status: Int, headers: [String: String], body: Bytes) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

public enum StaticBundleCodec {
    public static let PATH = "/static-bundle"
    public static let FORMAT: Int64 = 1
    public static let KEY_HEADER = "x-pleiad-bundle-key"
    public static let ENCODING_HEADER = "x-pleiad-bundle-encoding"
    /// Limit before and after inflating (the host's web/ is about 5 MB).
    public static let MAX_BYTES = 64 * 1024 * 1024
    #if canImport(Compression)
    public static let REQUEST_ENCODING = "deflate-raw"
    #else
    public static let REQUEST_ENCODING = "identity"
    #endif

    private static func fail(_ what: String) -> StateError { StateError(description: "static bundle: \(what)") }

    private static func validPath(_ p: String) -> Bool {
        guard p.hasPrefix("/"), p.utf8.count > 1, !p.contains("..") else { return false }
        for c in p.utf8 {
            let ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 46 || c == 95 || c == 45 || c == 47
            if !ok { return false }
        }
        return true
    }

    private static func validKey(_ k: String) -> Bool {
        k.utf8.count == 64 && k.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    static func hex(_ b: Bytes) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = Bytes()
        out.reserveCapacity(b.count * 2)
        for x in b { out.append(digits[Int(x >> 4)]); out.append(digits[Int(x & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// Throws when the magic, the header, the sizes or the key do not match.
    public static func decode(_ buf: Bytes) throws -> StaticBundle {
        guard buf.count >= 8, Array(buf[0..<4]) == Bytes("PLSB".utf8) else { throw fail("bad magic") }
        let headLen = Int(buf[4]) << 24 | Int(buf[5]) << 16 | Int(buf[6]) << 8 | Int(buf[7])
        guard headLen <= buf.count - 8 else { throw fail("bad header length") }
        let head = try JSON.parse(Array(buf[8..<(8 + headLen)]))
        guard case .int(let format)? = head["format"], format == FORMAT,
              let key = head["key"]?.string, validKey(key), let list = head["files"]?.array else { throw fail("bad header") }
        var h = SHA256()
        var files: [String: StaticFile] = [:]
        var at = 8 + headLen
        for f in list {
            guard let path = f["path"]?.string, validPath(path), let type = f["type"]?.string,
                  !type.contains("\r"), !type.contains("\n"),
                  case .int(let size64)? = f["size"], size64 >= 0, size64 <= Int64(buf.count - at) else { throw fail("bad entry") }
            let size = Int(size64)
            let body = Array(buf[at..<(at + size)])
            at += size
            h.update(data: Bytes("\(path)\n\(type)\n\(size)\n".utf8))
            h.update(data: body)
            files[path] = StaticFile(type: type, body: body)
        }
        guard at == buf.count else { throw fail("trailing bytes") }
        guard hex(Bytes(h.finalize())) == key else { throw fail("key mismatch") }
        return StaticBundle(key: key, files: files)
    }

    /// Raw deflate (RFC 1951), at most `max` bytes out. Only where the Compression framework exists.
    public static func inflateRaw(_ data: Bytes, max: Int = MAX_BYTES) throws -> Bytes {
        #if canImport(Compression)
        var out = Bytes()
        var tooLarge = false
        // Apple's .zlib is raw deflate (no zlib header)
        let filter = try OutputFilter(.decompress, using: .zlib) { (chunk: Data?) in
            guard let chunk else { return }
            if out.count + chunk.count > max { tooLarge = true; throw StaticBundleCodec.fail("too large") }
            out += Bytes(chunk)
        }
        do {
            try filter.write(Data(data))
            try filter.finalize()
        } catch {
            throw tooLarge ? fail("too large") : fail("bad deflate")
        }
        return out
        #else
        throw fail("deflate-raw is not available here")
        #endif
    }
}

public final class StaticCache {
    public let file: URL
    private let log: (String) -> Void
    private let lock = NSLock()
    private var loaded = false
    private var _bundle: StaticBundle?

    public init(file: URL, log: @escaping (String) -> Void = { _ in }) {
        self.file = file
        self.log = log
    }

    public var bundle: StaticBundle? { lock.lock(); defer { lock.unlock() }; return _bundle }

    /// Read the saved bundle once. Missing or broken: keep nothing.
    public func load() {
        lock.lock(); defer { lock.unlock() }
        if loaded { return }
        loaded = true
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            _bundle = try StaticBundleCodec.decode(Bytes(try Data(contentsOf: file)))
        } catch {
            log("static cache: not using the saved bundle (\(error))")
        }
    }

    /// Ask the host (blocking) and return the bundle that may be served, or nil. `fetch` runs one GET over the channel.
    public func check(_ fetch: (String) throws -> StaticFetch) -> StaticBundle? {
        load()
        let held = bundle
        let have = held?.key ?? ""
        let r: StaticFetch
        do {
            r = try fetch("\(StaticBundleCodec.PATH)?have=\(have)&enc=\(StaticBundleCodec.REQUEST_ENCODING)")
        } catch {
            log("static cache: cannot check (\(error))")
            return nil
        }
        if r.status == 304, let held, r.headers[StaticBundleCodec.KEY_HEADER] == have { return held }
        if r.status != 200 { return nil }   // an old host (404) and the like
        do {
            let raw: Bytes
            switch r.headers[StaticBundleCodec.ENCODING_HEADER] ?? "identity" {
            case "identity": raw = r.body
            case "deflate-raw": raw = try StaticBundleCodec.inflateRaw(r.body)
            case let enc: throw StateError(description: "unknown encoding \(enc)")
            }
            let b = try StaticBundleCodec.decode(raw)
            if let k = r.headers[StaticBundleCodec.KEY_HEADER], k != b.key { throw StateError(description: "key header mismatch") }
            lock.lock(); _bundle = b; lock.unlock()
            do {
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(raw).write(to: file, options: .atomic)
            } catch {
                log("static cache: cannot save (\(error))")
            }
            return b
        } catch {
            log("static cache: not using the bundle (\(error))")
            return nil
        }
    }
}
