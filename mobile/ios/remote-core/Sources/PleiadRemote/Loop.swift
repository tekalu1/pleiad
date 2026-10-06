import Dispatch
import Foundation

/// A single serial queue. Channel, Stream and DeviceLink state is confined to it (the stand-in for Node's event loop
/// that the JS modules rely on, like Loop.kt). Socket I/O happens on other threads and posts here.
public final class Loop {
    let queue: DispatchQueue
    private let key = DispatchSpecificKey<UInt8>()
    private let lock = NSLock()
    private var stopped = false

    public var onError: (Error) -> Void = { print("pleiad-remote: \($0)") }

    public init(name: String = "pleiad-remote") {
        queue = DispatchQueue(label: name)
        queue.setSpecific(key: key, value: 1)
    }

    public var inLoop: Bool { DispatchQueue.getSpecific(key: key) != nil }

    private var isShutdown: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped
    }

    public func post(_ fn: @escaping () -> Void) {
        if isShutdown { return }
        queue.async { [weak self] in
            guard let self, !self.isShutdown else { return }
            fn()
        }
    }

    /// Run now if already on the loop, otherwise post.
    public func exec(_ fn: @escaping () -> Void) {
        if inLoop { fn() } else { post(fn) }
    }

    @discardableResult
    public func schedule(_ ms: Int, _ fn: @escaping () -> Void) -> Cancellable {
        if isShutdown { return Cancellable {} }
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.isShutdown else { return }
            fn()
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(max(0, ms)), execute: item)
        return Cancellable { item.cancel() }
    }

    /// Run on the loop and wait for the result (never call from the loop itself).
    public func call<R>(_ fn: () throws -> R) rethrows -> R {
        precondition(!inLoop, "Loop.call from the loop would deadlock")
        return try queue.sync(execute: fn)
    }

    public func shutdown() {
        lock.lock()
        stopped = true
        lock.unlock()
    }
}

public struct Cancellable {
    private let fn: () -> Void
    public init(_ fn: @escaping () -> Void) { self.fn = fn }
    public func cancel() { fn() }
}

/// A blocking FIFO for the proxy's per-connection threads (LinkedBlockingQueue in the Kotlin port).
final class BlockingQueue<E> {
    private let cond = NSCondition()
    private var items: [E] = []
    private var head = 0

    func put(_ e: E) {
        cond.lock()
        items.append(e)
        cond.signal()
        cond.unlock()
    }

    /// The next item, waiting up to ms (nil on timeout). ms < 0 waits forever.
    func poll(_ ms: Int = 0) -> E? {
        cond.lock(); defer { cond.unlock() }
        let deadline = Date(timeIntervalSinceNow: Double(ms) / 1000)
        while head >= items.count {
            if ms == 0 { return nil }
            if ms < 0 { cond.wait() } else if !cond.wait(until: deadline) { break }
        }
        return takeLocked()
    }

    func take() -> E { poll(-1)! }

    var isEmpty: Bool {
        cond.lock(); defer { cond.unlock() }
        return head >= items.count
    }

    /// Remove and return everything queued.
    func drain() -> [E] {
        cond.lock(); defer { cond.unlock() }
        let out = Array(items[head...])
        items = []
        head = 0
        return out
    }

    /// Put items back in front of what is queued.
    func prepend(_ es: [E]) {
        cond.lock()
        items = es + Array(items[head...])
        head = 0
        cond.signal()
        cond.unlock()
    }

    private func takeLocked() -> E? {
        guard head < items.count else { return nil }
        let e = items[head]
        head += 1
        if head > 64 && head * 2 > items.count {
            items.removeFirst(head)
            head = 0
        }
        return e
    }
}

/// A thread for blocking work (socket I/O). Foundation's Thread exists on every platform.
func spawn(_ name: String, _ fn: @escaping () -> Void) {
    let t = Thread(block: fn)
    t.name = name
    t.stackSize = 1 << 20
    t.start()
}
