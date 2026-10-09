import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import PleiadRemote

/// The bundle reader and the device's saved shell (StaticCache.swift). The Node host's real bundle is covered by InteropTests.
final class StaticCacheTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pleiad-swift-static-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private struct F { let path: String; let type: String; let body: Bytes }

    /// Same shape as encodeBundle in core/remote/static-bundle.mjs.
    private func encode(_ files: [F]) -> (String, Bytes) {
        var h = SHA256()
        for f in files { h.update(data: Bytes("\(f.path)\n\(f.type)\n\(f.body.count)\n".utf8)); h.update(data: f.body) }
        let key = StaticBundleCodec.hex(Bytes(h.finalize()))
        let list: [JSON] = files.map { ["path": .string($0.path), "type": .string($0.type), "size": .int(Int64($0.body.count))] }
        let head = (["format": .int(1), "key": .string(key), "files": .array(list)] as JSON).data
        var out = Bytes("PLSB".utf8)
        out += [UInt8(head.count >> 24 & 0xff), UInt8(head.count >> 16 & 0xff), UInt8(head.count >> 8 & 0xff), UInt8(head.count & 0xff)]
        out += head
        for f in files { out += f.body }
        return (key, out)
    }

    private let v1 = [
        F(path: "/index.html", type: "text/html; charset=utf-8", body: Bytes("<!doctype html><html>v1</html>".utf8)),
        F(path: "/client.mjs", type: "text/javascript; charset=utf-8", body: Bytes(String(repeating: "export const v = 1;\n", count: 500).utf8)),
        F(path: "/empty.css", type: "text/css; charset=utf-8", body: []),
    ]

    func testDecodeAndVerify() throws {
        let (key, raw) = encode(v1)
        let b = try StaticBundleCodec.decode(raw)
        XCTAssertEqual(key, b.key)
        XCTAssertEqual(3, b.files.count)
        XCTAssertEqual("text/javascript; charset=utf-8", b.files["/client.mjs"]?.type)
        XCTAssertEqual(v1[1].body, b.files["/client.mjs"]?.body)
        XCTAssertEqual(0, b.files["/empty.css"]?.body.count)

        func rejects(_ name: String, _ buf: Bytes) { XCTAssertThrowsError(try StaticBundleCodec.decode(buf), name) }
        var changed = raw; changed[changed.count - 3] &+= 1
        rejects("a changed body byte", changed)
        rejects("a truncated bundle", Array(raw.dropLast()))
        rejects("trailing bytes", raw + [0])
        var magic = raw; magic[0] = UInt8(ascii: "X")
        rejects("bad magic", magic)
        rejects("a path with ..", encode([F(path: "/../x.js", type: "text/javascript", body: [1])]).1)
        rejects("a type with a newline", encode([F(path: "/x.js", type: "text/javascript\r\nx-evil: 1", body: [1])]).1)
    }

    // gzip.compress(b"hello pleiad\n" * 20, mtime=0), and the same with FNAME "shell.bin" (python)
    static let gzPlain: Bytes = [31, 139, 8, 0, 0, 0, 0, 0, 2, 10, 203, 72, 205, 201, 201, 87, 40, 200, 73, 205, 76, 76, 225, 202, 24, 153, 28, 0, 138, 65, 183, 148, 4, 1, 0, 0]
    static let gzNamed: Bytes = [31, 139, 8, 8, 0, 0, 0, 0, 2, 255, 115, 104, 101, 108, 108, 46, 98, 105, 110, 0, 203, 72, 205, 201, 201, 87, 40, 200, 73, 205, 76, 76, 225, 202, 24, 153, 28, 0, 138, 65, 183, 148, 4, 1, 0, 0]
    // the first 40 bytes of the same at level 0 (a stored block), and `listHtml` at level 9 (a dynamic Huffman block)
    static let gzStored: Bytes = [31, 139, 8, 0, 0, 0, 0, 0, 4, 10, 1, 40, 0, 215, 255, 104, 101, 108, 108, 111, 32, 112, 108, 101, 105, 97, 100, 10, 104, 101, 108, 108, 111, 32, 112, 108, 101, 105, 97, 100, 10, 104, 101, 108, 108, 111, 32, 112, 108, 101, 105, 97, 100, 10, 104, 92, 209, 19, 49, 40, 0, 0, 0]
    static let gzDynamic: Bytes = [31, 139, 8, 0, 0, 0, 0, 0, 2, 10, 141, 211, 59, 14, 194, 64, 12, 132, 225, 158, 83, 32, 247, 8, 108, 243, 148, 22, 223, 37, 132, 0, 139, 150, 42, 220, 95, 41, 145, 144, 60, 179, 245, 63, 213, 39, 187, 180, 186, 30, 219, 48, 207, 87, 169, 223, 233, 179, 217, 73, 12, 183, 241, 62, 61, 158, 175, 250, 46, 219, 86, 99, 85, 254, 38, 42, 65, 22, 38, 129, 7, 46, 1, 251, 94, 2, 229, 131, 4, 168, 71, 137, 60, 158, 36, 210, 118, 150, 200, 210, 69, 34, 211, 232, 17, 227, 100, 74, 205, 148, 161, 41, 81, 83, 204, 166, 208, 77, 17, 156, 2, 57, 205, 233, 172, 131, 206, 58, 174, 141, 210, 25, 163, 51, 66, 103, 152, 206, 32, 157, 33, 58, 3, 116, 150, 211, 121, 7, 157, 115, 58, 231, 159, 202, 232, 156, 208, 57, 166, 115, 72, 231, 136, 206, 1, 157, 255, 232, 22, 197, 135, 53, 208, 226, 4, 0, 0]
    static let listHtml = Bytes((0..<40).map { "<li class=\"item-\($0)\">\(String("abcdefghij".dropFirst($0 % 10)))</li>\n" }.joined().utf8)

    func testGzipMember() throws {
        let plain = try StaticBundleCodec.gzipMember(Self.gzPlain)
        let named = try StaticBundleCodec.gzipMember(Self.gzNamed)
        XCTAssertEqual(260, plain.isize)
        XCTAssertEqual(Array(plain.deflate), Array(named.deflate))
        XCTAssertThrowsError(try StaticBundleCodec.gzipMember(Array(Self.gzPlain.prefix(17))))
        var notGzip = Self.gzPlain; notGzip[0] = 0
        XCTAssertThrowsError(try StaticBundleCodec.gzipMember(notGzip))
        // FNAME without its terminator inside the member
        XCTAssertThrowsError(try StaticBundleCodec.gzipMember(Array(Self.gzNamed.prefix(19)) + Bytes(repeating: 1, count: 8)))
    }

    func testGunzip() throws {
        let raw = Bytes(String(repeating: "hello pleiad\n", count: 20).utf8)
        XCTAssertEqual(raw, try StaticBundleCodec.gunzip(Self.gzPlain))
        XCTAssertEqual(raw, try StaticBundleCodec.gunzip(Self.gzNamed))
        XCTAssertEqual(Array(raw.prefix(40)), try StaticBundleCodec.gunzip(Self.gzStored))
        XCTAssertEqual(Self.listHtml, try StaticBundleCodec.gunzip(Self.gzDynamic))
        XCTAssertEqual(["accept-encoding": "gzip"], StaticBundleCodec.REQUEST_HEADERS)

        XCTAssertThrowsError(try StaticBundleCodec.gunzip(Self.gzPlain, max: 100))
        XCTAssertThrowsError(try StaticBundleCodec.gunzip(Self.gzDynamic, max: Self.listHtml.count - 1))
        XCTAssertEqual(Self.listHtml, try StaticBundleCodec.gunzip(Self.gzDynamic, max: Self.listHtml.count))
        var badSize = Self.gzPlain; badSize[badSize.count - 4] ^= 1
        XCTAssertThrowsError(try StaticBundleCodec.gunzip(badSize))
        // the deflate cut short (the trailer kept)
        XCTAssertThrowsError(try StaticBundleCodec.gunzip(Array(Self.gzDynamic.prefix(100)) + Array(Self.gzDynamic.suffix(8))))
        var badType = Self.gzPlain; badType[10] |= 6   // block type 3
        XCTAssertThrowsError(try StaticBundleCodec.gunzip(badType))
        var badStored = Self.gzStored; badStored[13] ^= 1   // NLEN no longer the complement of LEN
        XCTAssertThrowsError(try StaticBundleCodec.gunzip(badStored))
    }

    func testCheckSaveReuseAndRefetch() throws {
        let file = dir.appendingPathComponent("static/aaaa.bin")
        let (key1, raw1) = encode(v1)
        var asked: [String] = []
        var hostKey = key1
        var hostRaw = raw1
        var hostStatus = 0   // 0: a current host; otherwise answer this status (an old host: 404)
        let fetch = { (p: String, h: [String: String]) -> StaticFetch in
            asked.append(p)
            XCTAssertEqual(StaticBundleCodec.REQUEST_HEADERS, h)
            let have = p.components(separatedBy: "have=")[1].components(separatedBy: "&")[0]
            if hostStatus != 0 { return StaticFetch(status: hostStatus, headers: [:], body: Bytes("not found".utf8)) }
            if have == hostKey { return StaticFetch(status: 304, headers: [StaticBundleCodec.KEY_HEADER: hostKey], body: []) }
            return StaticFetch(status: 200, headers: [StaticBundleCodec.KEY_HEADER: hostKey], body: hostRaw)
        }

        // first run: nothing saved, the bundle comes whole and is saved as-is
        let c1 = StaticCache(file: file)
        XCTAssertEqual(key1, c1.check(fetch)?.key)
        XCTAssertEqual("\(StaticBundleCodec.PATH)?have=", asked.last)
        XCTAssertEqual(raw1, Bytes(try Data(contentsOf: file)))
        // same proxy, next page load: 304, the held bundle
        XCTAssertEqual(key1, c1.check(fetch)?.key)
        XCTAssertEqual("\(StaticBundleCodec.PATH)?have=\(key1)", asked.last)

        // a new proxy (the app restarted, maybe on another port) reads the saved file: 304
        XCTAssertEqual(key1, StaticCache(file: file).check(fetch)?.key)
        XCTAssertEqual("\(StaticBundleCodec.PATH)?have=\(key1)", asked.last)

        // the host's web/ changed: the new bundle replaces the saved one
        let v2 = v1.map { $0.path == "/index.html" ? F(path: $0.path, type: $0.type, body: Bytes("<!doctype html><html>v2</html>".utf8)) : $0 }
        let (key2, raw2) = encode(v2)
        hostKey = key2; hostRaw = raw2
        let b2 = try XCTUnwrap(StaticCache(file: file).check(fetch))
        XCTAssertEqual(key2, b2.key)
        XCTAssertEqual(Bytes("<!doctype html><html>v2</html>".utf8), b2.files["/index.html"]?.body)
        XCTAssertEqual(raw2, Bytes(try Data(contentsOf: file)))

        // a corrupted saved file is not used: asked with no key, fetched again
        try Data(raw2.dropLast(5)).write(to: file)
        XCTAssertEqual(key2, StaticCache(file: file).check(fetch)?.key)
        XCTAssertEqual("\(StaticBundleCodec.PATH)?have=", asked.last)

        // a host whose key header disagrees with the body is not trusted
        hostKey = String(repeating: "f", count: 64); hostRaw = raw1
        XCTAssertNil(StaticCache(file: dir.appendingPathComponent("static/bbbb.bin")).check(fetch))

        // an old host without the endpoint: nil (the proxy forwards as before), nothing saved
        hostStatus = 404
        XCTAssertNil(StaticCache(file: dir.appendingPathComponent("static/cccc.bin")).check(fetch))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("static/cccc.bin").path))
        // a failing channel: nil too
        XCTAssertNil(StaticCache(file: dir.appendingPathComponent("static/dddd.bin")).check { _, _ in throw StateError(description: "reset") })
    }
}
