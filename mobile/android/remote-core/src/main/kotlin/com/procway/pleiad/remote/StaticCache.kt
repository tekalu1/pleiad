package com.procway.pleiad.remote

// Kotlin port of core/remote/static-cache.mjs and the reader of core/remote/static-bundle.mjs (docs/remote.md §8.6,
// ADR 0901): the device keeps the host's web/ shell as one bundle per host, and asks the host on every page load
// (/ and /index.html) whether it is still current (GET /static-bundle?have=<key>: 304 when unchanged, one round trip).
// While a checked bundle is held, the proxy answers the WebView's static requests itself.
// An old host without the endpoint (404) or a failed check gives null, and the proxy forwards to the host as before.
//
// Bundle (big-endian): "PLSB" | u32 header length | header JSON (UTF-8) | the bodies in files order
//   header: { format: 1, key, files: [{ path, type, size }] }
//   key = sha256 hex over, per file in order, "<path>\n<type>\n<size>\n" and the body. Recomputed here, so a torn or
//   corrupted file is never used. Saved uncompressed at <dir>/static/<hostId>.bin, written to a temp name then renamed.

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.Inflater
import org.json.JSONObject

class StaticFile(val type: String, val body: ByteArray)

class StaticBundle(val key: String, val files: Map<String, StaticFile>)

/** One HTTP response read whole (header names lower-cased). */
class StaticFetch(val status: Int, val headers: Map<String, String>, val body: ByteArray)

object StaticBundleCodec {
    const val PATH = "/static-bundle"
    const val FORMAT = 1
    const val KEY_HEADER = "x-pleiad-bundle-key"
    const val ENCODING_HEADER = "x-pleiad-bundle-encoding"
    /** Limit before and after inflating (the host's web/ is about 5 MB). */
    const val MAX_BYTES = 64 * 1024 * 1024
    private val MAGIC = "PLSB".toByteArray(Charsets.ISO_8859_1)
    private val KEY_RE = Regex("^[0-9a-f]{64}$")
    private val PATH_RE = Regex("^/[A-Za-z0-9._\\-/]+$")

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** Throws when the magic, the header, the sizes or the key do not match. */
    fun decode(buf: ByteArray): StaticBundle {
        if (buf.size < 8 || !buf.copyOfRange(0, 4).contentEquals(MAGIC)) throw IOException("static bundle: bad magic")
        val headLen = ((buf[4].toLong() and 0xff) shl 24) or ((buf[5].toLong() and 0xff) shl 16) or
            ((buf[6].toLong() and 0xff) shl 8) or (buf[7].toLong() and 0xff)
        if (headLen > buf.size - 8) throw IOException("static bundle: bad header length")
        val head = JSONObject(String(buf, 8, headLen.toInt(), Charsets.UTF_8))
        val key = head.optString("key")
        val list = head.optJSONArray("files")
        if (head.opt("format") != FORMAT || !KEY_RE.matches(key) || list == null) throw IOException("static bundle: bad header")
        val md = MessageDigest.getInstance("SHA-256")
        val files = LinkedHashMap<String, StaticFile>()
        var at = 8 + headLen.toInt()
        for (i in 0 until list.length()) {
            val f = list.optJSONObject(i) ?: throw IOException("static bundle: bad entry")
            val path = f.opt("path") as? String
            val type = f.opt("type") as? String
            val size = when (val s = f.opt("size")) { is Int -> s.toLong(); is Long -> s; else -> -1L }
            if (path == null || !PATH_RE.matches(path) || path.contains("..") || type == null || type.contains('\r') || type.contains('\n')
                || size < 0 || at + size > buf.size) throw IOException("static bundle: bad entry")
            val body = buf.copyOfRange(at, at + size.toInt())
            at += size.toInt()
            md.update("$path\n$type\n$size\n".toByteArray(Charsets.UTF_8))
            md.update(body)
            files[path] = StaticFile(type, body)
        }
        if (at != buf.size) throw IOException("static bundle: trailing bytes")
        if (hex(md.digest()) != key) throw IOException("static bundle: key mismatch")
        return StaticBundle(key, files)
    }

    /** Raw deflate (RFC 1951), at most [max] bytes out. */
    fun inflateRaw(data: ByteArray, max: Int = MAX_BYTES): ByteArray {
        val inf = Inflater(true)
        try {
            // nowrap needs one extra dummy input byte (java.util.zip.Inflater)
            inf.setInput(data.copyOf(data.size + 1))
            val out = ByteArrayOutputStream(data.size * 4)
            val chunk = ByteArray(64 * 1024)
            while (!inf.finished()) {
                val n = inf.inflate(chunk)
                if (n == 0 && (inf.needsInput() || inf.needsDictionary())) throw IOException("static bundle: truncated deflate")
                out.write(chunk, 0, n)
                if (out.size() > max) throw IOException("static bundle: too large")
            }
            return out.toByteArray()
        } finally {
            inf.end()
        }
    }
}

class StaticCache(val file: File, private val log: (String) -> Unit = {}) {
    @Volatile var bundle: StaticBundle? = null; private set
    private var loaded = false

    /** Read the saved bundle once. Missing or broken: keep nothing. */
    @Synchronized fun load() {
        if (loaded) return
        loaded = true
        if (!file.exists()) return
        bundle = try { StaticBundleCodec.decode(file.readBytes()) } catch (e: Exception) {
            log("static cache: not using the saved bundle (${e.message})"); null
        }
    }

    /** Ask the host (blocking) and return the bundle that may be served, or null. [fetch] runs one GET over the channel. */
    fun check(fetch: (String) -> StaticFetch): StaticBundle? {
        load()
        val held = bundle
        val have = held?.key ?: ""
        val r = try { fetch("${StaticBundleCodec.PATH}?have=$have&enc=deflate-raw") } catch (e: Exception) {
            log("static cache: cannot check (${e.message})"); return null
        }
        if (r.status == 304 && held != null && r.headers[StaticBundleCodec.KEY_HEADER] == have) return held
        if (r.status != 200) return null   // an old host (404) and the like
        return try {
            val raw = when (val enc = r.headers[StaticBundleCodec.ENCODING_HEADER] ?: "identity") {
                "identity" -> r.body
                "deflate-raw" -> StaticBundleCodec.inflateRaw(r.body)
                else -> throw IOException("unknown encoding $enc")
            }
            val b = StaticBundleCodec.decode(raw)
            r.headers[StaticBundleCodec.KEY_HEADER]?.let { if (it != b.key) throw IOException("key header mismatch") }
            bundle = b
            try { save(raw) } catch (e: Exception) { log("static cache: cannot save (${e.message})") }
            b
        } catch (e: Exception) {
            log("static cache: not using the bundle (${e.message})"); null
        }
    }

    private fun save(raw: ByteArray) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.${Thread.currentThread().id}.tmp")
        tmp.writeBytes(raw)
        if (!tmp.renameTo(file)) { file.delete(); if (!tmp.renameTo(file)) { tmp.delete(); throw IOException("cannot write ${file.name}") } }
    }
}
