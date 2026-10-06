import Foundation
import XCTest
@testable import PleiadRemote

/// The repository root (PLEIAD_REPO, or found from this file: mobile/ios/remote-core/Tests/PleiadRemoteTests/).
func repoRoot() -> URL {
    if let r = ProcessInfo.processInfo.environment["PLEIAD_REPO"], !r.isEmpty { return URL(fileURLWithPath: r) }
    var u = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { u.deleteLastPathComponent() }
    return u
}

/// tests/remote/vectors.json: the same file Node (tests/unit/remote-noise.mjs, remote-frames.mjs) and Kotlin read.
func loadVectors() throws -> JSON {
    let path = ProcessInfo.processInfo.environment["PLEIAD_VECTORS"]
        ?? repoRoot().appendingPathComponent("tests/remote/vectors.json").path
    return try JSON.parse(Bytes(try Data(contentsOf: URL(fileURLWithPath: path))))
}

final class X25519Tests: XCTestCase {
    func testRfc7748() throws {
        // RFC 7748 §5.2 first vector
        XCTAssertEqual(
            "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
            try X25519.dh(
                hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
                hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
            ).hexString
        )
        // RFC 7748 §6.1 (Alice / Bob)
        let a = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        let b = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        XCTAssertEqual("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", try X25519.publicKey(a).hexString)
        XCTAssertEqual("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", try X25519.publicKey(b).hexString)
        XCTAssertEqual(
            "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
            try X25519.dh(a, try X25519.publicKey(b)).hexString
        )
    }

    func testRejectsZeroResult() {
        XCTAssertThrowsError(try X25519.dh(randomBytes(32), Bytes(repeating: 0, count: 32)), "small-order point accepted")
    }
}

final class NoiseVectorsTests: XCTestCase {
    private func runVector(_ v: JSON) throws {
        let pattern: Pattern
        switch v["protocol_name"]?.string {
        case NoiseConst.PROTOCOL_IK: pattern = .IK
        case NoiseConst.PROTOCOL_IKPSK2: pattern = .IKpsk2
        default: XCTFail("unexpected protocol"); return
        }
        let initPsk = v["init_psks"]?.array?.first?.string.map(hex)
        let respPsk = v["resp_psks"]?.array?.first?.string.map(hex)
        let initiator = try Handshake(
            pattern, initiator: true, prologue: hex(v["init_prologue"]!.string!),
            staticKey: try KeyPair.fromPrivate(hex(v["init_static"]!.string!)),
            remoteStatic: hex(v["init_remote_static"]!.string!), psk: initPsk, ephemeral: hex(v["init_ephemeral"]!.string!)
        )
        let responder = try Handshake(
            pattern, initiator: false, prologue: hex(v["resp_prologue"]!.string!),
            staticKey: try KeyPair.fromPrivate(hex(v["resp_static"]!.string!)),
            psk: respPsk, ephemeral: hex(v["resp_ephemeral"]!.string!)
        )
        let msgs = v["messages"]!.array!
        // handshake: message 0 (init -> resp), 1 (resp -> init)
        for i in 0..<2 {
            let m = msgs[i]
            let (w, r) = i == 0 ? (initiator, responder) : (responder, initiator)
            let ct = try w.writeMessage(hex(m["payload"]!.string!))
            XCTAssertEqual(m["ciphertext"]!.string!, ct.hexString, "\(pattern) message \(i)")
            XCTAssertEqual(m["payload"]!.string!, try r.readMessage(ct).hexString)
        }
        XCTAssertEqual(v["handshake_hash"]!.string!, initiator.handshakeHash.hexString)
        XCTAssertEqual(v["handshake_hash"]!.string!, responder.handshakeHash.hexString)
        let ti = try initiator.split()
        let tr = try responder.split()
        for i in 2..<msgs.count {
            let m = msgs[i]
            let initSends = i % 2 == 0
            let payload = hex(m["payload"]!.string!)
            let ct = initSends ? try ti.encrypt(payload) : try tr.encrypt(payload)
            XCTAssertEqual(m["ciphertext"]!.string!, ct.hexString, "\(pattern) transport \(i)")
            let pt = initSends ? try tr.decrypt(ct) : try ti.decrypt(ct)
            XCTAssertEqual(m["payload"]!.string!, pt.hexString)
        }
    }

    func testCacophonyVectors() throws {
        let noise = try loadVectors()["noise"]!.array!
        XCTAssertEqual(2, noise.count)
        for v in noise { try runVector(v) }
    }

    func testTamperedTransportFails() throws {
        let host = KeyPair.generate()
        let dev = KeyPair.generate()
        let i = try Handshake(.IK, initiator: true, prologue: Pleiad.prologueFor("x"), staticKey: dev, remoteStatic: host.publicKey)
        let r = try Handshake(.IK, initiator: false, prologue: Pleiad.prologueFor("x"), staticKey: host)
        _ = try r.readMessage(try i.writeMessage(Bytes("hi".utf8)))
        XCTAssertEqual(dev.publicKey, r.rs)
        _ = try i.readMessage(try r.writeMessage())
        let ti = try i.split()
        let tr = try r.split()
        var ct = try ti.encrypt(Bytes("hello".utf8))
        ct[0] ^= 1
        XCTAssertThrowsError(try tr.decrypt(ct)) { XCTAssertTrue($0 is DecryptError) }
    }

    func testPleiadDerivations() throws {
        let p = try loadVectors()["pleiad"]!
        let pairing = p["pairing"]!
        let keys = try Pleiad.derivePairing(hex(pairing["secret"]!.string!))
        XCTAssertEqual(pairing["psk"]!.string!, keys.psk.hexString)
        XCTAssertEqual(pairing["ticket"]!.string!, keys.ticket.hexString)
        XCTAssertEqual(pairing["ticketHash"]!.string!, keys.ticketHash.hexString)
        let host = p["host"]!
        let kp = try KeyPair.fromPrivate(hex(host["privateKey"]!.string!))
        XCTAssertEqual(host["publicKey"]!.string!, kp.publicKey.hexString)
        XCTAssertEqual(host["hostId"]!.string!, try Pleiad.hostIdFor(kp.publicKey))
        XCTAssertEqual(host["prologue"]!.string!, Pleiad.prologueFor(host["hostId"]!.string!).hexString)
        for c in p["confirmation"]!.array! {
            XCTAssertEqual(c["code"]!.string!, try Pleiad.confirmationCode(hex(c["handshakeHash"]!.string!)))
        }
        XCTAssertEqual("482 193", Pleiad.formatConfirmationCode("482193"))
    }
}

final class FramesVectorsTests: XCTestCase {
    func testFrames() throws {
        let frames = try loadVectors()["frames"]!.array!
        XCTAssertGreaterThanOrEqual(frames.count, 17)
        for f in frames {
            let payload = hex(f["payload"]!.string!)
            let type = Int(f["type"]!.int!)
            let stream = UInt32(f["stream"]!.int!)
            let enc = try Frames.encode(type, stream, payload)
            XCTAssertEqual(f["frame"]!.string!, enc.hexString, f["name"]!.string!)
            let dec = try Frames.decode(hex(f["frame"]!.string!))
            XCTAssertEqual(type, dec.type)
            XCTAssertEqual(stream, dec.stream)
            XCTAssertEqual(payload, dec.payload)
        }
    }

    func testRejectsMalformed() {
        let bad = [
            "0100",          // too short
            "ff00000000",    // unknown type
            "0100000001",    // HELLO off stream 0
            "1200000000",    // DATA on stream 0
        ]
        for b in bad { XCTAssertThrowsError(try Frames.decode(hex(b)), b) { XCTAssertTrue($0 is FrameError) } }
    }

    func testAssembler() throws {
        let a = WsAssembler(maxBytes: 10)
        XCTAssertNil(try a.push(Frames.encodeWsFragment(Bytes("abc".utf8), text: true, fin: false)))
        let m = try a.push(Frames.encodeWsFragment(Bytes("de".utf8), text: true, fin: true))!
        XCTAssertEqual("abcde", m.data.utf8String)
        XCTAssertTrue(m.text)
        XCTAssertThrowsError(try a.push(Frames.encodeWsFragment(Bytes(repeating: 0, count: 11), text: false, fin: true))) {
            XCTAssertTrue(($0 as? FrameError)?.tooLarge == true)
        }
    }
}

final class JSONTests: XCTestCase {
    func testRoundTrip() throws {
        let v = try JSON.parse(#"{"a":[1,-2.5,true,null,"xé😀\n"],"b":{"c":12345678901234}}"#)
        XCTAssertEqual(v["a"]?.array?[0], .int(1))
        XCTAssertEqual(v["a"]?.array?[1], .double(-2.5))
        XCTAssertEqual(v["a"]?.array?[4].string, "xé😀\n")
        XCTAssertEqual(v["b"]?["c"]?.int, 12345678901234)
        XCTAssertEqual(try JSON.parse(v.serialized), v)
        XCTAssertEqual((["k": "a\"b\\/\u{1}"] as JSON).serialized, #"{"k":"a\"b\\/\u0001"}"#)
    }

    func testRejectsBrokenJson() {
        for s in ["", "{", "{\"a\":}", "[1,]", "01", "\"\u{1}\"", "{} x", "nul"] {
            XCTAssertThrowsError(try JSON.parse(s), s)
        }
        XCTAssertThrowsError(try Frames.jsonDecode(Bytes("[1]".utf8)), "an array is not an object")
    }
}
