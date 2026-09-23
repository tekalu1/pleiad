package com.procway.pleiad.remote

// Kotlin port of core/remote/device-link.mjs (docs/remote.md §3.2・§4.4・§7.4): one line from the device through the
// relay to the host, with reconnects and states. Loop-confined; the blocking relay handshake runs on a worker thread.
//
// state: connecting | connected | offline | host-offline | revoked | stopped
// Backoff 0.5 s -> 30 s doubling (±25 % jitter), reset after 10 s connected. Streams never survive a reconnect.

import java.util.concurrent.Executors
import org.json.JSONObject

data class LinkStatus(
    val state: String,
    val since: Long = System.currentTimeMillis(),
    val retryAt: Long? = null,
    val closeCode: Int? = null,
    val goaway: String? = null,
    val reason: String? = null,
    val httpStatus: Int? = null,
    val hostName: String = "",
    val connectedAt: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("state", state)
        put("since", since)
        retryAt?.let { put("retryAt", it) }
        closeCode?.let { put("closeCode", it) }
        goaway?.let { put("goaway", it) }
        reason?.let { put("reason", it) }
        put("hostName", hostName)
        connectedAt?.let { put("connectedAt", it) }
    }
}

class LinkUnavailable(val state: String, val closeCode: Int? = null) : Exception("link $state")

data class Backoff(val minMs: Long = 500, val maxMs: Long = 30_000, val stableMs: Long = 10_000)

object LinkRules {
    fun classifyClose(closeCode: Int? = null, goaway: String? = null): String = when {
        goaway == "revoked" || closeCode == 4401 -> "revoked"
        goaway == "shutdown" || closeCode == 4404 || closeCode == 4408 -> "host-offline"
        else -> "offline"
    }
}

class DeviceLink(
    val loop: Loop,
    @Volatile var creds: HostCreds,
    private val keyPair: KeyPair,
    private val app: String = "",
    private val name: String = "",
    private val shell: String = "mobile",
    private val backoff: Backoff = Backoff(),
    private val connectTimeoutMs: Long = 15_000,
    private val channelFactory: ((sendFn: (ByteArray) -> Unit, transport: Transport, hello: JSONObject, buffered: () -> Long) -> Channel)? = null,
    private val log: (String) -> Unit = {},
) {
    companion object {
        /** Blocking handshakes run here (never on the loop). */
        private val workers = Executors.newCachedThreadPool { r -> Thread(r, "pleiad-link").also { it.isDaemon = true } }
    }

    var channel: Channel? = null; private set
    var hostName = ""; private set
    private var attempt = 0
    private var running = false
    private var generation = 0
    private var retryTimer: Cancellable? = null
    private var stableTimer: Cancellable? = null
    private var socket: RelaySocket? = null
    private var connectedAt: Long? = null
    private val statusListeners = mutableListOf<(LinkStatus) -> Unit>()
    var status = LinkStatus("stopped"); private set
    val state get() = status.state

    fun onStatus(fn: (LinkStatus) -> Unit) { statusListeners.add(fn) }

    private fun setStatus(s: LinkStatus) {
        status = s.copy(hostName = hostName, connectedAt = if (s.state == "connected") connectedAt else null)
        for (l in statusListeners.toList()) try { l(status) } catch (_: Exception) {}
    }

    fun start() = loop.exec {
        if (running) return@exec
        running = true
        attempt = 0
        connect()
    }

    fun stop() = loop.exec {
        if (!running && state == "stopped") return@exec
        running = false
        generation++
        retryTimer?.cancel(); retryTimer = null
        stableTimer?.cancel()
        val ch = channel
        channel = null
        ch?.close(ChannelError("closed", "link stopped"))
        socket?.close(1000)
        socket = null
        setStatus(LinkStatus("stopped"))
    }

    /** Reconnect now ("retry", foreground again, or new credentials after re-pairing). */
    fun retryNow(newCreds: HostCreds? = null) = loop.exec {
        if (newCreds != null) creds = newCreds
        if (!running) { running = true; attempt = 0; connect(); return@exec }
        if ((state == "connecting" || state == "connected") && newCreds == null) return@exec
        generation++
        retryTimer?.cancel(); retryTimer = null
        val ch = channel
        channel = null
        ch?.close(ChannelError("closed", "reconnecting"))
        socket?.close(1000)
        socket = null
        attempt = 0
        connect()
    }

    /**
     * The usable channel: at once when connected, after the attempt when connecting (max ms), otherwise fail at once
     * with LinkUnavailable(state). The callback runs on the loop.
     */
    fun ready(ms: Long, cb: (Channel?, LinkUnavailable?) -> Unit) = loop.exec {
        val ch = channel
        if (state == "connected" && ch != null && !ch.closed) return@exec cb(ch, null)
        if (state != "connecting") return@exec cb(null, LinkUnavailable(state, status.closeCode))
        var done = false
        var timer: Cancellable? = null
        lateinit var listener: (LinkStatus) -> Unit
        listener = { s ->
            if (!done && s.state != "connecting") {
                done = true
                statusListeners.remove(listener)
                timer?.cancel()
                val c = channel
                if (s.state == "connected" && c != null) cb(c, null) else cb(null, LinkUnavailable(s.state, s.closeCode))
            }
        }
        statusListeners.add(listener)
        timer = loop.schedule(ms) {
            if (!done) {
                done = true
                statusListeners.remove(listener)
                cb(null, LinkUnavailable("offline"))
            }
        }
    }

    private fun scheduleRetry(state: String, detail: LinkStatus) {
        if (!running) return
        if (state == "revoked") {
            running = false
            setStatus(detail.copy(state = "revoked", since = System.currentTimeMillis()))
            return
        }
        val base = minOf(backoff.maxMs, backoff.minMs * (1L shl minOf(attempt, 20)))
        val delay = Math.round(base * (0.75 + Math.random() * 0.5))
        attempt++
        setStatus(detail.copy(state = state, since = System.currentTimeMillis(), retryAt = System.currentTimeMillis() + delay))
        val gen = generation
        retryTimer = loop.schedule(delay) {
            retryTimer = null
            if (gen == generation && running) connect()
        }
    }

    /** Loop. Starts one attempt; the blocking part runs on a worker, the result comes back to the loop. */
    private fun connect() {
        val gen = ++generation
        val live = { gen == generation && running }
        setStatus(LinkStatus("connecting"))
        val c = creds
        val sock = try {
            RelaySocket(
                PairingCodec.relayWsUrl(c.relayUrl, "/v1/device"),
                mapOf("authorization" to "Bearer ${c.token}", "x-pleiad-host" to c.hostId, "x-pleiad-device" to c.deviceId),
                connectTimeoutMs,
            )
        } catch (e: Exception) {
            log("remote device: ${e.message}")
            scheduleRetry("offline", LinkStatus("offline", reason = "url"))
            return
        }
        socket = sock
        val fail: (String, LinkStatus) -> Unit = { st, detail ->
            sock.close(1000)
            if (socket === sock) socket = null
            if (live()) scheduleRetry(st, detail)
        }
        workers.execute {
            val o = sock.awaitOpen()
            if (!o.open) {
                loop.post {
                    if (!live()) { sock.close(); return@post }
                    val closeCode = o.closeCode?.takeIf { it != 1006 }
                    val detail = when {
                        closeCode != null -> LinkStatus("", closeCode = closeCode)
                        o.status != null -> LinkStatus("", httpStatus = o.status)
                        else -> LinkStatus("", reason = o.error)
                    }
                    fail(if (closeCode != null) LinkRules.classifyClose(closeCode) else "offline", detail)
                }
                return@execute
            }
            var transport: Transport? = null
            var failure: Pair<String, LinkStatus>? = null
            try {
                val hs = Handshake(Pattern.IK, true, Pleiad.prologueFor(c.hostId), keyPair, remoteStatic = c.hostPublicKey)
                val payload = JSONObject().put("proto", 1).put("name", name).put("app", app)
                sock.send(hs.writeMessage(payload.toString().toByteArray(Charsets.UTF_8)))
                hs.readMessage(sock.next(connectTimeoutMs))
                transport = hs.split()
            } catch (e: RelayClosed) {
                failure = LinkRules.classifyClose(e.code) to LinkStatus("", closeCode = e.code)
            } catch (e: RelayTimeout) {
                failure = "host-offline" to LinkStatus("", reason = "timeout")
            } catch (e: Exception) {
                // The host's key does not match: treat like revoked (possible impersonation), don't retry
                log("remote device: handshake failed: ${e.message}")
                failure = "revoked" to LinkStatus("", reason = "handshake")
            }
            loop.post {
                if (!live()) { sock.close(); return@post }
                val f = failure
                if (f != null) return@post fail(f.first, f.second)
                attach(sock, transport!!, gen, live, fail)
            }
        }
    }

    /** Loop. The handshake is done: build the channel, attach listeners, THEN drain queued messages, then HELLO. */
    private fun attach(sock: RelaySocket, transport: Transport, gen: Int, live: () -> Boolean, fail: (String, LinkStatus) -> Unit) {
        val hello = JSONObject().put("app", app).put("shell", shell)
        val send: (ByteArray) -> Unit = { b -> if (!sock.send(b)) throw IllegalStateException("relay socket refused the message") }
        val buffered = { sock.bufferedAmount() }
        val ch = channelFactory?.invoke(send, transport, hello, buffered)
            ?: Channel(loop, "device", send, transport, hello, bufferedAmount = buffered)
        var goaway: String? = null
        var settled = false
        var helloDone = false
        var helloTimer: Cancellable? = null

        fun onHelloResult(h: JSONObject?, timedOut: Boolean) {
            if (helloDone) return
            helloDone = true
            helloTimer?.cancel()
            if (!live()) { ch.close(); sock.close(); return }
            if (h == null) {
                ch.close()
                // Wait up to 1 s for the relay's close code to classify the failure
                val finish = { closed: RelayClosed? ->
                    loop.post {
                        if (!live()) return@post
                        val cc = closed?.code?.takeIf { it != 1006 }
                        val state = if (timedOut && cc == null) "host-offline" else LinkRules.classifyClose(cc, goaway)
                        fail(state, LinkStatus("", closeCode = cc, goaway = goaway, reason = if (timedOut) "timeout" else null))
                    }
                }
                var answered = false
                val t = loop.schedule(1000) { if (!answered) { answered = true; finish(sock.closed) } }
                sock.onClose { cl -> loop.post { if (!answered) { answered = true; t.cancel(); finish(cl) } } }
                return
            }
            settled = true
            channel = ch
            hostName = (h.opt("hostName") as? String) ?: ""
            connectedAt = System.currentTimeMillis()
            stableTimer?.cancel()
            stableTimer = loop.schedule(backoff.stableMs) { if (channel === ch) attempt = 0 }
            setStatus(LinkStatus("connected"))
            val closedAlready = sock.closed
            if (closedAlready != null && channel === ch) {
                channel = null
                if (live() && state == "connected") scheduleRetry(LinkRules.classifyClose(closedAlready.code.takeIf { it != 1006 }, goaway), LinkStatus("", closeCode = closedAlready.code))
            }
        }

        ch.listener = object : ChannelListener {
            override fun onHello(hello: JSONObject) = onHelloResult(hello, false)
            override fun onGoaway(code: String, reason: String) { goaway = code }
            override fun onClose(err: ChannelError?) {
                sock.close(1000)
                if (!helloDone) onHelloResult(null, false)
            }
        }
        helloTimer = loop.schedule(connectTimeoutMs) { onHelloResult(null, true) }
        sock.onClose { closed ->
            loop.post {
                ch.close(ChannelError("transport", "relay connection lost"))
                if (settled) {
                    if (channel === ch) channel = null
                    stableTimer?.cancel()
                    if (socket === sock) socket = null
                    if (!live()) return@post
                    if (state != "connected") return@post   // handled already (e.g. closed right after HELLO)
                    val cc = closed.code.takeIf { it != 1006 }
                    scheduleRetry(LinkRules.classifyClose(cc, goaway), LinkStatus("", closeCode = cc, goaway = goaway))
                }
            }
        }
        // Listeners are attached: now hand over queued messages (HELLO may already be among them) and later ones, in order.
        sock.drainTo { b -> loop.post { ch.receive(b) } }
        ch.start()
    }
}
