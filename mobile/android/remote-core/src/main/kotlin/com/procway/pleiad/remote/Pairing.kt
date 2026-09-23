package com.procway.pleiad.remote

// Kotlin port of core/remote/pairing.mjs and pairWithHost() in core/remote/device.mjs (docs/remote.md §3.3).
// QR: pleiad://pair?v=1&r=<relay URL>&h=<hostId>&k=<host public key b64url>&s=<pairing secret b64url>&n=<host name>

import java.net.URI
import java.net.URLDecoder
import java.util.Base64
import org.json.JSONObject

const val PAIR_SCHEME = "pleiad://pair"
const val PAIR_VERSION = "1"
const val PAIRING_TTL_MS = 5 * 60 * 1000L

/**
 * A failure with a stable code; the shell translates the code (strings live in the app's resources, not here).
 * code: payload | relay-url | denied | expired | ticket | rate | host-offline | offline | cancelled | aborted | timeout |
 *       handshake | bad-response. detail: a sub-code (e.g. the payload problem) or the relay close code.
 */
class PairError(val code: String, val detail: String = "", val closeCode: Int? = null) : Exception("$code${if (detail.isNotEmpty()) " ($detail)" else ""}")

class PairingOffer(val relayUrl: String, val hostId: String, val publicKey: ByteArray, val secret: ByteArray, val hostName: String)

/** What the device keeps per host. token is secret. */
data class HostCreds(
    val hostId: String,
    val hostPublicKey: ByteArray,
    val relayUrl: String,
    val deviceId: String,
    val token: String,
    val hostName: String,
)

object PairingCodec {
    private val LOOPBACK = setOf("localhost", "127.0.0.1", "[::1]", "::1")

    /** normalizeRelayUrl: https / wss only; http / ws only on loopback. Drops a trailing "/". Throws PairError("relay-url", sub). */
    fun normalizeRelayUrl(value: String?): String {
        val raw = (value ?: "").trim()
        if (raw.isEmpty()) return ""
        val u = try { URI(raw) } catch (_: Exception) { throw PairError("relay-url", "invalid") }
        val scheme = u.scheme?.lowercase() ?: throw PairError("relay-url", "invalid")
        val secure = scheme == "https" || scheme == "wss"
        val plain = scheme == "http" || scheme == "ws"
        if (!secure && !plain) throw PairError("relay-url", "httpsOnly")
        val host = u.host?.lowercase() ?: throw PairError("relay-url", "invalid")
        if (plain && host !in LOOPBACK) throw PairError("relay-url", "httpsOnlyLoopback")
        if (u.rawUserInfo != null) throw PairError("relay-url", "noUserinfo")
        if (u.rawQuery != null || u.rawFragment != null) throw PairError("relay-url", "noQuery")
        val defaultPort = if (scheme == "https" || scheme == "wss") 443 else 80
        val port = if (u.port == -1 || u.port == defaultPort) "" else ":${u.port}"
        val path = (u.rawPath ?: "").trimEnd('/')
        return "$scheme://$host$port$path"
    }

    fun relayWsUrl(relayUrl: String, route: String): String {
        val n = normalizeRelayUrl(relayUrl)
        val u = URI(n)
        val scheme = if (u.scheme == "https" || u.scheme == "wss") "wss" else "ws"
        val port = if (u.port == -1) "" else ":${u.port}"
        return "$scheme://${u.host}$port${(u.rawPath ?: "").trimEnd('/')}$route"
    }

    private fun query(s: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (part in s.split('&')) {
            if (part.isEmpty()) continue
            val i = part.indexOf('=')
            val k = URLDecoder.decode(if (i < 0) part else part.substring(0, i), "UTF-8")
            val v = if (i < 0) "" else URLDecoder.decode(part.substring(i + 1), "UTF-8")
            if (k !in out) out[k] = v            // URLSearchParams.get returns the first
        }
        return out
    }

    private fun b64url(s: String?): ByteArray = try {
        Base64.getUrlDecoder().decode((s ?: "").trimEnd('='))
    } catch (_: Exception) { ByteArray(0) }

    fun b64urlEncode(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun b64urlDecode(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trimEnd('='))

    /** parsePairingPayload. Throws PairError("payload", sub) with sub = notCode | unsupportedVersion | broken | hostIdMismatch. */
    fun parse(text: String?): PairingOffer {
        val s = (text ?: "").trim()
        if (!s.startsWith("$PAIR_SCHEME?")) throw PairError("payload", "notCode")
        val q = try { query(s.substring(PAIR_SCHEME.length + 1)) } catch (_: Exception) { throw PairError("payload", "broken") }
        if (q["v"] != PAIR_VERSION) throw PairError("payload", "unsupportedVersion")
        val publicKey = b64url(q["k"])
        val secret = b64url(q["s"])
        if (publicKey.size != 32 || secret.size != 32) throw PairError("payload", "broken")
        val hostId = (q["h"] ?: "").lowercase()
        if (hostId != Pleiad.hostIdFor(publicKey)) throw PairError("payload", "hostIdMismatch")
        val relay = try { normalizeRelayUrl(q["r"]) } catch (e: PairError) { throw PairError("payload", "relay-${e.detail}") }
        if (relay.isEmpty()) throw PairError("payload", "broken")
        return PairingOffer(relay, hostId, publicKey, secret, q["n"] ?: "")
    }

    /** cleanLabel: drop control characters, collapse spaces, cap the length. */
    fun cleanLabel(value: String?, max: Int = 64): String {
        val s = (value ?: "").replace(Regex("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]"), " ").replace(Regex("\\s+"), " ").trim()
        return if (s.length > max) s.substring(0, max) else s
    }
}

/** A running pairing. cancel() aborts it (the blocking pair() then throws PairError("aborted")). */
class Pairing {
    @Volatile var cancelled = false; private set
    @Volatile internal var socket: RelaySocket? = null

    fun cancel() {
        cancelled = true
        socket?.terminate()
    }

    companion object {
        private fun forClose(code: Int): PairError = when (code) {
            4401 -> PairError("ticket", closeCode = code)
            4429 -> PairError("rate", closeCode = code)
            4404, 4408 -> PairError("host-offline", closeCode = code)
            else -> PairError("cancelled", closeCode = code)
        }

        /**
         * Pair with the host (blocking; run on a worker thread). onCode(6 digits) is called after the handshake,
         * then this waits for the host's approval. Returns the credentials to store.
         */
        fun pair(
            payload: String,
            keyPair: KeyPair,
            name: String,
            platform: String = "android",
            app: String = "",
            onCode: (String) -> Unit = {},
            handle: Pairing = Pairing(),
            timeoutMs: Long = PAIRING_TTL_MS + 30_000,
            connectTimeoutMs: Long = 15_000,
        ): HostCreds {
            val p = PairingCodec.parse(payload)
            val keys = Pleiad.derivePairing(p.secret)
            if (handle.cancelled) throw PairError("aborted")
            val sock = RelaySocket(
                PairingCodec.relayWsUrl(p.relayUrl, "/v1/device"),
                mapOf("x-pleiad-host" to p.hostId, "x-pleiad-pairing" to PairingCodec.b64urlEncode(keys.ticket)),
                connectTimeoutMs,
            )
            handle.socket = sock
            if (handle.cancelled) sock.terminate()
            try {
                val o = sock.awaitOpen()
                if (handle.cancelled) throw PairError("aborted")
                if (!o.open) {
                    if (o.closeCode != null && o.closeCode != 1006) throw forClose(o.closeCode)
                    throw PairError("offline", o.status?.toString() ?: (o.error ?: ""))
                }
                val hs = Handshake(Pattern.IKpsk2, true, Pleiad.prologueFor(p.hostId), keyPair, remoteStatic = p.publicKey, psk = keys.psk)
                val hello = JSONObject().put("proto", 1).put("name", PairingCodec.cleanLabel(name)).put("platform", platform).put("app", app)
                sock.send(hs.writeMessage(hello.toString().toByteArray(Charsets.UTF_8)))
                val m2 = try {
                    sock.next(connectTimeoutMs)
                } catch (e: RelayClosed) {
                    if (handle.cancelled) throw PairError("aborted")
                    throw forClose(e.code)
                } catch (e: RelayTimeout) {
                    throw PairError("host-offline", "noResponse")
                }
                try { hs.readMessage(m2) } catch (_: Exception) { throw PairError("handshake", "keyMismatch") }
                val transport = hs.split()
                val code = Pleiad.confirmationCode(hs.handshakeHash)
                sock.send(transport.encrypt(JSONObject().put("type", "pair").toString().toByteArray(Charsets.UTF_8)))
                try { onCode(code) } catch (_: Exception) {}
                val msg = try {
                    JSONObject(String(transport.decrypt(sock.next(timeoutMs)), Charsets.UTF_8))
                } catch (e: RelayClosed) {
                    if (handle.cancelled) throw PairError("aborted")
                    throw forClose(e.code)
                } catch (e: RelayTimeout) {
                    throw PairError("timeout")
                } catch (e: Exception) {
                    if (handle.cancelled) throw PairError("aborted")
                    throw PairError("handshake", "unreadable")
                }
                when (msg.optString("type")) {
                    "denied" -> throw PairError("denied")
                    "expired" -> throw PairError("expired")
                    "approved" -> {}
                    else -> throw PairError("bad-response")
                }
                val deviceId = msg.opt("deviceId") as? String ?: throw PairError("bad-response")
                val token = msg.opt("token") as? String ?: throw PairError("bad-response")
                val hostName = PairingCodec.cleanLabel((msg.opt("hostName") as? String)?.takeIf { it.isNotEmpty() } ?: p.hostName)
                return HostCreds(p.hostId, p.publicKey, p.relayUrl, deviceId, token, hostName)
            } catch (e: PairError) {
                if (handle.cancelled && e.code != "aborted") throw PairError("aborted")
                throw e
            } finally {
                handle.socket = null
                if (sock.closed == null) sock.close(1000) else sock.terminate()
            }
        }
    }
}
