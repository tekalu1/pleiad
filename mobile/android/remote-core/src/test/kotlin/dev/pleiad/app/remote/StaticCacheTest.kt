package dev.pleiad.app.remote

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.Deflater
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The bundle reader and the device's saved shell (StaticCache.kt). The Node host's real bundle is covered by InteropTest. */
class StaticCacheTest {
    private val dir = kotlin.io.path.createTempDirectory("pleiad-kt-static").toFile()

    @After fun tearDown() { dir.deleteRecursively() }

    private class F(val path: String, val type: String, val body: ByteArray)

    /** Same shape as encodeBundle in core/remote/static-bundle.mjs. */
    private fun encode(files: List<F>): Pair<String, ByteArray> {
        val md = MessageDigest.getInstance("SHA-256")
        for (f in files) { md.update("${f.path}\n${f.type}\n${f.body.size}\n".toByteArray()); md.update(f.body) }
        val key = md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val arr = JSONArray()
        for (f in files) arr.put(JSONObject().put("path", f.path).put("type", f.type).put("size", f.body.size))
        val head = JSONObject().put("format", 1).put("key", key).put("files", arr).toString().toByteArray()
        val out = ByteArrayOutputStream()
        out.write("PLSB".toByteArray())
        out.write(byteArrayOf((head.size ushr 24).toByte(), (head.size ushr 16).toByte(), (head.size ushr 8).toByte(), head.size.toByte()))
        out.write(head)
        for (f in files) out.write(f.body)
        return key to out.toByteArray()
    }

    private fun deflateRaw(b: ByteArray): ByteArray {
        val d = Deflater(6, true)
        d.setInput(b); d.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (!d.finished()) out.write(buf, 0, d.deflate(buf))
        d.end()
        return out.toByteArray()
    }

    private val v1 = listOf(
        F("/index.html", "text/html; charset=utf-8", "<!doctype html><html>v1</html>".toByteArray()),
        F("/client.mjs", "text/javascript; charset=utf-8", "export const v = 1;\n".repeat(500).toByteArray()),
        F("/empty.css", "text/css; charset=utf-8", ByteArray(0)),
    )

    @Test fun decodeAndVerify() {
        val (key, raw) = encode(v1)
        val b = StaticBundleCodec.decode(raw)
        assertEquals(key, b.key)
        assertEquals(3, b.files.size)
        assertEquals("text/javascript; charset=utf-8", b.files["/client.mjs"]!!.type)
        assertArrayEquals(v1[1].body, b.files["/client.mjs"]!!.body)
        assertEquals(0, b.files["/empty.css"]!!.body.size)
        assertArrayEquals(raw, StaticBundleCodec.inflateRaw(deflateRaw(raw)))

        fun rejects(name: String, buf: ByteArray) {
            try { StaticBundleCodec.decode(buf); fail("$name accepted") } catch (_: java.io.IOException) {} catch (_: org.json.JSONException) {}
        }
        rejects("a changed body byte", raw.copyOf().also { it[it.size - 3] = (it[it.size - 3] + 1).toByte() })
        rejects("a truncated bundle", raw.copyOf(raw.size - 1))
        rejects("trailing bytes", raw + byteArrayOf(0))
        rejects("bad magic", raw.copyOf().also { it[0] = 'X'.code.toByte() })
        rejects("a path with ..", encode(listOf(F("/../x.js", "text/javascript", ByteArray(1)))).second)
        rejects("a type with a newline", encode(listOf(F("/x.js", "text/javascript\r\nx-evil: 1", ByteArray(1)))).second)
        try { StaticBundleCodec.inflateRaw(deflateRaw(raw), max = 100); fail("limit not applied") } catch (_: java.io.IOException) {}
    }

    @Test fun checkSaveReuseAndRefetch() {
        val file = File(dir, "static/aaaa.bin")
        val (key1, raw1) = encode(v1)
        val asked = mutableListOf<String>()
        var hostKey = key1
        var hostRaw = raw1
        var hostStatus = 0   // 0: a current host; otherwise answer this status (an old host: 404)
        val fetch = { p: String ->
            asked.add(p)
            val have = Regex("have=([0-9a-f]*)").find(p)!!.groupValues[1]
            when {
                hostStatus != 0 -> StaticFetch(hostStatus, emptyMap(), "not found".toByteArray())
                have == hostKey -> StaticFetch(304, mapOf(StaticBundleCodec.KEY_HEADER to hostKey), ByteArray(0))
                else -> StaticFetch(200, mapOf(StaticBundleCodec.KEY_HEADER to hostKey, StaticBundleCodec.ENCODING_HEADER to "deflate-raw"), deflateRaw(hostRaw))
            }
        }

        // first run: nothing saved, the bundle comes whole and is saved as-is (uncompressed)
        val c1 = StaticCache(file)
        val b1 = c1.check(fetch)!!
        assertEquals(key1, b1.key)
        assertEquals("${StaticBundleCodec.PATH}?have=&enc=deflate-raw", asked.last())
        assertArrayEquals(raw1, file.readBytes())
        // same proxy, next page load: 304, the held bundle
        assertSame(b1, c1.check(fetch))
        assertEquals("${StaticBundleCodec.PATH}?have=$key1&enc=deflate-raw", asked.last())

        // a new proxy (the app restarted, maybe on another port) reads the saved file: 304
        val c2 = StaticCache(file)
        assertEquals(key1, c2.check(fetch)!!.key)
        assertTrue(asked.last().contains("have=$key1"))

        // the host's web/ changed: the new bundle replaces the saved one
        val v2 = v1.map { if (it.path == "/index.html") F(it.path, it.type, "<!doctype html><html>v2</html>".toByteArray()) else it }
        val (key2, raw2) = encode(v2)
        hostKey = key2; hostRaw = raw2
        val b2 = c2.check(fetch)!!
        assertEquals(key2, b2.key)
        assertEquals("<!doctype html><html>v2</html>", String(b2.files["/index.html"]!!.body))
        assertArrayEquals(raw2, file.readBytes())

        // a corrupted saved file is not used: asked with no key, fetched again
        file.writeBytes(raw2.copyOf(raw2.size - 5))
        val c3 = StaticCache(file)
        assertEquals(key2, c3.check(fetch)!!.key)
        assertTrue(asked.last().contains("have=&"))

        // a host whose key header disagrees with the body is not trusted
        hostKey = "f".repeat(64); hostRaw = raw1
        assertNull(StaticCache(File(dir, "static/bbbb.bin")).check(fetch))

        // an old host without the endpoint: null (the proxy forwards as before), nothing saved
        hostStatus = 404
        assertNull(StaticCache(File(dir, "static/cccc.bin")).check(fetch))
        assertTrue(!File(dir, "static/cccc.bin").exists())
        // a failing channel: null too
        assertNull(StaticCache(File(dir, "static/dddd.bin")).check { throw java.io.IOException("reset") })
    }
}
