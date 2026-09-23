package com.procway.pleiad.remote

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Cross-implementation test: the Kotlin device against the real Node relay (relay/server.mjs) and a fake-backend host
 * (core/server.mjs), started by mobile/scripts/fake-host.mjs. No LLM, no network beyond 127.0.0.1.
 * Skipped when node is not on PATH or PLEIAD_INTEROP=off.
 */
class InteropTest {
    companion object {
        private var proc: Process? = null
        private val lines = LinkedBlockingQueue<JSONObject>()
        private lateinit var offer: String
        private lateinit var dir: File
        private lateinit var device: RemoteDevice

        private fun event(name: String, ms: Long = 60_000): JSONObject {
            val end = System.currentTimeMillis() + ms
            while (true) {
                val left = end - System.currentTimeMillis()
                check(left > 0) { "no '$name' from fake-host" }
                val o = lines.poll(left, TimeUnit.MILLISECONDS) ?: continue
                if (o.optString("event") == name) return o
                if (o.optString("event") == "error") throw IllegalStateException(o.toString())
            }
        }

        private fun send(cmd: String) {
            proc!!.outputStream.write("$cmd\n".toByteArray())
            proc!!.outputStream.flush()
        }

        @BeforeClass @JvmStatic fun setUp() {
            val mode = System.getProperty("pleiad.interop") ?: "auto"
            assumeTrue(mode != "off")
            val repo = File(System.getProperty("pleiad.repo") ?: "../../..")
            val script = File(repo, "mobile/scripts/fake-host.mjs")
            val node = if (System.getProperty("os.name").lowercase().contains("win")) "node.exe" else "node"
            val p = try {
                ProcessBuilder(node, script.absolutePath, "--auto-approve").directory(repo).redirectErrorStream(false).start()
            } catch (e: Exception) {
                assumeTrue("node not available: ${e.message}", false); return
            }
            proc = p
            Thread {
                BufferedReader(InputStreamReader(p.inputStream)).forEachLine { l ->
                    try { lines.put(JSONObject(l)) } catch (_: Exception) {}
                }
            }.apply { isDaemon = true }.start()
            Thread { p.errorStream.readBytes() }.apply { isDaemon = true }.start()
            event("ready", 120_000)
            offer = event("offer").getString("payload")
            dir = kotlin.io.path.createTempDirectory("pleiad-kt-device").toFile()
            device = RemoteDevice(
                FileDeviceStore(dir), app = "kt-test", name = "kt-phone",
                backoff = Backoff(200, 1000, 1000), connectTimeoutMs = 5000, requestWaitMs = 5000,
            )
        }

        @AfterClass @JvmStatic fun tearDown() {
            if (::device.isInitialized) device.closeAll()
            proc?.let { p ->
                try { send("quit") } catch (_: Exception) {}
                if (!p.waitFor(15, TimeUnit.SECONDS)) p.destroyForcibly()
            }
            if (::dir.isInitialized) dir.deleteRecursively()
        }
    }

    private fun get(port: Int, path: String, host: String = "127.0.0.1:$port", headers: Map<String, String> = emptyMap(), method: String = "GET"): Triple<Int, Map<String, String>, ByteArray> {
        // Raw socket so we control the Host header
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 15_000
            val req = StringBuilder("$method $path HTTP/1.1\r\nHost: $host\r\n")
            for ((k, v) in headers) req.append("$k: $v\r\n")
            req.append("\r\n")
            s.getOutputStream().write(req.toString().toByteArray())
            val all = s.getInputStream().readBytes()
            val sep = String(all, Charsets.ISO_8859_1).indexOf("\r\n\r\n")
            val head = String(all, 0, sep, Charsets.ISO_8859_1).split("\r\n")
            val status = head[0].split(" ")[1].toInt()
            val hs = head.drop(1).associate { l -> l.substringBefore(':').lowercase() to l.substringAfter(':').trim() }
            return Triple(status, hs, all.copyOfRange(sep + 4, all.size))
        }
    }

    private fun waitState(hostId: String, want: String, ms: Long = 15_000) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (device.proxy(hostId)?.link?.state == want) return
            Thread.sleep(50)
        }
        throw AssertionError("state $want not reached (now ${device.proxy(hostId)?.link?.state})")
    }

    @Test fun pairOpenProxyWsAndRevoke() {
        // ---- pairing (auto-approved by the host; the code matches the host's)
        var shown: String? = null
        val rec = device.pair(offer, { shown = it })
        val req = event("request")
        assertEquals("the device shows the host's confirmation code", req.getString("code"), shown)
        assertEquals("android", req.getString("platform"))
        assertEquals("kt-phone", req.getString("name"))
        assertEquals("fake-host", rec.hostName)
        val creds = device.store.credentials(rec.hostId)!!
        assertTrue("hosts.json has no token", !File(dir, "hosts.json").readText().contains(creds.token))

        // ---- open the proxy
        val px = device.open(rec.hostId)
        waitState(rec.hostId, "connected")
        assertEquals("fake-host", px.link.status.hostName)
        val port = px.port
        assertEquals(port, device.store.host(rec.hostId)!!.port)

        // auth and firewall of the local proxy
        assertEquals(401, get(port, "/").first)
        assertEquals(403, get(port, "/?token=${px.token}", host = "evil.example:$port").first)
        assertEquals(405, get(port, "/?token=${px.token}", method = "POST").first)
        val (st, hs, body) = get(port, "/?token=${px.token}", headers = mapOf("Accept" to "text/html"))
        assertEquals(200, st)
        assertTrue("index.html of the host", String(body).contains("<html"))
        assertTrue("proxy cookie set", hs["set-cookie"]!!.startsWith("${DeviceProxy.PROXY_COOKIE}="))
        assertTrue("the host's cookie never reaches the device", !String(body).contains("agent_host_token="))
        val cookie = hs["set-cookie"]!!.substringBefore(';')
        val (st2, _, js) = get(port, "/client.mjs", headers = mapOf("Cookie" to cookie))
        assertEquals(200, st2)
        assertTrue(js.size > 1000)
        assertEquals("the host's internal MCP routes are blocked", 403, get(port, "/mcp/agents", headers = mapOf("Cookie" to cookie)).first)

        // ---- /ws through the proxy: `ready` arrives (early message kept), then a command round trip
        val msgs = LinkedBlockingQueue<String>()
        val closed = LinkedBlockingQueue<Int>()
        val client = OkHttpClient()
        val ws = client.newWebSocket(Request.Builder().url("ws://127.0.0.1:$port/ws?token=${px.token}").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { msgs.put(text) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.put(code) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.put(-1) }
        })
        fun nextMsg(pred: (JSONObject) -> Boolean): JSONObject {
            val end = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < end) {
                val m = msgs.poll(500, TimeUnit.MILLISECONDS) ?: continue
                val o = JSONObject(m)
                if (pred(o)) return o
            }
            throw AssertionError("message not received")
        }
        assertEquals("ready", nextMsg { it.optString("kind") == "ready" }.getString("kind"))
        ws.send(JSONObject().put("kind", "command").put("command", "listSessions").put("id", "k1").put("args", JSONObject()).toString())
        val resp = nextMsg { it.optString("kind") == "response" && it.optString("id") == "k1" }
        assertTrue(resp.optBoolean("ok"))
        // a large message (loadSession-sized) passes the 60 KiB fragmentation both ways
        val bigText = "x".repeat(900_000)
        ws.send(JSONObject().put("kind", "command").put("command", "listSessions").put("id", "k2").put("args", JSONObject().put("pad", bigText)).toString())
        val r2 = nextMsg { it.optString("kind") == "response" && it.optString("id") == "k2" }
        assertTrue(r2.optBoolean("ok"))
        ws.close(1000, null)

        // ---- revoke on the host: state revoked, the page shows the revoked notice
        send("revoke ${rec.deviceId}")
        event("revoked")
        waitState(rec.hostId, "revoked")
        val (st3, _, page) = get(port, "/", headers = mapOf("Cookie" to cookie, "Accept" to "text/html"))
        assertEquals(503, st3)
        assertTrue(String(page).contains("data-remote-state=\"revoked\""))
        assertTrue(device.store.host(rec.hostId)!!.revokedAt != null)
        client.dispatcher.executorService.shutdown()
    }
}
