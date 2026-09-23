package com.procway.pleiad.remote

// The WebSocket to the relay (openRelaySocket in core/remote/device-link.mjs). Incoming messages are queued in order:
// next() takes one (blocking, for the handshake), drainTo() hands the queue and everything after it to a sink.
// Call drainTo() only after the consumer's listeners are attached (the ordering race found in the desktop work:
// message 2 of the handshake and the host's HELLO can arrive in the same read).

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

class RelayClosed(val code: Int, val reason: String) : Exception("relay connection closed ($code)")
class RelayTimeout(msg: String) : Exception(msg)

/** Result of the opening: open, an HTTP status before Upgrade, a close code, or an error. */
data class OpenResult(val open: Boolean = false, val status: Int? = null, val closeCode: Int? = null, val error: String? = null)

object Http {
    /** One client for the process: shares the connection pool and threads. No automatic redirects (like followRedirects: false). */
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .pingInterval(0, TimeUnit.MILLISECONDS)   // the relay pings us (§4.4); PING frames in the channel do the rest
            .build()
    }
}

class RelaySocket(url: String, headers: Map<String, String>, openTimeoutMs: Long = 10_000, client: OkHttpClient = Http.client) {
    private val lock = Object()
    private val inbox = ArrayDeque<ByteArray>()
    private var sink: ((ByteArray) -> Unit)? = null
    private var closeListeners = mutableListOf<(RelayClosed) -> Unit>()
    @Volatile var closed: RelayClosed? = null; private set
    @Volatile private var openResult: OpenResult? = null
    private val openLatch = CountDownLatch(1)
    private val openTimeoutMs = openTimeoutMs
    val ws: WebSocket

    init {
        val c = client.newBuilder()
            .connectTimeout(openTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val req = Request.Builder().url(url).apply { for ((k, v) in headers) header(k, v) }.build()
        ws = c.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = settleOpen(OpenResult(open = true))

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = deliver(bytes.toByteArray())

            override fun onMessage(webSocket: WebSocket, text: String) = deliver(text.toByteArray(Charsets.UTF_8))

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                try { webSocket.close(1000, null) } catch (_: Exception) {}
                markClosed(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = markClosed(code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response != null && openResult == null) settleOpen(OpenResult(status = response.code))
                else settleOpen(OpenResult(error = t.message ?: t.toString()))
                response?.close()
                markClosed(1006, t.message ?: "")
            }
        })
    }

    private fun settleOpen(r: OpenResult) {
        synchronized(lock) { if (openResult == null) openResult = r }
        openLatch.countDown()
    }

    private fun deliver(b: ByteArray) {
        val s: ((ByteArray) -> Unit)?
        synchronized(lock) {
            s = sink
            if (s == null) { inbox.addLast(b); lock.notifyAll(); return }
        }
        s!!(b)
    }

    private fun markClosed(code: Int, reason: String) {
        val listeners: List<(RelayClosed) -> Unit>
        synchronized(lock) {
            if (closed != null) return
            closed = RelayClosed(code, reason)
            listeners = closeListeners.toList()
            closeListeners.clear()
            lock.notifyAll()
        }
        settleOpen(OpenResult(closeCode = code))
        for (l in listeners) l(closed!!)
    }

    /** Wait for the opening (blocking). */
    fun awaitOpen(): OpenResult {
        if (!openLatch.await(openTimeoutMs + 1000, TimeUnit.MILLISECONDS)) {
            settleOpen(OpenResult(error = "open timeout"))
        }
        return openResult!!
    }

    /** The next message (blocking). Throws RelayClosed or RelayTimeout. */
    fun next(ms: Long = 10_000): ByteArray {
        val end = System.currentTimeMillis() + ms
        synchronized(lock) {
            while (true) {
                inbox.removeFirstOrNull()?.let { return it }
                closed?.let { throw it }
                val left = end - System.currentTimeMillis()
                if (left <= 0) throw RelayTimeout("no response from host")
                lock.wait(left)
            }
        }
    }

    /** From now on, messages go to fn in order (queued ones first, synchronously here). */
    fun drainTo(fn: (ByteArray) -> Unit) {
        synchronized(lock) {
            while (true) {
                val b = inbox.removeFirstOrNull() ?: break
                fn(b)
            }
            sink = fn
        }
    }

    /** Called once when the socket is closed (immediately if it already is). */
    fun onClose(fn: (RelayClosed) -> Unit) {
        val now: RelayClosed?
        synchronized(lock) {
            now = closed
            if (now == null) closeListeners.add(fn)
        }
        if (now != null) fn(now)
    }

    fun send(b: ByteArray): Boolean = ws.send(b.toByteString())

    fun bufferedAmount(): Long = ws.queueSize()

    fun close(code: Int = 1000) {
        try { if (!ws.close(code, null)) ws.cancel() } catch (_: Exception) { ws.cancel() }
    }

    fun terminate() = ws.cancel()
}
