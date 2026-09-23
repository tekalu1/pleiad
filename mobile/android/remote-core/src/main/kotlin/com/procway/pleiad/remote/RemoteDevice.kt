package com.procway.pleiad.remote

// Kotlin port of core/remote/device.mjs (docs/remote.md §3.1・§3.3・§7): the device's key, the paired hosts, pairing,
// and one loopback proxy per open host.
//
//   <dir>/secrets.bin  device static key + per-host relay tokens, sealed by a SecretCipher (Android Keystore in the app)
//   <dir>/hosts.json   { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                        pairedAt, lastConnectedAt, revokedAt }] }   (no secrets; same shape as the desktop's hosts.json)

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/** Seals the secrets file. The app uses an Android Keystore AES-GCM key; tests use [PlainCipher]. */
interface SecretCipher {
    val encrypted: Boolean
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

object PlainCipher : SecretCipher {
    override val encrypted = false
    override fun seal(plain: ByteArray) = plain
    override fun open(sealed: ByteArray) = sealed
}

data class HostRecord(
    val hostId: String,
    val hostName: String,
    val label: String,
    val relayUrl: String,
    val hostPublicKey: String,
    val deviceId: String,
    val port: Int,
    val pairedAt: Long?,
    val lastConnectedAt: Long?,
    val revokedAt: Long?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("hostId", hostId).put("hostName", hostName).put("label", label).put("relayUrl", relayUrl)
        .put("hostPublicKey", hostPublicKey).put("deviceId", deviceId).put("port", port)
        .put("pairedAt", pairedAt ?: JSONObject.NULL).put("lastConnectedAt", lastConnectedAt ?: JSONObject.NULL)
        .put("revokedAt", revokedAt ?: JSONObject.NULL)

    /** For the shell UI: no key material. */
    fun toPublicJson(): JSONObject = toJson().apply { remove("hostPublicKey") }

    companion object {
        private fun time(o: JSONObject, k: String): Long? = when (val v = o.opt(k)) {
            is Number -> v.toLong()
            is String -> try { java.time.Instant.parse(v).toEpochMilli() } catch (_: Exception) { null }
            else -> null
        }

        fun fromJson(o: JSONObject) = HostRecord(
            o.getString("hostId"), o.optString("hostName"), o.optString("label"), o.getString("relayUrl"),
            o.getString("hostPublicKey"), o.getString("deviceId"), o.optInt("port", 0),
            time(o, "pairedAt"), time(o, "lastConnectedAt"), time(o, "revokedAt"),
        )
    }
}

class FileDeviceStore(private val dir: File, private val cipher: SecretCipher = PlainCipher) {
    private val hostsFile = File(dir, "hosts.json")
    private val secretsFile = File(dir, "secrets.bin")
    private val lock = Any()
    private var keyPair: KeyPair? = null
    val encrypted get() = cipher.encrypted

    init { dir.mkdirs() }

    private fun writeAtomic(f: File, data: ByteArray) {
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw java.io.IOException("cannot write ${f.name}") }
    }

    private fun readSecrets(): JSONObject {
        if (!secretsFile.exists()) return JSONObject()
        return JSONObject(String(cipher.open(secretsFile.readBytes()), Charsets.UTF_8))
    }

    private fun writeSecrets(o: JSONObject) = writeAtomic(secretsFile, cipher.seal(o.toString().toByteArray(Charsets.UTF_8)))

    private fun readHosts(): MutableList<HostRecord> {
        if (!hostsFile.exists()) return mutableListOf()
        val o = JSONObject(hostsFile.readText(Charsets.UTF_8))
        if (o.optInt("version") != 1) throw IllegalStateException("hosts.json has an unexpected format")
        val arr = o.getJSONArray("hosts")
        return MutableList(arr.length()) { HostRecord.fromJson(arr.getJSONObject(it)) }
    }

    private fun writeHosts(list: List<HostRecord>) {
        val arr = JSONArray()
        for (h in list) arr.put(h.toJson())
        writeAtomic(hostsFile, JSONObject().put("version", 1).put("hosts", arr).toString(2).toByteArray(Charsets.UTF_8))
    }

    /** The device static key (one for all hosts). Created on first use. */
    fun identity(): KeyPair = synchronized(lock) {
        keyPair?.let { return it }
        val secrets = readSecrets()
        val priv = secrets.optString("deviceKey").takeIf { it.isNotEmpty() }?.let { PairingCodec.b64urlDecode(it) }
            ?: KeyPair.generate().privateKey.also { writeSecrets(secrets.put("deviceKey", PairingCodec.b64urlEncode(it))) }
        KeyPair.fromPrivate(priv).also { keyPair = it }
    }

    fun hosts(): List<HostRecord> = synchronized(lock) { readHosts() }
    fun host(hostId: String): HostRecord? = hosts().find { it.hostId == hostId }

    fun credentials(hostId: String): HostCreds? = synchronized(lock) {
        val h = readHosts().find { it.hostId == hostId } ?: return null
        val token = readSecrets().optJSONObject("host:$hostId")?.optString("token")?.takeIf { it.isNotEmpty() } ?: return null
        HostCreds(h.hostId, PairingCodec.b64urlDecode(h.hostPublicKey), h.relayUrl, h.deviceId, token, h.hostName)
    }

    fun saveHost(c: HostCreds): HostRecord = synchronized(lock) {
        require(Regex("^[a-z2-7]{26}$").matches(c.hostId)) { "invalid hostId" }
        writeSecrets(readSecrets().put("host:${c.hostId}", JSONObject().put("token", c.token)))
        val list = readHosts()
        val prev = list.find { it.hostId == c.hostId }
        val rec = HostRecord(
            c.hostId, PairingCodec.cleanLabel(c.hostName), prev?.label ?: "", c.relayUrl, PairingCodec.b64urlEncode(c.hostPublicKey),
            c.deviceId, prev?.port ?: 0, System.currentTimeMillis(), null, null,
        )
        writeHosts(list.filter { it.hostId != c.hostId } + rec)
        rec
    }

    fun updateHost(hostId: String, patch: (HostRecord) -> HostRecord): HostRecord? = synchronized(lock) {
        val list = readHosts()
        val i = list.indexOfFirst { it.hostId == hostId }
        if (i < 0) return null
        val rec = patch(list[i])
        list[i] = rec
        writeHosts(list)
        rec
    }

    fun removeHost(hostId: String): HostRecord? = synchronized(lock) {
        val secrets = readSecrets()
        secrets.remove("host:$hostId")
        writeSecrets(secrets)
        val list = readHosts()
        val hit = list.find { it.hostId == hostId }
        writeHosts(list.filter { it.hostId != hostId })
        hit
    }
}

/** The device as a whole: host list, pairing, one proxy per open host. */
class RemoteDevice(
    val store: FileDeviceStore,
    val app: String,
    val name: String,
    val platform: String = "android",
    private val texts: ProxyTexts = DefaultTexts,
    private val backoff: Backoff = Backoff(),
    private val connectTimeoutMs: Long = 15_000,
    private val requestWaitMs: Long = 10_000,
    private val log: (String) -> Unit = {},
) {
    val loop = Loop()
    private val proxies = ConcurrentHashMap<String, DeviceProxy>()
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(String, LinkStatus) -> Unit>()

    fun onStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.add(fn) }
    fun offStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.remove(fn) }

    /** Host list with the live state ("closed" when no proxy is open, "revoked" when the host removed us). */
    fun list(): List<Pair<HostRecord, LinkStatus?>> = store.hosts().map { h -> h to proxies[h.hostId]?.link?.status }

    /** Pair and save (blocking). An open proxy for the same host reconnects with the new credentials. */
    fun pair(payload: String, onCode: (String) -> Unit, handle: Pairing = Pairing()): HostRecord {
        val kp = store.identity()
        val creds = Pairing.pair(payload, kp, name, platform, app, onCode, handle)
        val rec = store.saveHost(creds)
        proxies[rec.hostId]?.let { px -> store.credentials(rec.hostId)?.let { px.retryNow(it) } }
        return rec
    }

    /** Open (or reuse) the host's proxy. Blocking (binds the port). */
    @Synchronized
    fun open(hostId: String): DeviceProxy {
        proxies[hostId]?.let { return it }
        val creds = store.credentials(hostId) ?: throw IllegalArgumentException("unknown-host")
        val rec = store.host(hostId)
        val px = DeviceProxy(
            loop, creds, store.identity(), rec?.port ?: 0, app, name, "mobile", backoff, connectTimeoutMs, requestWaitMs, texts, log,
        )
        px.onStatus { s ->
            try {
                if (s.state == "connected") store.updateHost(hostId) {
                    it.copy(lastConnectedAt = System.currentTimeMillis(), revokedAt = null, hostName = if (s.hostName.isNotEmpty()) PairingCodec.cleanLabel(s.hostName) else it.hostName)
                }
                if (s.state == "revoked") store.updateHost(hostId) { it.copy(revokedAt = System.currentTimeMillis()) }
            } catch (e: Exception) { log("remote device: ${e.message}") }
            for (l in listeners) try { l(hostId, s) } catch (_: Exception) {}
        }
        px.start()
        if (px.port != (rec?.port ?: 0)) store.updateHost(hostId) { it.copy(port = px.port) }
        proxies[hostId] = px
        return px
    }

    fun proxy(hostId: String): DeviceProxy? = proxies[hostId]

    fun close(hostId: String) { proxies.remove(hostId)?.close() }

    fun rename(hostId: String, label: String) = store.updateHost(hostId) { it.copy(label = PairingCodec.cleanLabel(label)) }

    /** Forget the pairing here (the host still lists the device until it is revoked there). */
    fun remove(hostId: String): HostRecord? { close(hostId); return store.removeHost(hostId) }

    fun closeAll() { for (k in proxies.keys.toList()) close(k) }
}
