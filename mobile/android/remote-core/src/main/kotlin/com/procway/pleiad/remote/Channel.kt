package com.procway.pleiad.remote

// Kotlin port of core/remote/channel.mjs (docs/remote.md §4): streams multiplexed over the encrypted channel with
// HTTP/2-style credit flow control. Everything here runs on one [Loop] (like Node's event loop in the JS version).
// Callbacks (StreamListener / ChannelListener) are invoked on the loop and must not block; downstream writes happen
// elsewhere and call `release()` when done (release may be called from any thread; it posts to the loop).

import org.json.JSONObject

object ChannelConst {
    const val STREAM_WINDOW = 256 * 1024L
    const val CHANNEL_WINDOW = 1024 * 1024L
    const val MAX_STREAMS = 64
    const val PING_INTERVAL_MS = 20_000L
    const val PING_MISSES = 3
    const val MAX_BUFFERED = 4L * 1024 * 1024
    const val MAX_WS_MESSAGE = 64L * 1024 * 1024
    const val MAX_WINDOW = (1L shl 31) - 1
}

/** code: "protocol" | "version" | "decrypt" | "timeout" | "transport" | "closed" | a GOAWAY code. */
class ChannelError(val code: String, message: String = code, val remote: Boolean = false) : Exception(message)

class StreamResetError(val code: Int) : Exception("stream reset ($code)")

typealias Completion = (Throwable?) -> Unit

/** Release callback: returns the flow-control credit for a delivered chunk. Callable once, from any thread. */
typealias Release = () -> Unit

interface StreamListener {
    fun onResponse(head: JSONObject) {}
    fun onData(chunk: ByteArray, release: Release) { release() }
    fun onEnd() {}
    fun onAccept() {}
    fun onReject(status: Int) {}
    fun onMessage(data: ByteArray, text: Boolean, release: Release) { release() }
    fun onClose(code: Int, reason: String) {}
    fun onReset(code: Int, remote: Boolean) {}
    fun onFinish() {}
}

interface ChannelListener {
    fun onHello(hello: JSONObject) {}
    /** Host side only. Return false to refuse (RESET REFUSED). */
    fun onStream(stream: Stream): Boolean = false
    fun onGoaway(code: String, reason: String) {}
    fun onClose(err: ChannelError?) {}
}

class Stream internal constructor(
    val channel: Channel,
    val id: Long,
    val kind: String,            // "http" | "ws"
    val request: JSONObject,
    val incoming: Boolean,
) {
    var listener: StreamListener = object : StreamListener {}
    var response: JSONObject? = null; internal set
    var accepted = false; internal set
    internal var sendWindow = channel.streamWindow
    internal var recvWindow = channel.streamWindow
    var localDone = false; internal set
    var remoteDone = false; internal set
    var destroyed = false; private set
    var resetCode: Int? = null; private set
    private val queue = ArrayDeque<Item>()
    private var unreleased = 0L
    internal val assembler: WsAssembler? = if (kind == "ws") WsAssembler(channel.maxWsMessage) else null

    private class Item(
        val kind: String,               // "ctl" | "data" | "ws"
        val type: Int = 0,
        val payload: ByteArray? = null,
        val after: (() -> Unit)? = null,
        val data: ByteArray = ByteArray(0),
        var off: Int = 0,
        val text: Boolean = false,
        val done: Completion,
    )

    val closed get() = destroyed || (localDone && remoteDone)

    // ── send (loop only) ──

    fun respond(head: JSONObject, done: Completion = {}) { expect("http", true); ctl(T.HTTP_RES, Frames.jsonEncode(head), null, done) }

    fun write(data: ByteArray, done: Completion = {}) {
        expect("http")
        if (localDone) return done(IllegalStateException("this direction has already ended"))
        enqueue(Item("data", data = data, done = done))
    }

    fun end(done: Completion = {}) {
        expect("http")
        if (localDone) return done(null)
        ctl(T.END, null, { localDone = true }, done)
        localDone = true
    }

    fun accept(done: Completion = {}) { expect("ws", true); ctl(T.WS_ACCEPT, null, null, done) }

    fun reject(status: Int = 502, done: Completion = {}) {
        expect("ws", true)
        if (localDone) return done(null)
        localDone = true
        remoteDone = true
        ctl(T.WS_REJECT, Frames.u16(status), null, done)
    }

    fun send(data: ByteArray, text: Boolean, done: Completion = {}) {
        expect("ws")
        if (localDone) return done(IllegalStateException("WebSocket is already closed"))
        enqueue(Item("ws", data = data, text = text, done = done))
    }

    fun close(code: Int = 1000, reason: String = "", done: Completion = {}) {
        expect("ws")
        if (localDone) return done(null)
        localDone = true
        ctl(T.WS_CLOSE, Frames.encodeWsClose(code, reason), null, done)
    }

    fun reset(code: Int = ResetCode.CANCEL) {
        if (destroyed) return
        channel.sendNow(T.RESET, id, Frames.u16(code))
        destroy(code, false)
    }

    private fun expect(kind: String, incomingOnly: Boolean = false) {
        check(this.kind == kind) { "not available on a ${this.kind} stream" }
        if (incomingOnly) check(incoming) { "only the receiving side can use this" }
    }

    private fun ctl(type: Int, payload: ByteArray?, after: (() -> Unit)?, done: Completion) =
        enqueue(Item("ctl", type = type, payload = payload, after = after, done = done))

    private fun enqueue(item: Item) {
        if (destroyed) return item.done(StreamResetError(resetCode ?: ResetCode.CHANNEL_CLOSED))
        queue.addLast(item)
        channel.pump()
    }

    /** Send the head of the queue if the windows allow. */
    internal fun sendOne(): Boolean {
        val item = queue.firstOrNull() ?: return false
        if (destroyed) return false
        val ch = channel
        if (item.kind == "ctl") {
            ch.sendNow(item.type, id, item.payload)
            queue.removeFirst()
            item.after?.invoke()
            item.done(null)
            maybeFinish()
            return true
        }
        val remaining = item.data.size - item.off
        val avail = minOf(sendWindow, ch.sendWindow)
        if (item.kind == "data") {
            if (remaining == 0) { queue.removeFirst(); item.done(null); return true }
            val n = minOf(Frames.CHUNK.toLong(), remaining.toLong(), avail).toInt()
            if (n <= 0) return false
            val chunk = item.data.copyOfRange(item.off, item.off + n)
            sendWindow -= n; ch.sendWindow -= n
            item.off += n
            ch.sendNow(T.DATA, id, chunk)
        } else {
            // WS_MSG: the 1-byte flag counts against the window
            if (avail < 1) return false
            val n = minOf(Frames.CHUNK.toLong(), remaining.toLong(), avail - 1).toInt()
            if (n == 0 && remaining > 0) return false
            val fin = n == remaining
            val payload = Frames.encodeWsFragment(item.data.copyOfRange(item.off, item.off + n), item.text, fin)
            sendWindow -= payload.size; ch.sendWindow -= payload.size
            item.off += n
            ch.sendNow(T.WS_MSG, id, payload)
            if (!fin) return true
        }
        if (item.off >= item.data.size) { queue.removeFirst(); item.done(null) }
        return true
    }

    // ── receive ──

    internal fun releaser(n: Long): Release {
        unreleased += n
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        return {
            if (done.compareAndSet(false, true)) channel.loop.exec {
                if (!destroyed) {
                    unreleased -= n
                    channel.returnCredit(this, n)
                }
            }
        }
    }

    internal fun onFlow(n: Long) {
        if (n > recvWindow) throw ChannelError("protocol", "stream $id exceeded its window")
        recvWindow -= n
    }

    internal fun destroy(code: Int, remote: Boolean) {
        if (destroyed) return
        destroyed = true
        resetCode = code
        val err = StreamResetError(code)
        val items = queue.toList()
        queue.clear()
        for (it in items) it.done(err)
        if (unreleased > 0 && !channel.closed) channel.returnCredit(null, unreleased)
        unreleased = 0
        channel.forget(this)
        listener.onReset(code, remote)
    }

    internal fun rejectQueued(err: Throwable) {
        val items = queue.toList()
        queue.clear()
        for (it in items) it.done(err)
    }

    internal fun maybeFinish() {
        if (destroyed || !localDone || !remoteDone || queue.isNotEmpty()) return
        channel.forget(this)
        listener.onFinish()
    }
}

class Channel(
    val loop: Loop,
    val role: String,                     // "device" | "host"
    private val sendFn: (ByteArray) -> Unit,
    private val transport: Transport? = null,
    private val hello: JSONObject = JSONObject(),
    val streamWindow: Long = ChannelConst.STREAM_WINDOW,
    channelWindow: Long = ChannelConst.CHANNEL_WINDOW,
    private val maxStreams: Int = ChannelConst.MAX_STREAMS,
    private val pingIntervalMs: Long = ChannelConst.PING_INTERVAL_MS,
    private val pingMisses: Int = ChannelConst.PING_MISSES,
    private val bufferedAmount: (() -> Long)? = null,
    private val maxBuffered: Long = ChannelConst.MAX_BUFFERED,
    val maxWsMessage: Long = ChannelConst.MAX_WS_MESSAGE,
) {
    init { require(role == "device" || role == "host") { "role must be device or host" } }

    var listener: ChannelListener = object : ChannelListener {}
    internal var sendWindow = channelWindow
    private var recvWindow = channelWindow
    private val streams = LinkedHashMap<Long, Stream>()
    private var nextId = if (role == "device") 1L else 2L
    private var lastPeerId = 0L
    var started = false; private set
    var peerHello: JSONObject? = null; private set
    var closed = false; private set
    var closeError: ChannelError? = null; private set
    private var missedPings = 0
    private val pings = HashMap<String, (Throwable?) -> Unit>()
    private var pingTimer: Cancellable? = null
    private var retryTimer: Cancellable? = null
    private var pumping = false
    private var pumpAgain = false

    val streamCount get() = streams.size

    fun start() {
        if (started) return
        started = true
        sendNow(T.HELLO, 0, Frames.jsonEncode(JSONObject(hello.toString()).put("proto", Frames.PROTO)))
        if (pingIntervalMs > 0) schedulePing()
    }

    private fun schedulePing() {
        pingTimer = loop.schedule(pingIntervalMs) {
            if (closed) return@schedule
            tick()
            if (!closed) schedulePing()
        }
    }

    fun openHttp(head: JSONObject) = open("http", T.HTTP_REQ, head)
    fun openWs(head: JSONObject) = open("ws", T.WS_OPEN, head)

    private fun open(kind: String, type: Int, head: JSONObject): Stream {
        check(started) { "cannot open before start()" }
        if (closed) throw ChannelError("closed", "channel is closed")
        check(role == "device") { "the host does not open streams" }
        if (streams.size >= maxStreams) throw ChannelError("streams", "too many concurrent streams")
        val id = nextId
        nextId += 2
        val s = Stream(this, id, kind, head, false)
        streams[id] = s
        sendNow(type, id, Frames.jsonEncode(head))
        return s
    }

    fun ping(done: (Throwable?) -> Unit = {}) {
        if (closed) return done(ChannelError("closed", "channel is closed"))
        val data = randomBytes(8)
        pings[data.toHex()] = done
        sendNow(T.PING, 0, data)
    }

    private fun tick() {
        if (missedPings >= pingMisses) {
            close(ChannelError("timeout", "$pingMisses PINGs went unanswered"))
            return
        }
        missedPings++
        ping()
    }

    fun goaway(code: String, reason: String = "") {
        if (closed) return
        try { sendNow(T.GOAWAY, 0, Frames.jsonEncode(JSONObject().put("code", code).put("reason", reason))) } catch (_: Exception) {}
        close(ChannelError(code, reason))
    }

    fun close(err: ChannelError? = null) {
        if (closed) return
        closed = true
        closeError = err
        pingTimer?.cancel()
        retryTimer?.cancel()
        for (s in streams.values.toList()) s.destroy(ResetCode.CHANNEL_CLOSED, false)
        val ps = pings.values.toList()
        pings.clear()
        for (p in ps) p(err ?: ChannelError("closed", "channel closed"))
        listener.onClose(err)
    }

    // ── send (internal) ──

    internal fun sendNow(type: Int, stream: Long, payload: ByteArray?) {
        if (closed) return
        val frame = Frames.encode(type, stream, payload)
        val bytes = transport?.encrypt(frame) ?: frame
        try { sendFn(bytes) } catch (e: Exception) { close(ChannelError("transport", e.message ?: e.toString())) }
    }

    /** Send what the windows allow, one frame per stream in turn. Also call when the transport drained. */
    fun pump() {
        if (closed) return
        if (pumping) { pumpAgain = true; return }
        pumping = true
        try {
            do {
                pumpAgain = false
                var progressed = true
                while (progressed && !closed) {
                    progressed = false
                    for (s in streams.values.toList()) {
                        if (outboundBlocked()) return
                        if (s.sendOne()) progressed = true
                    }
                }
            } while (pumpAgain && !closed)
        } finally {
            pumping = false
        }
    }

    private fun outboundBlocked(): Boolean {
        val b = bufferedAmount ?: return false
        if (b() <= maxBuffered) return false
        if (retryTimer == null) retryTimer = loop.schedule(10) { retryTimer = null; pump() }
        return true
    }

    internal fun returnCredit(stream: Stream?, n: Long) {
        if (n <= 0 || closed) return
        if (stream != null && !stream.destroyed && !stream.remoteDone) {
            stream.recvWindow += n
            sendNow(T.WINDOW, stream.id, Frames.u32(n))
        }
        recvWindow += n
        sendNow(T.WINDOW, 0, Frames.u32(n))
    }

    internal fun forget(stream: Stream) {
        if (streams[stream.id] === stream) streams.remove(stream.id)
    }

    // ── receive ──

    /** One message (ciphertext) from the transport. Loop only. */
    fun receive(bytes: ByteArray) {
        if (closed) return
        val frame = try {
            transport?.decrypt(bytes) ?: bytes
        } catch (e: Exception) {
            close(ChannelError("decrypt", e.message ?: "decrypt"))
            return
        }
        try {
            dispatch(Frames.decode(frame))
        } catch (e: FrameError) {
            goaway("protocol", e.message ?: "protocol")
        } catch (e: ChannelError) {
            if (e.code == "protocol") goaway("protocol", e.message ?: "protocol") else close(e)
        } catch (e: Exception) {
            close(ChannelError("internal", e.message ?: e.toString()))
        }
    }

    private fun dispatch(f: Frame) {
        val type = f.type
        val id = f.stream
        val payload = f.payload
        if (peerHello == null && type != T.HELLO) throw ChannelError("protocol", "first frame is not HELLO")
        when (type) {
            T.HELLO -> {
                if (peerHello != null) throw ChannelError("protocol", "duplicate HELLO")
                val h = Frames.jsonDecode(payload)
                peerHello = h
                if (h.opt("proto") != Frames.PROTO) { goaway("version", "unsupported proto ${h.opt("proto")}"); return }
                listener.onHello(h)
                return
            }
            T.PING -> {
                if (payload.size != 8) throw FrameError("PING must be 8 bytes")
                sendNow(T.PONG, 0, payload)
                return
            }
            T.PONG -> {
                missedPings = 0
                pings.remove(payload.toHex())?.invoke(null)
                return
            }
            T.GOAWAY -> {
                val g = try { Frames.jsonDecode(payload) } catch (_: FrameError) { JSONObject().put("code", "unknown") }
                val code = g.opt("code")?.toString() ?: "unknown"
                val reason = g.opt("reason")?.toString() ?: ""
                listener.onGoaway(code, reason)
                close(ChannelError(code, reason, remote = true))
                return
            }
            T.WINDOW -> {
                val inc = Frames.readU32(payload)
                if (inc == 0L) throw FrameError("WINDOW increment is 0")
                if (id == 0L) {
                    if (sendWindow + inc > ChannelConst.MAX_WINDOW) throw FrameError("channel window overflow")
                    sendWindow += inc
                } else {
                    val s = streams[id]
                    if (s == null) { checkKnown(id); return }
                    if (s.sendWindow + inc > ChannelConst.MAX_WINDOW) throw FrameError("stream window overflow")
                    s.sendWindow += inc
                }
                pump()
                return
            }
            T.HTTP_REQ, T.WS_OPEN -> { onOpen(type, id, payload); return }
        }

        val flow = if (type == T.DATA || type == T.WS_MSG) payload.size.toLong() else 0L
        if (flow > recvWindow) throw ChannelError("protocol", "channel window exceeded")
        recvWindow -= flow
        val s = streams[id]
        if (s == null) {
            checkKnown(id)
            if (flow > 0) returnCredit(null, flow)
            return
        }
        if (flow > 0) s.onFlow(flow)

        when (type) {
            T.HTTP_RES -> {
                need(s, "http", !s.incoming && s.response == null)
                val head = Frames.jsonDecode(payload)
                s.response = head
                s.listener.onResponse(head)
            }
            T.DATA -> {
                need(s, "http", !s.remoteDone)
                s.listener.onData(payload, s.releaser(flow))
            }
            T.END -> {
                need(s, "http", !s.remoteDone)
                s.remoteDone = true
                s.listener.onEnd()
                s.maybeFinish()
            }
            T.RESET -> s.destroy(Frames.readU16(payload), true)
            T.WS_ACCEPT -> {
                need(s, "ws", !s.incoming && !s.accepted && !s.remoteDone)
                s.accepted = true
                s.listener.onAccept()
            }
            T.WS_REJECT -> {
                need(s, "ws", !s.incoming && !s.accepted && !s.remoteDone)
                val status = Frames.readU16(payload)
                s.remoteDone = true
                s.localDone = true
                s.rejectQueued(IllegalStateException("WebSocket rejected ($status)"))
                s.listener.onReject(status)
                s.maybeFinish()
            }
            T.WS_MSG -> {
                need(s, "ws", !s.remoteDone && (s.incoming || s.accepted))
                val msg = try {
                    s.assembler!!.push(payload)
                } catch (e: FrameError) {
                    if (e.tooLarge) {
                        s.releaser(flow)()
                        s.reset(ResetCode.TOO_LARGE)
                        return
                    }
                    throw e
                }
                if (msg == null) {
                    // A middle fragment is now in the assembler (bounded by maxWsMessage): return its credit at once.
                    s.releaser(flow)()
                    return
                }
                s.listener.onMessage(msg.data, msg.text, s.releaser(flow))
            }
            T.WS_CLOSE -> {
                need(s, "ws", !s.remoteDone)
                val (code, reason) = Frames.decodeWsClose(payload)
                s.remoteDone = true
                s.listener.onClose(code, reason)
                s.maybeFinish()
            }
            else -> throw FrameError("${T.NAMES[type]} is not allowed here")
        }
    }

    private fun need(s: Stream, kind: String, ok: Boolean) {
        if (s.kind != kind || !ok) throw ChannelError("protocol", "frame does not match stream ${s.id}")
    }

    private fun checkKnown(id: Long) {
        val mine = (id % 2 == 1L) == (role == "device")
        if (if (mine) id >= nextId else id > lastPeerId) throw ChannelError("protocol", "stream $id is not open")
    }

    private fun onOpen(type: Int, id: Long, payload: ByteArray) {
        if (role != "host") throw ChannelError("protocol", "devices do not accept streams")
        if (id % 2 != 1L || id <= lastPeerId) throw ChannelError("protocol", "invalid stream id $id")
        lastPeerId = id
        val head = Frames.jsonDecode(payload)
        if (streams.size >= maxStreams) { sendNow(T.RESET, id, Frames.u16(ResetCode.REFUSED)); return }
        val s = Stream(this, id, if (type == T.HTTP_REQ) "http" else "ws", head, true)
        streams[id] = s
        if (!listener.onStream(s)) {
            streams.remove(id)
            sendNow(T.RESET, id, Frames.u16(ResetCode.REFUSED))
        }
    }
}
