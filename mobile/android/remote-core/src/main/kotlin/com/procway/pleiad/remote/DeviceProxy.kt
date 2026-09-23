package com.procway.pleiad.remote

// Kotlin port of core/remote/device-proxy.mjs (docs/remote.md §7.1・§7.4・§8.3 option A): one per host, listening on
// 127.0.0.1, carrying the WebView's HTTP and /ws over the DeviceLink channel. The UI is the host's web/ unchanged.
//
// Auth is the same shape as the host's server (so web/ needs no change):
//   - the WebView opens http://127.0.0.1:<p>/?token=<proxy token>; a matching ?token= gets an HttpOnly SameSite=Strict
//     cookie back, later css/js/images pass by cookie. /ws needs ?token= (web/client.mjs adds it).
//   - Host header must be 127.0.0.1:<p> (DNS rebinding) -> 403; no/wrong token -> 401
//   - HTTP GET and HEAD only (405 otherwise); WebSocket only on /ws
// The token is random per start and never sent to the host (?token= and the cookie are dropped here).
//
// Threads: one per local connection. It blocks on socket I/O and on a queue of events coming from the loop, so the
// loop never blocks. Credit (release) is returned after the bytes were written to the local socket (§4.3).
// The WebSocket's early host messages (WS_ACCEPT and `ready` arrive in the same read) are queued from the moment the
// stream is opened, so nothing is lost before the 101 is written (the ordering race from the desktop work).
// Every HTTP response is `Connection: close` (no keep-alive bookkeeping; loopback connections are cheap).

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** Strings the proxy shows (the app supplies them from its resources). */
interface ProxyTexts {
    fun locale(): String = "en"
    fun title(state: String): String
    fun body(state: String): String
    fun tokenRequired(): String
    fun lost(): String
}

object DefaultTexts : ProxyTexts {
    override fun title(state: String) = if (state == "revoked") "This device was revoked on the host" else "Can't reach the host"
    override fun body(state: String) = when (state) {
        "revoked" -> "Pair this device again."
        "host-offline" -> "Make sure Pleiad is running on the host. This page opens automatically once connected."
        else -> "Can't reach the relay. Check your network. This page opens automatically once connected."
    }
    override fun tokenRequired() = "A token is required (open this from the app)"
    override fun lost() = "Lost the connection to the host"
}

class DeviceProxy(
    val loop: Loop,
    creds: HostCreds,
    keyPair: KeyPair,
    wantPort: Int = 0,
    app: String = "",
    name: String = "",
    shell: String = "mobile",
    backoff: Backoff = Backoff(),
    connectTimeoutMs: Long = 15_000,
    private val requestWaitMs: Long = 10_000,
    private val texts: ProxyTexts = DefaultTexts,
    private val log: (String) -> Unit = {},
) {
    companion object {
        const val PROXY_COOKIE = "pleiad_remote_token"
        private const val WS_PAUSE_ABOVE = 256 * 1024L
        private const val MAX_WS_MESSAGE = 64L * 1024 * 1024
        private const val MAX_HEAD = 32 * 1024
        private val PASS_REQUEST = setOf(
            "accept", "accept-language", "accept-encoding", "cache-control", "pragma",
            "if-none-match", "if-modified-since", "if-range", "range", "user-agent",
        )
        private val DROP_RESPONSE = setOf(
            "set-cookie", "set-cookie2", "connection", "keep-alive", "transfer-encoding", "upgrade",
            "proxy-authenticate", "proxy-connection", "te", "trailer",
        )
        private val REASONS = mapOf(
            101 to "Switching Protocols", 200 to "OK", 204 to "No Content", 206 to "Partial Content", 301 to "Moved Permanently",
            302 to "Found", 304 to "Not Modified", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found",
            405 to "Method Not Allowed", 416 to "Range Not Satisfiable", 500 to "Internal Server Error", 502 to "Bad Gateway",
            503 to "Service Unavailable",
        )
        private val pool = Executors.newCachedThreadPool { r -> Thread(r, "pleiad-proxy").also { it.isDaemon = true } }

        fun escapeHtml(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
    }

    val link = DeviceLink(loop, creds, keyPair, app, name, shell, backoff, connectTimeoutMs, log = log)
    private val wantPort = if (wantPort in 1024..65535) wantPort else 0
    @Volatile var port = 0; private set
    val token: String = PairingCodec.b64urlEncode(randomBytes(32))
    @Volatile var creds: HostCreds = creds; private set
    private var server: ServerSocket? = null
    private val sockets = ConcurrentHashMap.newKeySet<Socket>()
    @Volatile var closed = false; private set

    /** The URL the WebView opens (contains the token: never log it). */
    val url: String get() = "http://127.0.0.1:$port/?token=$token"

    fun onStatus(fn: (LinkStatus) -> Unit) = link.onStatus(fn)

    /** Listen and start connecting. Blocking (binds the socket); call off the main thread. */
    fun start(): DeviceProxy {
        val lo = InetAddress.getByName("127.0.0.1")
        val ss = ServerSocket()
        ss.reuseAddress = false
        try {
            ss.bind(InetSocketAddress(lo, wantPort), 64)
        } catch (e: IOException) {
            if (wantPort == 0) throw e
            log("remote proxy: port $wantPort unavailable (${e.message})")
            ss.bind(InetSocketAddress(lo, 0), 64)
        }
        server = ss
        port = ss.localPort
        pool.execute { acceptLoop(ss) }
        link.start()
        return this
    }

    fun retryNow(newCreds: HostCreds? = null) {
        if (newCreds != null) creds = newCreds
        link.retryNow(newCreds)
    }

    fun close() {
        if (closed) return
        closed = true
        link.stop()
        try { server?.close() } catch (_: IOException) {}
        for (s in sockets) try { s.close() } catch (_: IOException) {}
        sockets.clear()
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (!closed) {
            val s = try { ss.accept() } catch (_: IOException) { break }
            sockets.add(s)
            pool.execute {
                try { handle(s) } catch (_: Exception) {} finally {
                    sockets.remove(s)
                    try { s.close() } catch (_: IOException) {}
                }
            }
        }
    }

    // ── request parsing ──

    private class Request(val method: String, val target: String, val headers: Map<String, String>)

    private fun readHead(input: InputStream): Request? {
        val buf = java.io.ByteArrayOutputStream()
        var state = 0
        while (true) {
            val c = input.read()
            if (c < 0) return null
            buf.write(c)
            if (buf.size() > MAX_HEAD) return null
            state = when {
                c == '\r'.code && (state == 0 || state == 2) -> state + 1
                c == '\n'.code && (state == 1 || state == 3) -> state + 1
                else -> 0
            }
            if (state == 4) break
        }
        val lines = String(buf.toByteArray(), Charsets.ISO_8859_1).split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size < 3) return null
        val headers = LinkedHashMap<String, String>()
        for (line in lines.drop(1)) {
            if (line.isEmpty()) continue
            val i = line.indexOf(':')
            if (i <= 0) continue
            val k = line.substring(0, i).trim().lowercase()
            val v = line.substring(i + 1).trim()
            headers[k] = headers[k]?.let { if (k == "cookie") "$it; $v" else "$it, $v" } ?: v
        }
        return Request(parts[0].uppercase(), parts[1], headers)
    }

    private fun tokenEq(given: String?, token: String): Boolean {
        if (given == null) return false
        return MessageDigest.isEqual(given.toByteArray(Charsets.UTF_8), token.toByteArray(Charsets.UTF_8))
    }

    private fun tokenFromCookie(header: String?): String? {
        for (part in (header ?: "").split(';')) {
            val kv = part.trim()
            val i = kv.indexOf('=')
            if (i > 0 && kv.substring(0, i) == PROXY_COOKIE) return try { URLDecoder.decode(kv.substring(i + 1), "UTF-8") } catch (_: Exception) { null }
        }
        return null
    }

    /** Split the target into path and query params; returns (path, rawQuery without token, token). */
    private fun splitTarget(target: String): Triple<String, String, String?>? {
        if (!target.startsWith("/")) return null
        val q = target.indexOf('?')
        val path = if (q < 0) target else target.substring(0, q)
        val query = if (q < 0) "" else target.substring(q + 1)
        var token: String? = null
        val kept = mutableListOf<String>()
        for (p in query.split('&')) {
            if (p.isEmpty()) continue
            val i = p.indexOf('=')
            val k = try { URLDecoder.decode(if (i < 0) p else p.substring(0, i), "UTF-8") } catch (_: Exception) { return null }
            if (k == "token") {
                if (token == null) token = try { URLDecoder.decode(if (i < 0) "" else p.substring(i + 1), "UTF-8") } catch (_: Exception) { return null }
            } else kept.add(p)
        }
        return Triple(path, kept.joinToString("&"), token)
    }

    private fun writeSimple(out: OutputStream, status: Int, contentType: String?, body: ByteArray, extra: Map<String, String> = emptyMap()) {
        val sb = StringBuilder("HTTP/1.1 $status ${REASONS[status] ?: ""}\r\n")
        if (contentType != null) sb.append("Content-Type: $contentType\r\n")
        for ((k, v) in extra) sb.append("$k: $v\r\n")
        sb.append("Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    fun unavailablePage(state: String): String {
        val revoked = state == "revoked"
        val title = texts.title(state)
        val body = texts.body(state)
        val hostName = creds.hostName
        return """<!doctype html>
<html lang="${escapeHtml(texts.locale())}"><head><meta charset="utf-8">${if (revoked) "" else "<meta http-equiv=\"refresh\" content=\"5\">"}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#333;background:#f6f6f4}
main{max-width:28rem;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#666}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#1c1c1c}p{color:#aaa}}</style></head>
<body><main data-remote-state="${escapeHtml(state)}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${if (hostName.isNotEmpty()) "<p>${escapeHtml(hostName)}</p>" else ""}</main></body></html>
"""
    }

    private fun unavailable(out: OutputStream, req: Request, state: String, message: String?) {
        val wantsHtml = req.method == "GET" && (req.headers["accept"] ?: "").contains("text/html")
        val extra = mapOf("Cache-Control" to "no-store", "X-Pleiad-Remote-State" to state)
        if (wantsHtml) writeSimple(out, 503, "text/html; charset=utf-8", unavailablePage(state).toByteArray(Charsets.UTF_8), extra)
        else writeSimple(out, 502, "text/plain; charset=utf-8", (message ?: texts.title("host-offline")).toByteArray(Charsets.UTF_8), extra)
    }

    // ── connection ──

    private sealed class Ev {
        class Ready(val ch: Channel?, val err: LinkUnavailable?) : Ev()
        class Opened(val stream: Stream?, val err: Exception?) : Ev()
        class Response(val head: JSONObject) : Ev()
        class Data(val chunk: ByteArray, val release: Release) : Ev()
        object End : Ev()
        class Reset(val code: Int) : Ev()
        object Accept : Ev()
        class Reject(val status: Int) : Ev()
        class Message(val data: ByteArray, val text: Boolean, val release: Release) : Ev()
        class Close(val code: Int, val reason: String) : Ev()
        class Pong(val payload: ByteArray) : Ev()
        class LocalClose(val code: Int, val reason: String) : Ev()
        object LocalGone : Ev()
    }

    private fun handle(s: Socket) {
        s.tcpNoDelay = true
        s.soTimeout = 30_000
        val input = BufferedInputStream(s.getInputStream())
        val out = s.getOutputStream().buffered()
        val req = readHead(input) ?: return
        if (req.headers["host"] != "127.0.0.1:$port") return writeSimple(out, 403, "text/plain; charset=utf-8", "forbidden".toByteArray())
        val (path, restQuery, qToken) = splitTarget(req.target) ?: return writeSimple(out, 400, null, ByteArray(0))
        val forwardPath = if (restQuery.isEmpty()) path else "$path?$restQuery"
        val isUpgrade = (req.headers["upgrade"] ?: "").equals("websocket", ignoreCase = true)
        if (isUpgrade) {
            if (path != "/ws") return writeSimple(out, 404, null, ByteArray(0))
            if (!tokenEq(qToken, token)) return writeSimple(out, 401, null, ByteArray(0))
            return handleWs(s, input, out, req, forwardPath)
        }
        val queryOk = tokenEq(qToken, token)
        if (!queryOk && !tokenEq(tokenFromCookie(req.headers["cookie"]), token)) {
            return writeSimple(out, 401, "text/plain; charset=utf-8", texts.tokenRequired().toByteArray(Charsets.UTF_8))
        }
        if (req.method != "GET" && req.method != "HEAD") {
            return writeSimple(out, 405, "text/plain; charset=utf-8", "method not allowed".toByteArray(), mapOf("Allow" to "GET, HEAD"))
        }
        handleHttp(s, out, req, forwardPath, queryOk)
    }

    private fun awaitChannel(q: LinkedBlockingQueue<Ev>): Ev.Ready {
        link.ready(requestWaitMs) { ch, err -> q.put(Ev.Ready(ch, err)) }
        return q.poll(requestWaitMs + 5_000, TimeUnit.MILLISECONDS) as? Ev.Ready ?: Ev.Ready(null, LinkUnavailable("offline"))
    }

    private fun handleHttp(s: Socket, out: OutputStream, req: Request, forwardPath: String, queryOk: Boolean) {
        val q = LinkedBlockingQueue<Ev>()
        val ready = awaitChannel(q)
        val ch = ready.ch ?: return unavailable(out, req, ready.err?.state ?: "offline", null)
        val headers = JSONObject()
        for ((k, v) in req.headers) if (k in PASS_REQUEST) headers.put(k, v)
        val head = JSONObject().put("method", req.method).put("path", forwardPath).put("headers", headers)
        loop.post {
            try {
                val st = ch.openHttp(head)
                st.listener = object : StreamListener {
                    override fun onResponse(head: JSONObject) { q.put(Ev.Response(head)) }
                    override fun onData(chunk: ByteArray, release: Release) { q.put(Ev.Data(chunk, release)) }
                    override fun onEnd() { q.put(Ev.End) }
                    override fun onReset(code: Int, remote: Boolean) { q.put(Ev.Reset(code)) }
                }
                st.end()
                q.put(Ev.Opened(st, null))
            } catch (e: Exception) {
                q.put(Ev.Opened(null, e))
            }
        }
        val opened = q.take() as Ev.Opened
        val stream = opened.stream ?: return unavailable(out, req, "offline", opened.err?.message)
        var headersSent = false
        try {
            while (true) {
                val ev = q.poll(10, TimeUnit.MINUTES) ?: break
                when (ev) {
                    is Ev.Response -> {
                        val status = ev.head.optInt("status", 502).let { if (it in 100..599) it else 502 }
                        val sb = StringBuilder("HTTP/1.1 $status ${REASONS[status] ?: ""}\r\n")
                        val hs = ev.head.optJSONObject("headers") ?: JSONObject()
                        for (k in hs.keys()) {
                            val key = k.lowercase()
                            if (key in DROP_RESPONSE || key.startsWith("proxy-")) continue
                            val v = hs.get(k)
                            val values = if (v is JSONArray) (0 until v.length()).map { v.get(it).toString() } else listOf(v.toString())
                            for (value in values) if (!value.contains('\r') && !value.contains('\n')) sb.append("$key: $value\r\n")
                        }
                        if (queryOk) sb.append("set-cookie: $PROXY_COOKIE=$token; HttpOnly; SameSite=Strict; Path=/\r\n")
                        sb.append("connection: close\r\n\r\n")
                        out.write(sb.toString().toByteArray(Charsets.UTF_8))
                        headersSent = true
                    }
                    is Ev.Data -> {
                        try {
                            out.write(ev.chunk)
                            if (q.isEmpty()) out.flush()
                        } finally {
                            ev.release()
                        }
                    }
                    is Ev.End -> { out.flush(); return }
                    is Ev.Reset -> {
                        if (headersSent) { out.flush(); s.close(); return }
                        return when (ev.code) {
                            ResetCode.FORBIDDEN -> writeSimple(out, 403, "text/plain; charset=utf-8", "forbidden".toByteArray())
                            ResetCode.CHANNEL_CLOSED -> unavailable(out, req, if (link.state == "connected") "offline" else link.state, texts.lost())
                            else -> writeSimple(out, 502, "text/plain; charset=utf-8", "bad gateway".toByteArray())
                        }
                    }
                    else -> {}
                }
            }
        } catch (e: IOException) {
            // The WebView cancelled the load: drop the stream too
            val st = stream
            loop.post { if (!st.destroyed) st.reset(ResetCode.CANCEL) }
            // Return the credit of anything still queued
            while (true) { val ev = q.poll() ?: break; if (ev is Ev.Data) ev.release() }
        }
    }

    private fun handleWs(s: Socket, input: InputStream, out: OutputStream, req: Request, forwardPath: String) {
        val key = req.headers["sec-websocket-key"]
        if (key == null || req.headers["sec-websocket-version"] != "13") return writeSimple(out, 400, null, ByteArray(0))
        val q = LinkedBlockingQueue<Ev>()
        val ready = awaitChannel(q)
        val ch = ready.ch ?: return writeSimple(out, 502, null, ByteArray(0))
        val protocols = (req.headers["sec-websocket-protocol"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        val head = JSONObject().put("path", forwardPath).put("protocols", JSONArray(protocols))
        loop.post {
            try {
                val st = ch.openWs(head)
                // From here on every host event is queued (early messages wait for the 101 below)
                st.listener = object : StreamListener {
                    override fun onAccept() { q.put(Ev.Accept) }
                    override fun onReject(status: Int) { q.put(Ev.Reject(status)) }
                    override fun onMessage(data: ByteArray, text: Boolean, release: Release) { q.put(Ev.Message(data, text, release)) }
                    override fun onClose(code: Int, reason: String) { q.put(Ev.Close(code, reason)) }
                    override fun onReset(code: Int, remote: Boolean) { q.put(Ev.Reset(code)) }
                }
                q.put(Ev.Opened(st, null))
            } catch (e: Exception) {
                q.put(Ev.Opened(null, e))
            }
        }
        val opened = q.take() as Ev.Opened
        val stream = opened.stream ?: return writeSimple(out, 502, null, ByteArray(0))
        // Wait for the host's answer; ignore (keep) messages until then
        val early = ArrayDeque<Ev>()
        var outcome: Int? = null
        while (outcome == null) {
            val ev = q.poll(requestWaitMs + 20_000, TimeUnit.MILLISECONDS)
            outcome = when (ev) {
                null -> 502
                is Ev.Accept -> 101
                is Ev.Reject -> ev.status
                is Ev.Reset -> if (ev.code == ResetCode.FORBIDDEN) 403 else 502
                else -> { early.addLast(ev); null }
            }
        }
        if (outcome != 101) {
            loop.post { if (!stream.destroyed) stream.reset(ResetCode.CANCEL) }
            for (ev in early) if (ev is Ev.Message) ev.release()
            return writeSimple(out, outcome, null, ByteArray(0))
        }
        val sb = StringBuilder("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n")
        sb.append("Sec-WebSocket-Accept: ${Ws.acceptKey(key)}\r\n")
        if (protocols.isNotEmpty()) sb.append("Sec-WebSocket-Protocol: ${protocols[0]}\r\n")
        sb.append("\r\n")
        try {
            out.write(sb.toString().toByteArray(Charsets.US_ASCII))
            out.flush()
        } catch (e: IOException) {
            loop.post { if (!stream.destroyed) stream.reset(ResetCode.CANCEL) }
            return
        }
        s.soTimeout = 0
        // Put the early events back in front of the queue
        if (early.isNotEmpty()) {
            val rest = ArrayList<Ev>()
            q.drainTo(rest)
            for (ev in early) q.put(ev)
            for (ev in rest) q.put(ev)
        }
        bridge(s, input, out, stream, q)
    }

    /** The local WebSocket <-> the stream. This thread writes; a second thread reads the WebView's frames. */
    private fun bridge(s: Socket, input: InputStream, out: OutputStream, stream: Stream, q: LinkedBlockingQueue<Ev>) {
        val inflightLock = Object()
        var inflight = 0L
        val localClosed = java.util.concurrent.atomic.AtomicBoolean(false)
        val reader = Thread({
            val parts = java.io.ByteArrayOutputStream()
            var msgOpcode = -1
            try {
                while (true) {
                    val f = Ws.readFrame(input, MAX_WS_MESSAGE)
                    when (f.opcode) {
                        Ws.OP_PING -> q.put(Ev.Pong(f.payload))
                        Ws.OP_PONG -> {}
                        Ws.OP_CLOSE -> {
                            val code = if (f.payload.size >= 2) ((f.payload[0].toInt() and 0xff) shl 8) or (f.payload[1].toInt() and 0xff) else 1005
                            val reason = if (f.payload.size > 2) String(f.payload, 2, f.payload.size - 2, Charsets.UTF_8) else ""
                            q.put(Ev.LocalClose(code, reason))
                            return@Thread
                        }
                        Ws.OP_TEXT, Ws.OP_BINARY, Ws.OP_CONT -> {
                            if (f.opcode == Ws.OP_CONT) { if (msgOpcode < 0) throw Ws.ProtocolError(1002, "unexpected continuation") }
                            else { if (msgOpcode >= 0) throw Ws.ProtocolError(1002, "expected continuation"); msgOpcode = f.opcode }
                            if (parts.size().toLong() + f.payload.size > MAX_WS_MESSAGE) throw Ws.ProtocolError(1009, "message too large")
                            parts.write(f.payload)
                            if (f.fin) {
                                val data = parts.toByteArray()
                                val text = msgOpcode == Ws.OP_TEXT
                                parts.reset()
                                msgOpcode = -1
                                synchronized(inflightLock) { inflight += data.size }
                                loop.post {
                                    val release = { synchronized(inflightLock) { inflight -= data.size; inflightLock.notifyAll() } }
                                    if (stream.destroyed || stream.localDone) { release(); return@post }
                                    stream.send(data, text) { err ->
                                        release()
                                        if (err != null) q.put(Ev.LocalGone)
                                    }
                                }
                                // Back-pressure: stop reading the WebView while too much is in flight to the host
                                synchronized(inflightLock) {
                                    while (inflight > WS_PAUSE_ABOVE && !localClosed.get()) inflightLock.wait(1000)
                                }
                            }
                        }
                        else -> throw Ws.ProtocolError(1002, "unknown opcode")
                    }
                }
            } catch (e: Ws.ProtocolError) {
                q.put(Ev.LocalClose(e.closeCode, ""))
            } catch (_: Exception) {
                q.put(Ev.LocalGone)
            }
        }, "pleiad-proxy-ws-read")
        reader.isDaemon = true
        reader.start()

        var sentClose = false
        try {
            loop@ while (true) {
                val ev = q.take()
                when (ev) {
                    is Ev.Message -> {
                        try {
                            if (!sentClose) {
                                Ws.writeFrame(out, if (ev.text) Ws.OP_TEXT else Ws.OP_BINARY, ev.data)
                                if (q.isEmpty()) out.flush()
                            }
                        } finally {
                            ev.release()
                        }
                    }
                    is Ev.Pong -> { if (!sentClose) { Ws.writeFrame(out, Ws.OP_PONG, ev.payload); out.flush() } }
                    is Ev.Close -> {
                        // The host closed: pass it on, answer the host, and end the local socket
                        val code = Ws.sendableCode(ev.code)
                        if (!sentClose) { Ws.writeFrame(out, Ws.OP_CLOSE, Ws.closePayload(code, ev.reason)); out.flush(); sentClose = true }
                        loop.post { if (!stream.destroyed) stream.close(code, ev.reason) }
                        break@loop
                    }
                    is Ev.LocalClose -> {
                        // The WebView closed (or broke the protocol): echo the close, then tell the host
                        val code = Ws.sendableCode(if (ev.code == 1005) 1000 else ev.code)
                        if (!sentClose) { try { Ws.writeFrame(out, Ws.OP_CLOSE, Ws.closePayload(code, "")); out.flush() } catch (_: IOException) {}; sentClose = true }
                        loop.post { if (!stream.destroyed) stream.close(code, ev.reason) }
                        break@loop
                    }
                    is Ev.Reset -> break@loop        // channel lost / host dropped it: 1006 to the WebView (no close frame)
                    is Ev.LocalGone -> {
                        loop.post { if (!stream.destroyed) stream.close(Ws.sendableCode(1006), "") }
                        break@loop
                    }
                    else -> {}
                }
            }
        } catch (_: IOException) {
            loop.post { if (!stream.destroyed && !stream.localDone) stream.close(1000, "") }
        } finally {
            localClosed.set(true)
            synchronized(inflightLock) { inflightLock.notifyAll() }
            try { s.close() } catch (_: IOException) {}
            // Credit for anything we'll never deliver
            while (true) { val ev = q.poll() ?: break; if (ev is Ev.Message) ev.release() }
            // Late host messages after this point: release immediately
            loop.post {
                if (!stream.destroyed) stream.listener = object : StreamListener {}
            }
        }
    }
}
