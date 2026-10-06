import Foundation
import XCTest
@testable import PleiadRemote

/// Waits for a count (CountDownLatch in the Kotlin tests).
final class Latch {
    private let cond = NSCondition()
    private var count: Int
    init(_ count: Int) { self.count = count }
    func countDown() {
        cond.lock(); count -= 1; cond.broadcast(); cond.unlock()
    }
    func await(_ seconds: Double) -> Bool {
        cond.lock(); defer { cond.unlock() }
        let deadline = Date(timeIntervalSinceNow: seconds)
        while count > 0 { if !cond.wait(until: deadline) { return count <= 0 } }
        return true
    }
}

/// A value shared between the loop and the test thread.
final class Box<V> {
    private let lock = NSLock()
    private var v: V
    init(_ v: V) { self.v = v }
    var value: V {
        get { lock.lock(); defer { lock.unlock() }; return v }
        set { lock.lock(); v = newValue; lock.unlock() }
    }
}

/// Device and host channels connected by an in-memory pipe over a real Noise transport (like ChannelTest.kt and
/// tests/unit/remote-channel.mjs).
final class ChannelTests: XCTestCase {
    private var loop: Loop!

    override func setUp() { loop = Loop(name: "test-loop") }
    override func tearDown() { loop.shutdown() }

    private func pair() throws -> (Channel, Channel) {
        let host = KeyPair.generate()
        let dev = KeyPair.generate()
        let i = try Handshake(.IK, initiator: true, prologue: Pleiad.prologueFor("h"), staticKey: dev, remoteStatic: host.publicKey)
        let r = try Handshake(.IK, initiator: false, prologue: Pleiad.prologueFor("h"), staticKey: host)
        _ = try r.readMessage(try i.writeMessage())
        _ = try i.readMessage(try r.writeMessage())
        let loop = self.loop!
        var d: Channel!
        var h: Channel!
        d = Channel(loop: loop, role: "device", send: { b in loop.post { h.receive(b) } }, transport: try i.split(),
                    hello: ["app": "t", "shell": "mobile"], pingIntervalMs: 0)
        h = Channel(loop: loop, role: "host", send: { b in loop.post { d.receive(b) } }, transport: try r.split(),
                    hello: ["hostName": "hn"], pingIntervalMs: 0)
        return (d, h)
    }

    func testHttpLargeBodyWithFlowControl() throws {
        let (d, h) = try pair()
        let body = randomBytes(3 * 1024 * 1024 + 123)   // > channel window: needs WINDOW round trips
        let got = Box(Bytes())
        let latch = Latch(1)
        let status = Box(0)
        let hostName = Box("")
        loop.call {
            let hl = ChannelListener()
            hl.onStream = { stream in
                XCTAssertEqual("/big", stream.request["path"]?.string)
                stream.respond(["status": 200, "headers": [:]])
                stream.write(body)
                stream.end()
                return true
            }
            h.listener = hl
            let dl = ChannelListener()
            dl.onHello = { hostName.value = $0["hostName"]?.string ?? "" }
            d.listener = dl
            h.start()
            d.start()
        }
        Thread.sleep(forTimeInterval: 0.1)
        try loop.call {
            let s = try d.openHttp(["method": "GET", "path": "/big", "headers": [:]])
            let l = StreamListener()
            l.onResponse = { status.value = Int($0["status"]?.int ?? 0) }
            // release later from another thread, like the proxy does after writing to the socket
            l.onData = { chunk, release in
                got.value += chunk
                spawn("release") { release() }
            }
            l.onEnd = { latch.countDown() }
            s.listener = l
            s.end()
        }
        XCTAssertTrue(latch.await(20), "body completes")
        XCTAssertEqual(200, status.value)
        XCTAssertEqual("hn", hostName.value)
        XCTAssertEqual(body, got.value)
    }

    func testWsMessagesBothWaysIncludingLargeOnes() throws {
        let (d, h) = try pair()
        let big = randomBytes(700 * 1024)
        let latch = Latch(2)
        let echoed = Box<Bytes?>(nil)
        let lastText = Box<String?>(nil)
        loop.call {
            let hl = ChannelListener()
            hl.onStream = { stream in
                let sl = StreamListener()
                sl.onMessage = { data, text, release in
                    release()
                    stream.send(data, text: text)
                }
                stream.listener = sl
                stream.accept()
                stream.send(Bytes("ready".utf8), text: true)   // sent right after ACCEPT, like the host's `ready`
                return true
            }
            h.listener = hl
            h.start()
            d.start()
        }
        Thread.sleep(forTimeInterval: 0.1)
        try loop.call {
            let s = try d.openWs(["path": "/ws", "protocols": []])
            let l = StreamListener()
            l.onAccept = { s.send(big, text: false) }
            l.onMessage = { data, text, release in
                release()
                if text { lastText.value = data.utf8String } else { echoed.value = data }
                latch.countDown()
            }
            s.listener = l
        }
        XCTAssertTrue(latch.await(20))
        XCTAssertEqual("ready", lastText.value)
        XCTAssertEqual(big, echoed.value)
    }

    func testProtocolViolationSendsGoaway() throws {
        let (d, h) = try pair()
        let closed = Latch(1)
        let code = Box<String?>(nil)
        loop.call {
            let dl = ChannelListener()
            dl.onClose = { code.value = $0?.code; closed.countDown() }
            d.listener = dl
            h.start()
            d.start()
        }
        Thread.sleep(forTimeInterval: 0.1)
        // host sends DATA on a stream that was never opened
        loop.call { h.sendNow(T.DATA, 1, Bytes("x".utf8)) }
        XCTAssertTrue(closed.await(5))
        XCTAssertEqual("protocol", code.value)
    }

    func testWrongProtoGetsGoawayVersion() throws {
        let (d, h) = try pair()
        let closed = Latch(1)
        let code = Box<String?>(nil)
        loop.call {
            let hl = ChannelListener()
            hl.onClose = { code.value = $0?.code; closed.countDown() }
            h.listener = hl
            h.start()
            // a HELLO with proto 2 instead of start()
            d.sendNow(T.HELLO, 0, Frames.jsonEncode(["proto": 2]))
        }
        XCTAssertTrue(closed.await(5))
        XCTAssertEqual("version", code.value)
    }
}
