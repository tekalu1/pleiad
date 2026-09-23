package com.procway.pleiad.remote

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** tests/remote/vectors.json: the same file Node (tests/unit/remote-noise.mjs, remote-frames.mjs) and Swift read. */
fun loadVectors(): JSONObject {
    val path = System.getProperty("pleiad.vectors") ?: "../../../tests/remote/vectors.json"
    return JSONObject(File(path).readText(Charsets.UTF_8))
}

class X25519Test {
    @Test fun rfc7748() {
        // RFC 7748 §5.2 first vector
        assertEquals(
            "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
            X25519.dh(
                hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
                hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
            ).toHex(),
        )
        // RFC 7748 §6.1 (Alice / Bob)
        val a = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val b = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        assertEquals("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", X25519.publicKey(a).toHex())
        assertEquals("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", X25519.publicKey(b).toHex())
        assertEquals(
            "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
            X25519.dh(a, X25519.publicKey(b)).toHex(),
        )
    }

    @Test fun rejectsZeroResult() {
        try {
            X25519.dh(randomBytes(32), ByteArray(32))
            fail("small-order point accepted")
        } catch (_: Exception) {
        }
    }
}

class NoiseVectorsTest {
    private fun runVector(v: JSONObject) {
        val pattern = when (v.getString("protocol_name")) {
            NoiseConst.PROTOCOL_IK -> Pattern.IK
            NoiseConst.PROTOCOL_IKPSK2 -> Pattern.IKpsk2
            else -> error("unexpected protocol")
        }
        val initPsk = v.optJSONArray("init_psks")?.getString(0)?.let { hex(it) }
        val respPsk = v.optJSONArray("resp_psks")?.getString(0)?.let { hex(it) }
        val init = Handshake(
            pattern, true, hex(v.getString("init_prologue")), KeyPair.fromPrivate(hex(v.getString("init_static"))),
            remoteStatic = hex(v.getString("init_remote_static")), psk = initPsk, ephemeral = hex(v.getString("init_ephemeral")),
        )
        val resp = Handshake(
            pattern, false, hex(v.getString("resp_prologue")), KeyPair.fromPrivate(hex(v.getString("resp_static"))),
            psk = respPsk, ephemeral = hex(v.getString("resp_ephemeral")),
        )
        val msgs = v.getJSONArray("messages")
        // handshake: message 0 (init -> resp), 1 (resp -> init)
        for (i in 0 until 2) {
            val m = msgs.getJSONObject(i)
            val (w, r) = if (i == 0) init to resp else resp to init
            val ct = w.writeMessage(hex(m.getString("payload")))
            assertEquals("${pattern} message $i", m.getString("ciphertext"), ct.toHex())
            assertEquals(m.getString("payload"), r.readMessage(ct).toHex())
        }
        assertEquals(v.getString("handshake_hash"), init.handshakeHash.toHex())
        assertEquals(v.getString("handshake_hash"), resp.handshakeHash.toHex())
        val ti = init.split()
        val tr = resp.split()
        for (i in 2 until msgs.length()) {
            val m = msgs.getJSONObject(i)
            val initSends = i % 2 == 0
            val ct = if (initSends) ti.encrypt(hex(m.getString("payload"))) else tr.encrypt(hex(m.getString("payload")))
            assertEquals("${pattern} transport $i", m.getString("ciphertext"), ct.toHex())
            val pt = if (initSends) tr.decrypt(ct) else ti.decrypt(ct)
            assertEquals(m.getString("payload"), pt.toHex())
        }
    }

    @Test fun cacophonyVectors() {
        val noise = loadVectors().getJSONArray("noise")
        assertEquals(2, noise.length())
        for (i in 0 until noise.length()) runVector(noise.getJSONObject(i))
    }

    @Test fun tamperedTransportFails() {
        val host = KeyPair.generate()
        val dev = KeyPair.generate()
        val i = Handshake(Pattern.IK, true, Pleiad.prologueFor("x"), dev, remoteStatic = host.publicKey)
        val r = Handshake(Pattern.IK, false, Pleiad.prologueFor("x"), host)
        r.readMessage(i.writeMessage("hi".toByteArray()))
        assertArrayEquals(dev.publicKey, r.rs)
        i.readMessage(r.writeMessage())
        val ti = i.split(); val tr = r.split()
        val ct = ti.encrypt("hello".toByteArray())
        ct[0] = (ct[0].toInt() xor 1).toByte()
        try { tr.decrypt(ct); fail("tampered accepted") } catch (_: DecryptError) {}
    }

    @Test fun pleiadDerivations() {
        val p = loadVectors().getJSONObject("pleiad")
        val pairing = p.getJSONObject("pairing")
        val keys = Pleiad.derivePairing(hex(pairing.getString("secret")))
        assertEquals(pairing.getString("psk"), keys.psk.toHex())
        assertEquals(pairing.getString("ticket"), keys.ticket.toHex())
        assertEquals(pairing.getString("ticketHash"), keys.ticketHash.toHex())
        val host = p.getJSONObject("host")
        val kp = KeyPair.fromPrivate(hex(host.getString("privateKey")))
        assertEquals(host.getString("publicKey"), kp.publicKey.toHex())
        assertEquals(host.getString("hostId"), Pleiad.hostIdFor(kp.publicKey))
        assertEquals(host.getString("prologue"), Pleiad.prologueFor(host.getString("hostId")).toHex())
        val codes = p.getJSONArray("confirmation")
        for (i in 0 until codes.length()) {
            val c = codes.getJSONObject(i)
            assertEquals(c.getString("code"), Pleiad.confirmationCode(hex(c.getString("handshakeHash"))))
        }
        assertEquals("482 193", Pleiad.formatConfirmationCode("482193"))
    }
}

class FramesVectorsTest {
    @Test fun frames() {
        val frames = loadVectors().getJSONArray("frames")
        assertTrue(frames.length() >= 17)
        for (i in 0 until frames.length()) {
            val f = frames.getJSONObject(i)
            val payload = hex(f.getString("payload"))
            val enc = Frames.encode(f.getInt("type"), f.getLong("stream"), payload)
            assertEquals(f.getString("name"), f.getString("frame"), enc.toHex())
            val dec = Frames.decode(hex(f.getString("frame")))
            assertEquals(f.getInt("type"), dec.type)
            assertEquals(f.getLong("stream"), dec.stream)
            assertArrayEquals(payload, dec.payload)
        }
    }

    @Test fun rejectsMalformed() {
        val bad = listOf(
            "0100",                  // too short
            "ff00000000",            // unknown type
            "0100000001",            // HELLO off stream 0
            "1200000000",            // DATA on stream 0
        )
        for (b in bad) try { Frames.decode(hex(b)); fail(b) } catch (_: FrameError) {}
    }

    @Test fun assembler() {
        val a = WsAssembler(maxBytes = 10)
        assertEquals(null, a.push(Frames.encodeWsFragment("abc".toByteArray(), text = true, fin = false)))
        val m = a.push(Frames.encodeWsFragment("de".toByteArray(), text = true, fin = true))!!
        assertEquals("abcde", String(m.data))
        assertTrue(m.text)
        try { a.push(Frames.encodeWsFragment(ByteArray(11), text = false, fin = true)); fail() } catch (e: FrameError) { assertTrue(e.tooLarge) }
    }
}
