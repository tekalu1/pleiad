package com.procway.pleiad

import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.procway.pleiad.remote.LinkStatus
import com.procway.pleiad.remote.PairError
import com.procway.pleiad.remote.Pairing
import com.procway.pleiad.remote.PairingCodec
import com.procway.pleiad.remote.X25519
import java.util.concurrent.Executors

/**
 * The host list's bridge to the device side (only the bundled shell page sees it; host pages never do).
 * Errors are rejected with a stable `code` (payload, relay-url, denied, expired, ticket, rate, host-offline, offline,
 * cancelled, aborted, timeout, handshake, bad-response, storage, unknown-host); the page translates them.
 * Events: `status` { hostId, state, ... }, `pairCode` { code }, `pairLink` {} (then call takePairLink()).
 */
@CapacitorPlugin(name = "PleiadRemote")
class PleiadRemotePlugin : Plugin() {
    companion object {
        private val worker = Executors.newCachedThreadPool { r -> Thread(r, "pleiad-plugin").also { it.isDaemon = true } }
        @Volatile private var instance: PleiadRemotePlugin? = null
        @Volatile private var pendingLink: String? = null

        fun offerLink(payload: String) {
            pendingLink = payload
            instance?.notifyListeners("pairLink", JSObject())   // the page then calls takePairLink()
        }
    }

    private val device get() = (context.applicationContext as PleiadApp).device
    @Volatile private var pairing: Pairing? = null
    private val statusListener: (String, LinkStatus) -> Unit = { hostId, s ->
        notifyListeners("status", JSObject(s.toJson().put("hostId", hostId).toString()))
    }

    override fun load() {
        instance = this
        device.onStatus(statusListener)
    }

    override fun handleOnDestroy() {
        device.offStatus(statusListener)
        if (instance === this) instance = null
    }

    private fun bg(call: PluginCall, fn: () -> Unit) = worker.execute {
        try { fn() } catch (e: PairError) {
            call.reject(e.message, e.code, JSObject().put("detail", e.detail).put("closeCode", e.closeCode))
        } catch (e: IllegalArgumentException) {
            call.reject(e.message, if (e.message == "unknown-host") "unknown-host" else "internal")
        } catch (e: java.security.GeneralSecurityException) {
            call.reject(e.message, "storage")
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString(), "internal")
        }
    }

    @PluginMethod
    fun info(call: PluginCall) = bg(call) {
        call.resolve(
            JSObject()
                .put("deviceName", (context.applicationContext as PleiadApp).deviceName())
                .put("app", BuildConfig.VERSION_NAME)
                .put("encrypted", device.store.encrypted)
                .put("x25519", X25519.implementation),
        )
    }

    @PluginMethod
    fun list(call: PluginCall) = bg(call) {
        val arr = JSArray()
        for ((h, st) in device.list()) {
            val o = JSObject(h.toPublicJson().toString())
            o.put("state", st?.state ?: if (h.revokedAt != null) "revoked" else "closed")
            o.put("open", st != null)
            arr.put(o)
        }
        call.resolve(JSObject().put("hosts", arr))
    }

    /** Check a pasted / scanned payload before pairing (for the confirmation step). */
    @PluginMethod
    fun parse(call: PluginCall) = bg(call) {
        val o = PairingCodec.parse(call.getString("payload"))
        val known = device.store.host(o.hostId) != null
        call.resolve(JSObject().put("hostId", o.hostId).put("hostName", PairingCodec.cleanLabel(o.hostName)).put("relayUrl", o.relayUrl).put("known", known))
    }

    /** Resolves when the host approved. `pairCode` is emitted as soon as the confirmation code is known. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun pair(call: PluginCall) {
        val payload = call.getString("payload") ?: return call.reject("payload", "payload")
        val handle = Pairing()
        pairing?.cancel()
        pairing = handle
        bg(call) {
            try {
                val rec = device.pair(payload, { code -> notifyListeners("pairCode", JSObject().put("code", code)) }, handle)
                call.resolve(JSObject().put("host", JSObject(rec.toPublicJson().toString())))
            } finally {
                if (pairing === handle) pairing = null
            }
        }
    }

    @PluginMethod
    fun cancelPair(call: PluginCall) {
        pairing?.cancel()
        pairing = null
        call.resolve()
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val hostId = call.getString("hostId") ?: return call.reject("hostId", "unknown-host")
        bg(call) {
            if (device.store.host(hostId) == null) throw IllegalArgumentException("unknown-host")
            val i = Intent(context, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, hostId)
            activity.runOnUiThread { activity.startActivity(i) }
            call.resolve()
        }
    }

    @PluginMethod
    fun rename(call: PluginCall) = bg(call) {
        val rec = device.rename(call.getString("hostId") ?: "", call.getString("label") ?: "") ?: throw IllegalArgumentException("unknown-host")
        call.resolve(JSObject().put("host", JSObject(rec.toPublicJson().toString())))
    }

    @PluginMethod
    fun remove(call: PluginCall) = bg(call) {
        device.remove(call.getString("hostId") ?: "")
        call.resolve()
    }

    /** A pleiad://pair link the app was opened with (once). */
    @PluginMethod
    fun takePairLink(call: PluginCall) {
        val p = pendingLink
        pendingLink = null
        call.resolve(JSObject().put("payload", p))
    }
}
