package com.procway.pleiad.remote

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The notification flow end to end, Kotlin device against the real Node relay and a fake-backend host
 * (mobile/scripts/fake-host.mjs): pair, register the notification key over the E2E channel, hold the notify line, and see
 * approvals / completions / failures arrive, bundle and get cancelled. No LLM, nothing beyond 127.0.0.1.
 * Skipped when node is not on PATH or PLEIAD_INTEROP=off.
 */
class NotifyInteropTest {
    private val events = LinkedBlockingQueue<JSONObject>()
    private val actions = LinkedBlockingQueue<NotifyAction>()
    private var proc: Process? = null

    private fun event(name: String, ms: Long = 60_000, pred: (JSONObject) -> Boolean = { true }): JSONObject {
        val end = System.currentTimeMillis() + ms
        while (true) {
            val left = end - System.currentTimeMillis()
            check(left > 0) { "no '$name' from fake-host" }
            val o = events.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (o.optString("event") == name && pred(o)) return o
            if (o.optString("event") == "error") throw IllegalStateException(o.toString())
        }
    }

    private fun send(cmd: String) {
        proc!!.outputStream.write("$cmd\n".toByteArray()); proc!!.outputStream.flush()
    }

    private fun next(ms: Long = 20_000): NotifyAction = actions.poll(ms, TimeUnit.MILLISECONDS) ?: throw AssertionError("no notification action within ${ms}ms")
    private fun none(ms: Long = 1_500) = assertEquals(null, actions.poll(ms, TimeUnit.MILLISECONDS))

    @Test fun approvalsCompletionsAndFailuresReachTheDevice() {
        val mode = System.getProperty("pleiad.interop") ?: "auto"
        assumeTrue(mode != "off")
        val repo = File(System.getProperty("pleiad.repo") ?: "../../..")
        val script = File(repo, "mobile/scripts/fake-host.mjs")
        val node = if (System.getProperty("os.name").lowercase().contains("win")) "node.exe" else "node"
        val p = try { ProcessBuilder(node, script.absolutePath, "--auto-approve").directory(repo).redirectErrorStream(false).start() }
        catch (e: Exception) { assumeTrue("node not available: ${e.message}", false); return }
        proc = p
        Thread { BufferedReader(InputStreamReader(p.inputStream)).forEachLine { l -> try { events.put(JSONObject(l)) } catch (_: Exception) {} } }.apply { isDaemon = true }.start()
        Thread { p.errorStream.readBytes() }.apply { isDaemon = true }.start()
        val dir = kotlin.io.path.createTempDirectory("pleiad-kt-notify").toFile()
        var hub: NotifyHub? = null
        val device = RemoteDevice(FileDeviceStore(dir), app = "kt-test", name = "kt-phone", backoff = Backoff(200, 1000, 1000), connectTimeoutMs = 5000, requestWaitMs = 5000)
        try {
            event("ready", 120_000)
            val rec = device.pair(event("offer").getString("payload"), {})
            event("request")
            val store = device.store
            store.saveNotifySettings(NotifySettings(enabled = true))
            hub = NotifyHub(store, device.loop, "kt-test", "kt-phone", object : NotifySink {
                override fun act(actions: List<NotifyAction>, settings: NotifySettings) { for (a in actions) this@NotifyInteropTest.actions.put(a) }
            }, lineBackoff = Backoff(200, 1000, 1000), pingMs = 30_000, registerRetryMs = 500)
            hub.start()

            // Registration: the host now lists this phone with notifications on
            val end = System.currentTimeMillis() + 30_000
            while (!hub.registered(rec.hostId) && System.currentTimeMillis() < end) Thread.sleep(100)
            assertTrue("the key is registered with the host", hub.registered(rec.hostId))
            send("notify-status")
            val phones = event("notify").getJSONObject("status").getJSONArray("devices")
            assertEquals(1, phones.length())
            assertEquals("kt-phone", phones.getJSONObject(0).getString("name"))
            assertTrue(phones.getJSONObject(0).getJSONObject("notify").getBoolean("enabled"))
            val waitLine = System.currentTimeMillis() + 15_000
            while (hub.states()[rec.hostId] != "connected" && System.currentTimeMillis() < waitLine) Thread.sleep(100)
            assertEquals("the notify line is up", "connected", hub.states()[rec.hostId])

            // ── an approval: Post (attention) with the conversation name, then Cancel when it is decided ──
            send("turn ask")
            val perm = event("permission")
            val ask = next() as NotifyAction.Post
            assertTrue(ask.attention); assertEquals(NoticeKind.APPROVAL, ask.kind); assertEquals(perm.getString("sessionId"), ask.session)
            assertEquals("fake-host", ask.host); assertEquals("a first turn has no title yet (the app shows its untitled text)", "", ask.title)
            send("resolve")
            val cancel = next() as NotifyAction.Cancel
            assertEquals(ask.key, cancel.key)
            event("turnEnd")
            // the turn that asked then finishes: its completion is notified too, and looking at it elsewhere cancels it
            val askDone = next() as NotifyAction.Post
            assertEquals(NoticeKind.DONE, askDone.kind); assertEquals(ask.session, askDone.session); assertEquals("ask", askDone.title)
            send("read ${ask.session}")
            assertEquals(NotifyAction.Cancel(askDone.key), next())
            none()

            // ── completions: one, then a bundle from the second ──
            send("turn echo:first job")
            val t1 = event("turn").getString("sessionId")
            val d1 = next() as NotifyAction.Post
            assertEquals(NoticeKind.DONE, d1.kind); assertFalse(d1.attention); assertEquals("echo:first job", d1.title)
            send("turn echo:second job")
            val t2 = event("turn").getString("sessionId")
            val second = (0 until 2).map { next() }
            assertTrue("the first completion goes away", second.contains(NotifyAction.Cancel(d1.key)))
            val bundle = second.filterIsInstance<NotifyAction.Bundle>().single()
            assertEquals(2, bundle.count); assertEquals(t2, bundle.session)
            assertEquals(listOf("echo:second job", "echo:first job"), bundle.titles)

            // looking at one of them elsewhere cancels it; the other comes back alone
            send("read $t2")
            val shrink = (0 until 3).map { next() }
            assertTrue(shrink.any { it is NotifyAction.Cancel && it.key == NotifyPlanner.slotKey(rec.hostId, t2) })
            assertTrue(shrink.any { it is NotifyAction.Post && it.session == t1 && it.silent })
            none()

            // ── a failure ──
            send("turn fail")
            val failed = next() as NotifyAction.Post
            assertEquals(NoticeKind.FAILED, failed.kind); assertTrue(failed.attention)

            // ── turning completions off is enforced and told to the host ──
            store.saveNotifySettings(store.notifySettings().copy(done = false))
            hub.settingsChanged()
            Thread.sleep(2_500)
            send("turn echo:third job")
            event("turnEnd", 20_000) { it.optString("outcome") == "ok" }
            none(2_500)
            send("turn fail")
            assertEquals(NoticeKind.FAILED, (next() as NotifyAction.Post).kind)
        } finally {
            hub?.stop()
            device.closeAll()
            try { send("quit") } catch (_: Exception) {}
            if (!p.waitFor(15, TimeUnit.SECONDS)) p.destroyForcibly()
            dir.deleteRecursively()
        }
    }
}
