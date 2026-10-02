package com.procway.pleiad.remote

// Registers this device's notification key and settings with a host (docs/remote.md §11-5, ADR 0086).
//
// The key (the device makes it) must reach the host through the end-to-end channel, never through the relay's notify
// line. So this opens a short-lived Noise channel to the host (a DeviceLink, like the host window uses), opens `/ws`
// through the host's firewall, sends one `notifyRegister` command, waits for the reply and closes. The host binds the key
// to the device the channel was authenticated for. Hosts that predate notifications do not say `notify: 1` in `ready`
// and are not sent anything.

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

sealed interface RegisterResult {
    /** Registered. [enabled] is the host's view of the settings. */
    data class Done(val enabled: Boolean) : RegisterResult
    /** The host is too old for notifications (no `notify` in ready). */
    object Unsupported : RegisterResult
    /** Could not reach the host or it refused. [state] is the link state or "timeout" / "refused". */
    data class Failed(val state: String, val detail: String? = null) : RegisterResult
}

class NotifyRegistrar(
    private val loop: Loop,
    private val keyPair: KeyPair,
    private val app: String,
    private val name: String,
    private val connectTimeoutMs: Long = 15_000,
    private val log: (String) -> Unit = {},
) {
    /** Blocking (never call on the loop). */
    fun register(creds: HostCreds, key: ByteArray, settings: NotifySettings, timeoutMs: Long = 30_000): RegisterResult {
        val link = DeviceLink(loop, creds, keyPair, app, name, "mobile", Backoff(500, 2_000, 1_000), connectTimeoutMs, log = log)
        val done = CountDownLatch(1)
        val result = java.util.concurrent.atomic.AtomicReference<RegisterResult>(RegisterResult.Failed("timeout"))
        var finished = false
        var stream: Stream? = null
        var timer: Cancellable? = null
        fun finish(r: RegisterResult) {   // loop
            if (finished) return
            finished = true
            result.set(r)
            timer?.cancel()
            try { stream?.let { if (!it.destroyed) it.close(1000, "") } } catch (_: Exception) {}
            done.countDown()
        }
        val id = "notify-register"
        loop.exec {
            timer = loop.schedule(timeoutMs) { finish(RegisterResult.Failed("timeout")) }
            link.start()
            link.ready(connectTimeoutMs + 5_000) { ch, err ->
                if (ch == null) return@ready finish(RegisterResult.Failed(err?.state ?: "offline"))
                try {
                    val st = ch.openWs(JSONObject().put("path", "/ws").put("protocols", JSONArray()))
                    stream = st
                    st.listener = object : StreamListener {
                        override fun onAccept() {}
                        override fun onReject(status: Int) = finish(RegisterResult.Failed("refused", "http $status"))
                        override fun onReset(code: Int, remote: Boolean) = finish(RegisterResult.Failed("refused", "reset $code"))
                        override fun onClose(code: Int, reason: String) = finish(RegisterResult.Failed("closed", "$code"))
                        override fun onMessage(data: ByteArray, text: Boolean, release: Release) {
                            release()
                            if (!text || finished) return
                            val m = try { JSONObject(String(data, Charsets.UTF_8)) } catch (_: Exception) { return }
                            when (m.optString("kind")) {
                                "ready" -> {
                                    if (m.optInt("notify") != 1) return finish(RegisterResult.Unsupported)
                                    val cmd = JSONObject().put("kind", "command").put("command", "notifyRegister").put("id", id)
                                        .put("args", JSONObject().put("key", NotifyCrypto.encodeKey(key)).put("settings", settings.toJson()))
                                    st.send(cmd.toString().toByteArray(Charsets.UTF_8), true)
                                }
                                "response" -> if (m.optString("id") == id) {
                                    if (m.optBoolean("ok")) finish(RegisterResult.Done(m.optJSONObject("result")?.optBoolean("enabled") ?: false))
                                    else finish(RegisterResult.Failed("refused", m.optString("error")))
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    finish(RegisterResult.Failed("error", e.message))
                }
            }
        }
        done.await(timeoutMs + 5_000, TimeUnit.MILLISECONDS)
        link.stop()
        return result.get()
    }
}
