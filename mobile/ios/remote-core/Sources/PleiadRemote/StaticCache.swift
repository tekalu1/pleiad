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
// (docs/remote.md §8.6, ADR 0181): the device keeps the host's web/ shell as one bundle per host, and asks the host on
// every page load (/ and /index.html) whether it is still current (GET /static-bundle?have=<key>: 304 when unchanged,
// one round trip). While a checked bundle is held, the proxy answers the WebView's static requests itself.
// An old host without the endpoint (404) or a failed check gives nil, and the proxy forwards to the host as before.
//
// Bundle (big-endian): "PLSB" | u32 header length | header JSON (UTF-8) | the bodies in files order
//   header: { format: 1, key, files: [{ path, type, size }] }
//   key = sha256 hex over, per file in order, "<path>\n<type>\n<size>\n" and the body. Recomputed here, so a torn or
//   corrupted file is never used. Saved uncompressed at <dir>/static/<hostId>.bin (atomic write).
// Transfer: gzip (accept-encoding: gzip -> content-encoding: gzip, the same rule as the host's /bulk/ replies,
// core/bulk-replies.mjs, ADR 0179) where the Compression framework exists (Apple); uncompressed elsewhere (Windows / Linux tests).

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
    /// Limit before and after gunzip (the host's web/ is about 5 MB).
    public static let MAX_BYTES = 64 * 1024 * 1024
    /// Request headers of the check: ask for gzip only where it can be undone.
    #if canImport(Compression)
    public static let REQUEST_HEADERS: [String: String] = ["accept-encoding": "gzip"]
    #else
    public static let REQUEST_HEADERS: [String: String] = [:]
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

    /// One gzip member (RFC 1952): the raw deflate inside and the length from the trailer (ISIZE, mod 2^32).
    /// The CRC is not checked here; the bundle's key (sha256 over every file) is checked after decoding.
    static func gzipMember(_ data: Bytes) throws -> (deflate: ArraySlice<UInt8>, isize: UInt32) {
        guard data.count >= 18, data[0] == 0x1f, data[1] == 0x8b, data[2] == 8 else { throw fail("not gzip") }
        let flags = data[3]
        guard flags & 0xe0 == 0 else { throw fail("bad gzip flags") }
        var at = 10
        func need(_ n: Int) throws { if at + n > data.count - 8 { throw fail("truncated gzip") } }
        if flags & 0x04 != 0 {   // FEXTRA
            try need(2)
            let n = Int(data[at]) | Int(data[at + 1]) << 8
            at += 2
            try need(n)
            at += n
        }
        for bit: UInt8 in [0x08, 0x10] where flags & bit != 0 {   // FNAME, FCOMMENT: zero-terminated
            while true { try need(1); at += 1; if data[at - 1] == 0 { break } }
        }
        if flags & 0x02 != 0 { try need(2); at += 2 }   // FHCRC
        let t = data.count - 4
        let isize = UInt32(data[t]) | UInt32(data[t + 1]) << 8 | UInt32(data[t + 2]) << 16 | UInt32(data[t + 3]) << 24
        return (data[at..<(data.count - 8)], isize)
    }

    /// gzip, at most `max` bytes out. Only where the Compression framework exists.
    public static func gunzip(_ data: Bytes, max: Int = MAX_BYTES) throws -> Bytes {
        #if canImport(Compression)
        let (deflate, isize) = try gzipMember(data)
        var out = Bytes()
        var tooLarge = false
        // Apple's .zlib is raw deflate (no zlib header), which is what gzip wraps
        let filter = try OutputFilter(.decompress, using: .zlib) { (chunk: Data?) in
            guard let chunk else { return }
            if out.count + chunk.count > max { tooLarge = true; throw StaticBundleCodec.fail("too large") }
            out += Bytes(chunk)
        }
        do {
            try filter.write(Data(deflate))
            try filter.finalize()
        } catch {
            throw tooLarge ? fail("too large") : fail("bad gzip")
        }
        guard UInt32(truncatingIfNeeded: out.count) == isize else { throw fail("gzip length mismatch") }
        return out
        #else
        throw fail("gzip is not available here")
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

    /// Ask the host (blocking) and return the bundle that may be served, or nil. `fetch` runs one GET (path, headers) over the channel.
    public func check(_ fetch: (String, [String: String]) throws -> StaticFetch) -> StaticBundle? {
        load()
        let held = bundle
        let have = held?.key ?? ""
        let r: StaticFetch
        do {
            r = try fetch("\(StaticBundleCodec.PATH)?have=\(have)", StaticBundleCodec.REQUEST_HEADERS)
        } catch {
            log("static cache: cannot check (\(error))")
            return nil
        }
        if r.status == 304, let held, r.headers[StaticBundleCodec.KEY_HEADER] == have { return held }
        if r.status != 200 { return nil }   // an old host (404) and the like
        do {
            let raw: Bytes
            switch (r.headers["content-encoding"] ?? "identity").trimmingCharacters(in: .whitespaces).lowercased() {
            case "identity": raw = r.body
            case "gzip": raw = try StaticBundleCodec.gunzip(r.body)
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
