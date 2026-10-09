package dev.pleiad.app.remote

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Device and host channels connected by an in-memory pipe over a real Noise transport (like tests/unit/remote-channel.mjs). */
class ChannelTest {
    private val loop = Loop("test-loop")
    @Volatile var lastText: String? = null

    @After fun done() = loop.shutdown()

    // old = a peer from before ADR 0179 (does not widen its receive windows)
    private fun pair(deviceOld: Boolean = false, hostOld: Boolean = false): Pair<Channel, Channel> {
        val host = KeyPair.generate()
        val dev = KeyPair.generate()
        val i = Handshake(Pattern.IK, true, Pleiad.prologueFor("h"), dev, remoteStatic = host.publicKey)
        val r = Handshake(Pattern.IK, false, Pleiad.prologueFor("h"), host)
        r.readMessage(i.writeMessage())
        i.readMessage(r.writeMessage())
        lateinit var d: Channel
        lateinit var h: Channel
        val sw = { old: Boolean -> if (old) ChannelConst.STREAM_WINDOW else ChannelConst.RECV_STREAM_WINDOW }
        val cw = { old: Boolean -> if (old) ChannelConst.CHANNEL_WINDOW else ChannelConst.RECV_CHANNEL_WINDOW }
        d = Channel(loop, "device", { b -> loop.post { h.receive(b) } }, i.split(), JSONObject().put("app", "t").put("shell", "mobile"),
            recvStreamWindow = sw(deviceOld), recvChannelWindow = cw(deviceOld), pingIntervalMs = 0)
        h = Channel(loop, "host", { b -> loop.post { d.receive(b) } }, r.split(), JSONObject().put("hostName", "hn"),
            recvStreamWindow = sw(hostOld), recvChannelWindow = cw(hostOld), pingIntervalMs = 0)
        return d to h
    }

    @Test fun httpLargeBodyWithFlowControl() {
        val (d, h) = pair()
        val body = randomBytes(3 * 1024 * 1024 + 123)   // > channel window: needs WINDOW round trips
        val got = java.io.ByteArrayOutputStream()
        val latch = CountDownLatch(1)
        var status = 0
        var hostName = ""
        loop.call {
            h.listener = object : ChannelListener {
                override fun onStream(stream: Stream): Boolean {
                    assertEquals("/big", stream.request.getString("path"))
                    stream.respond(JSONObject().put("status", 200).put("headers", JSONObject()))
                    stream.write(body)
                    stream.end()
                    return true
                }
            }
            d.listener = object : ChannelListener { override fun onHello(hello: JSONObject) { hostName = hello.optString("hostName") } }
            h.start(); d.start()
        }
        Thread.sleep(100)
        loop.call {
            val s = d.openHttp(JSONObject().put("method", "GET").put("path", "/big").put("headers", JSONObject()))
            s.listener = object : StreamListener {
                override fun onResponse(head: JSONObject) { status = head.getInt("status") }
                // release later from another thread, like the proxy does after writing to the socket
                override fun onData(chunk: ByteArray, release: Release) { got.write(chunk); Thread { release() }.start() }
                override fun onEnd() { latch.countDown() }
            }
            s.end()
        }
        assertTrue("body completes", latch.await(20, TimeUnit.SECONDS))
        assertEquals(200, status)
        assertEquals("hn", hostName)
        assertTrue(body.contentEquals(got.toByteArray()))
    }

    // The receiver widens its windows with WINDOW increments (ADR 0179). The sender stops at whatever the receiver
    // granted, so new and old peers mix: an old device stops the host at 256 KiB, a new one at 1 MiB.
    private fun heldThenComplete(deviceOld: Boolean, hostOld: Boolean): Pair<Long, Boolean> {
        val (d, h) = pair(deviceOld, hostOld)
        val body = randomBytes(3 * 1024 * 1024)
        val got = java.io.ByteArrayOutputStream()
        val held = ArrayList<Release>()
        val done = CountDownLatch(1)
        var hold = true   // touched only on the loop
        loop.call {
            h.listener = object : ChannelListener {
                override fun onStream(stream: Stream): Boolean {
                    stream.respond(JSONObject().put("status", 200).put("headers", JSONObject()))
                    stream.write(body)
                    stream.end()
                    return true
                }
            }
            h.start(); d.start()
        }
        Thread.sleep(100)
        loop.call {
            val s = d.openHttp(JSONObject().put("method", "GET").put("path", "/mixed").put("headers", JSONObject()))
            s.listener = object : StreamListener {
                override fun onData(chunk: ByteArray, release: Release) { got.write(chunk); if (hold) held.add(release) else release() }
                override fun onEnd() { done.countDown() }
            }
            s.end()
        }
        Thread.sleep(500)
        val stoppedAt = loop.call { hold = false; held.forEach { it() }; held.clear(); got.size().toLong() }
        val completed = done.await(20, TimeUnit.SECONDS) && body.contentEquals(got.toByteArray())
        return stoppedAt to completed
    }

    @Test fun receiverWidensWindowsAndMixesWithOldPeers() {
        val cases = listOf(
            Triple(false, false, ChannelConst.RECV_STREAM_WINDOW),
            Triple(true, false, ChannelConst.STREAM_WINDOW),    // old device × new host
            Triple(false, true, ChannelConst.RECV_STREAM_WINDOW), // new device × old host
            Triple(true, true, ChannelConst.STREAM_WINDOW),
        )
        for ((devOld, hostOld, expect) in cases) {
            val (stoppedAt, completed) = heldThenComplete(devOld, hostOld)
            assertEquals("device old=$devOld host old=$hostOld: stops at the window the device granted", expect, stoppedAt)
            assertTrue("device old=$devOld host old=$hostOld: completes after releasing", completed)
        }
    }

    @Test fun wsMessagesBothWaysIncludingLargeOnes() {
        val (d, h) = pair()
        val big = randomBytes(700 * 1024)
        val latch = CountDownLatch(2)
        var echoed: ByteArray? = null
        loop.call {
            h.listener = object : ChannelListener {
                override fun onStream(stream: Stream): Boolean {
                    stream.listener = object : StreamListener {
                        override fun onMessage(data: ByteArray, text: Boolean, release: Release) {
                            release()
                            stream.send(data, text)
                        }
                    }
                    stream.accept()
                    stream.send("ready".toByteArray(), true)   // sent right after ACCEPT, like the host's `ready`
                    return true
                }
            }
            h.start(); d.start()
        }
        Thread.sleep(100)
        loop.call {
            val s = d.openWs(JSONObject().put("path", "/ws").put("protocols", org.json.JSONArray()))
            s.listener = object : StreamListener {
                override fun onAccept() { s.send(big, false) }
                override fun onMessage(data: ByteArray, text: Boolean, release: Release) {
                    release()
                    if (text) this@ChannelTest.lastText = String(data) else echoed = data
                    latch.countDown()
                }
            }
        }
        assertTrue(latch.await(20, TimeUnit.SECONDS))
        assertEquals("ready", lastText)
        assertTrue(big.contentEquals(echoed!!))
    }

    @Test fun protocolViolationSendsGoaway() {
        val (d, h) = pair()
        val closed = CountDownLatch(1)
        var code: String? = null
        loop.call {
            d.listener = object : ChannelListener { override fun onClose(err: ChannelError?) { code = err?.code; closed.countDown() } }
            h.start(); d.start()
        }
        Thread.sleep(100)
        // host sends DATA on a stream that was never opened
        loop.call { h.sendNow(T.DATA, 1, "x".toByteArray()) }
        assertTrue(closed.await(5, TimeUnit.SECONDS))
        assertEquals("protocol", code)
    }
}
