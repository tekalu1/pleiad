import Foundation
#if os(Windows)
import WinSDK
#elseif canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

// Blocking TCP sockets on 127.0.0.1: the loopback proxy's listener (ADR 0141 option A) and, off Apple platforms, the
// test-only WebSocket client to a loopback relay. BSD sockets on Darwin / Linux, Winsock on Windows, so the same proxy
// code runs on iOS and is tested with `swift test` on every platform. One thread per connection (like the Kotlin port).

public struct SocketError: Error, CustomStringConvertible {
    public let description: String
    public var timedOut = false
}

#if os(Windows)
typealias SocketHandle = SOCKET
private let invalidSocket: SOCKET = ~SOCKET(0)
private let winsockReady: Bool = {
    var data = WSADATA()
    return WSAStartup(0x0202, &data) == 0
}()
private func lastError() -> Int32 { WSAGetLastError() }
#else
typealias SocketHandle = Int32
private let invalidSocket: Int32 = -1
private func lastError() -> Int32 { errno }
#endif

private func loopbackAddress(_ port: UInt16, _ ipv4: UInt32 = 0x7f00_0001) -> sockaddr_in {
    var a = sockaddr_in()
    #if os(Windows)
    a.sin_family = ADDRESS_FAMILY(AF_INET)
    a.sin_addr.S_un.S_addr = ipv4.bigEndian
    #else
    #if canImport(Darwin)
    a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    #endif
    a.sin_family = sa_family_t(AF_INET)
    a.sin_addr = in_addr(s_addr: ipv4.bigEndian)
    #endif
    a.sin_port = port.bigEndian
    return a
}

private func newSocket() throws -> SocketHandle {
    #if os(Windows)
    _ = winsockReady
    let s = WinSDK.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP.rawValue)
    #elseif canImport(Darwin)
    let s = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    #else
    let s = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
    #endif
    if s == invalidSocket { throw SocketError(description: "socket() failed (\(lastError()))") }
    #if canImport(Darwin)
    var one: Int32 = 1
    _ = setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    #endif
    return s
}

/// Wakes threads blocked in recv / send on the handle (the number stays allocated).
private func shutdownHandle(_ s: SocketHandle) {
    #if os(Windows)
    _ = WinSDK.shutdown(s, Int32(SD_BOTH))
    #elseif canImport(Darwin)
    _ = Darwin.shutdown(s, SHUT_RDWR)
    #else
    _ = shutdown(s, Int32(SHUT_RDWR))
    #endif
}

/// Frees the handle; its number can be reused by the next socket() / accept() right away.
private func releaseHandle(_ s: SocketHandle) {
    #if os(Windows)
    _ = closesocket(s)
    #elseif canImport(Darwin)
    _ = Darwin.close(s)
    #else
    _ = close(s)
    #endif
}

private func closeHandle(_ s: SocketHandle) {
    shutdownHandle(s)
    releaseHandle(s)
}

/// Waits until the handle is readable (a listener: a connection is pending, or the listener broke). false on timeout.
private func pollReadable(_ s: SocketHandle, _ ms: Int32) -> Bool {
    #if os(Windows)
    var p = WSAPOLLFD(fd: s, events: Int16(POLLRDNORM), revents: 0)
    return WSAPoll(&p, 1, ms) != 0
    #else
    var p = pollfd(fd: s, events: Int16(POLLIN), revents: 0)
    return poll(&p, 1, ms) != 0
    #endif
}

/// IPv4 literal or "localhost" (the only hosts the loopback code needs).
func ipv4Address(_ host: String) -> UInt32? {
    let h = host.lowercased()
    if h == "localhost" { return 0x7f00_0001 }
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var v: UInt32 = 0
    for p in parts {
        guard let n = UInt32(p), n <= 255, !p.isEmpty, p.count <= 3 else { return nil }
        v = v << 8 | n
    }
    return v
}

/// A connected socket. close() may come from any thread while another thread reads or writes: it shuts the socket down
/// at once (waking blocked calls) but frees the handle only when no call is using it, so a reused handle number never
/// reaches a thread that still holds the old one.
public final class TcpSocket {
    private let lock = NSLock()
    private let handle: SocketHandle
    private var isClosed = false
    private var inUse = 0
    private var released = false

    init(_ handle: SocketHandle) { self.handle = handle }

    /// Connect to an IPv4 address (blocking).
    static func connect(host: String, port: UInt16) throws -> TcpSocket {
        guard let ip = ipv4Address(host) else { throw SocketError(description: "only IPv4 literals and localhost are supported here") }
        let s = try newSocket()
        var addr = loopbackAddress(port, ip)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                #if os(Windows)
                WinSDK.connect(s, $0, Int32(MemoryLayout<sockaddr_in>.size))
                #elseif canImport(Darwin)
                Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #else
                Glibc.connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #endif
            }
        }
        if rc != 0 {
            let e = lastError()
            closeHandle(s)
            throw SocketError(description: "connect failed (\(e))")
        }
        let sock = TcpSocket(s)
        sock.setNoDelay()
        return sock
    }

    /// Run fn with the handle unless closed; the handle is not freed while fn runs.
    private func using<R>(_ fn: (SocketHandle) -> R) -> R? {
        lock.lock()
        if isClosed { lock.unlock(); return nil }
        inUse += 1
        lock.unlock()
        let r = fn(handle)
        lock.lock()
        inUse -= 1
        let free = isClosed && inUse == 0 && !released
        if free { released = true }
        lock.unlock()
        if free { releaseHandle(handle) }
        return r
    }

    func setNoDelay() {
        _ = using { s in
            var one: Int32 = 1
            #if os(Windows)
            _ = withUnsafePointer(to: &one) {
                $0.withMemoryRebound(to: CChar.self, capacity: 4) { setsockopt(s, IPPROTO_TCP.rawValue, TCP_NODELAY, $0, 4) }
            }
            #else
            _ = setsockopt(s, Int32(IPPROTO_TCP), TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
            #endif
        }
    }

    /// Receive timeout (0 = none). A read that times out throws SocketError(timedOut: true).
    func setReadTimeout(ms: Int) {
        _ = using { s in
            #if os(Windows)
            var v = DWORD(ms)
            _ = withUnsafePointer(to: &v) {
                $0.withMemoryRebound(to: CChar.self, capacity: 4) { setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, $0, 4) }
            }
            #else
            var tv = timeval(tv_sec: ms / 1000, tv_usec: .init((ms % 1000) * 1000))
            _ = setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            #endif
        }
    }

    /// Read up to max bytes. 0 = the peer closed. Throws on errors and timeouts.
    func read(_ buf: inout Bytes, max: Int) throws -> Int {
        if buf.count < max { buf = Bytes(repeating: 0, count: max) }
        // (bytes, error), the error read before the handle may be freed
        let result: (Int, Int32)? = using { s in
            let n = buf.withUnsafeMutableBytes { p -> Int in
                #if os(Windows)
                Int(recv(s, p.baseAddress!.assumingMemoryBound(to: CChar.self), Int32(max), 0))
                #else
                recv(s, p.baseAddress!, max, 0)
                #endif
            }
            return (n, n < 0 ? lastError() : 0)
        }
        guard let (n, e) = result else { throw SocketError(description: "socket closed") }
        if n < 0 {
            #if os(Windows)
            let timeout = e == WSAETIMEDOUT
            #else
            let timeout = e == EAGAIN || e == EWOULDBLOCK
            #endif
            throw SocketError(description: "recv failed (\(e))", timedOut: timeout)
        }
        return n
    }

    /// Write everything (blocking).
    func write(_ data: Bytes) throws {
        // nil = closed; .some(nil) = all written; .some(e) = send failed with e
        let outcome: Int32?? = using { s in
            var off = 0
            while off < data.count {
                let n = data.withUnsafeBytes { p -> Int in
                    let base = p.baseAddress! + off
                    let len = Swift.min(data.count - off, 1 << 20)
                    #if os(Windows)
                    return Int(send(s, base.assumingMemoryBound(to: CChar.self), Int32(len), 0))
                    #elseif canImport(Darwin)
                    return send(s, base, len, 0)
                    #else
                    return send(s, base, len, Int32(MSG_NOSIGNAL))
                    #endif
                }
                if n <= 0 { return Optional(lastError()) }
                off += n
            }
            return Optional<Int32>.none
        }
        guard let failed = outcome else { throw SocketError(description: "socket closed") }
        if let e = failed { throw SocketError(description: "send failed (\(e))") }
    }

    /// Close (idempotent, any thread). Wakes a thread blocked in read; the last user frees the handle.
    public func close() {
        lock.lock()
        if isClosed { lock.unlock(); return }
        isClosed = true
        let free = inUse == 0
        if free { released = true }
        lock.unlock()
        shutdownHandle(handle)
        if free { releaseHandle(handle) }
    }
}

/// Buffered reads over a TcpSocket.
final class SocketReader {
    let socket: TcpSocket
    private var buf = Bytes(repeating: 0, count: 64 * 1024)
    private var start = 0
    private var end = 0

    init(_ socket: TcpSocket) { self.socket = socket }

    private func fill() throws -> Bool {
        start = 0
        end = try socket.read(&buf, max: buf.count)
        return end > 0
    }

    /// One byte, or nil at the end of the stream.
    func readByte() throws -> UInt8? {
        if start >= end, try !fill() { return nil }
        defer { start += 1 }
        return buf[start]
    }

    /// Exactly n bytes; the end of the stream before that is an error.
    func readFully(_ n: Int) throws -> Bytes {
        var out = Bytes()
        out.reserveCapacity(n)
        while out.count < n {
            if start >= end, try !fill() { throw SocketError(description: "unexpected end of stream") }
            let take = Swift.min(n - out.count, end - start)
            out += buf[start..<start + take]
            start += take
        }
        return out
    }
}

/// A listener on 127.0.0.1 (never on other interfaces).
/// accept() waits in short poll() slices, so close() never frees the handle under a blocked accept() (a reused number
/// would hand the next listener's connections to the old accept loop). close() waits for the slice to end (<= 250 ms)
/// and then frees the port, so listening again on the same port right after works.
final class TcpListener {
    private let cond = NSCondition()
    private let handle: SocketHandle
    private var isClosed = false
    private var accepting = false
    private var released = false
    let port: Int

    /// port 0 = any free port. Throws when the port is taken.
    init(port: Int, backlog: Int32 = 64) throws {
        let s = try newSocket()
        #if !os(Windows)
        // POSIX: allow re-listening on the same port while old connections sit in TIME_WAIT (the proxy keeps its port,
        // and so its origin, across the iOS background / foreground cycle). Not on Windows, where SO_REUSEADDR would
        // let another process bind the same port.
        var one: Int32 = 1
        _ = setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        #endif
        var addr = loopbackAddress(UInt16(clamping: port))
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                #if os(Windows)
                bind(s, $0, Int32(MemoryLayout<sockaddr_in>.size))
                #else
                bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #endif
            }
        }
        if rc != 0 {
            let e = lastError()
            closeHandle(s)
            throw SocketError(description: "bind 127.0.0.1:\(port) failed (\(e))")
        }
        if listen(s, backlog) != 0 {
            let e = lastError()
            closeHandle(s)
            throw SocketError(description: "listen failed (\(e))")
        }
        var bound = sockaddr_in()
        #if os(Windows)
        var len = Int32(MemoryLayout<sockaddr_in>.size)
        #else
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        #endif
        _ = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) }
        }
        handle = s
        self.port = Int(UInt16(bigEndian: bound.sin_port))
    }

    /// The next connection (blocking). Throws once closed, or when the listener broke (iOS reclaims the listening
    /// sockets of suspended apps).
    func accept() throws -> TcpSocket {
        while true {
            cond.lock()
            if isClosed { cond.unlock(); throw SocketError(description: "listener closed") }
            accepting = true
            cond.unlock()
            var c = invalidSocket
            var err: Int32 = 0
            if pollReadable(handle, 250) {
                #if os(Windows)
                c = WinSDK.accept(handle, nil, nil)
                #elseif canImport(Darwin)
                c = Darwin.accept(handle, nil, nil)
                #else
                c = Glibc.accept(handle, nil, nil)
                #endif
                if c == invalidSocket { err = lastError() }
            }
            cond.lock()
            accepting = false
            let closed = isClosed
            cond.broadcast()
            cond.unlock()
            if closed {
                if c != invalidSocket { closeHandle(c) }
                throw SocketError(description: "listener closed")
            }
            if c == invalidSocket {
                if err != 0 { throw SocketError(description: "accept failed (\(err))") }
                continue      // the poll slice ended without a connection
            }
            #if canImport(Darwin)
            var one: Int32 = 1
            _ = setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            #endif
            let sock = TcpSocket(c)
            sock.setNoDelay()
            return sock
        }
    }

    /// Stop listening and free the port (waits for a running accept slice to end, at most about 250 ms).
    func close() {
        cond.lock()
        if isClosed { cond.unlock(); return }
        isClosed = true
        while accepting { cond.wait() }
        let free = !released
        released = true
        cond.unlock()
        if free { closeHandle(handle) }
    }
}
