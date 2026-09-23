package com.procway.pleiad.remote

import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

/**
 * X25519 (RFC 7748). Keys are raw 32-byte arrays, the same shape as core/remote/noise.mjs.
 *
 * The platform's JCA "XDH" is used when present (JVM 11+, Android API 33+). Android 12 / 12L (API 31-32) have no XDH
 * in the platform provider (developer.android.com: KeyAgreement XDH "33+"), so there we fall back to [X25519Portable],
 * a direct port of TweetNaCl's crypto_scalarmult (public domain, constant-time field arithmetic). Both paths are checked
 * against RFC 7748 §5.2/§6.1 and the Noise vectors in tests/remote/vectors.json (X25519Test, NoiseVectorsTest).
 */
object X25519 {
    private val PKCS8 = hex("302e020100300506032b656e04220420")
    private val SPKI = hex("302a300506032b656e032100")
    private val BASE = ByteArray(32).also { it[0] = 9 }

    /** "jca" or "portable". Tests may force one. */
    @Volatile
    var forced: String? = null

    val jcaAvailable: Boolean by lazy {
        try {
            val a = ByteArray(32) { (it + 1).toByte() }
            jcaDh(a, BASE).size == 32
        } catch (_: Throwable) {
            false
        }
    }

    val implementation: String get() = forced ?: if (jcaAvailable) "jca" else "portable"

    fun publicKey(privateKey: ByteArray): ByteArray = dh(privateKey, BASE)

    /** DH(priv, pub). An all-zero result (small-order peer key) is rejected like noise.mjs. */
    fun dh(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        require(privateKey.size == 32) { "private key must be 32 bytes" }
        require(publicKey.size == 32) { "public key must be 32 bytes" }
        val out = if (implementation == "jca") jcaDh(privateKey, publicKey) else X25519Portable.scalarMult(privateKey, publicKey)
        var acc = 0
        for (b in out) acc = acc or b.toInt()
        if (acc == 0) throw IllegalArgumentException("X25519 result is zero (invalid peer key)")
        return out
    }

    private fun jcaDh(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val kf = KeyFactory.getInstance("XDH")
        val priv = kf.generatePrivate(PKCS8EncodedKeySpec(PKCS8 + privateKey))
        val pub = kf.generatePublic(X509EncodedKeySpec(SPKI + publicKey))
        val ka = KeyAgreement.getInstance("XDH")
        ka.init(priv)
        ka.doPhase(pub, true)
        return ka.generateSecret()
    }
}

/**
 * TweetNaCl crypto_scalarmult (curve25519), ported to Kotlin. Field elements are 16 limbs of 16 bits held in Longs.
 * Only used where the platform has no XDH (Android API 31-32).
 */
internal object X25519Portable {
    private val A121665 = longArrayOf(0xDB41, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    private fun car25519(o: LongArray) {
        for (i in 0 until 16) {
            o[i] += 1L shl 16
            val c = o[i] shr 16
            if (i < 15) o[i + 1] += c - 1 else o[0] += 38 * (c - 1)
            o[i] -= c shl 16
        }
    }

    private fun sel25519(p: LongArray, q: LongArray, b: Int) {
        val c = (b - 1).toLong().inv()
        for (i in 0 until 16) {
            val t = c and (p[i] xor q[i])
            p[i] = p[i] xor t
            q[i] = q[i] xor t
        }
    }

    private fun pack25519(o: ByteArray, n: LongArray) {
        val m = LongArray(16)
        val t = n.copyOf()
        car25519(t); car25519(t); car25519(t)
        for (j in 0 until 2) {
            m[0] = t[0] - 0xffed
            for (i in 1 until 15) {
                m[i] = t[i] - 0xffff - ((m[i - 1] shr 16) and 1)
                m[i - 1] = m[i - 1] and 0xffff
            }
            m[15] = t[15] - 0x7fff - ((m[14] shr 16) and 1)
            val b = ((m[15] shr 16) and 1).toInt()
            m[14] = m[14] and 0xffff
            sel25519(t, m, 1 - b)
        }
        for (i in 0 until 16) {
            o[2 * i] = (t[i] and 0xff).toByte()
            o[2 * i + 1] = (t[i] shr 8).toByte()
        }
    }

    private fun unpack25519(o: LongArray, n: ByteArray) {
        for (i in 0 until 16) o[i] = (n[2 * i].toLong() and 0xff) + ((n[2 * i + 1].toLong() and 0xff) shl 8)
        o[15] = o[15] and 0x7fff
    }

    private fun add(o: LongArray, a: LongArray, b: LongArray) { for (i in 0 until 16) o[i] = a[i] + b[i] }
    private fun sub(o: LongArray, a: LongArray, b: LongArray) { for (i in 0 until 16) o[i] = a[i] - b[i] }

    private fun mul(o: LongArray, a: LongArray, b: LongArray) {
        val t = LongArray(31)
        for (i in 0 until 16) for (j in 0 until 16) t[i + j] += a[i] * b[j]
        for (i in 0 until 15) t[i] += 38 * t[i + 16]
        for (i in 0 until 16) o[i] = t[i]
        car25519(o); car25519(o)
    }

    private fun sqr(o: LongArray, a: LongArray) = mul(o, a, a)

    private fun inv25519(o: LongArray, i: LongArray) {
        val c = i.copyOf()
        for (a in 253 downTo 0) {
            sqr(c, c)
            if (a != 2 && a != 4) mul(c, c, i)
        }
        for (k in 0 until 16) o[k] = c[k]
    }

    fun scalarMult(n: ByteArray, p: ByteArray): ByteArray {
        val z = n.copyOf(32)
        z[31] = ((z[31].toInt() and 127) or 64).toByte()
        z[0] = (z[0].toInt() and 248).toByte()
        val x = LongArray(80)
        unpack25519(x, p)
        val a = LongArray(16); val b = LongArray(16); val c = LongArray(16)
        val d = LongArray(16); val e = LongArray(16); val f = LongArray(16)
        for (i in 0 until 16) { b[i] = x[i]; d[i] = 0; a[i] = 0; c[i] = 0 }
        a[0] = 1; d[0] = 1
        for (i in 254 downTo 0) {
            val r = ((z[i ushr 3].toInt() and 0xff) ushr (i and 7)) and 1
            sel25519(a, b, r); sel25519(c, d, r)
            add(e, a, c); sub(a, a, c); add(c, b, d); sub(b, b, d)
            sqr(d, e); sqr(f, a); mul(a, c, a); mul(c, b, e)
            add(e, a, c); sub(a, a, c); sqr(b, a); sub(c, d, f)
            mul(a, c, A121665); add(a, a, d); mul(c, c, a); mul(a, d, f)
            mul(d, b, x); sqr(b, e)
            sel25519(a, b, r); sel25519(c, d, r)
        }
        val inv = LongArray(16)
        inv25519(inv, c)
        mul(a, a, inv)
        val out = ByteArray(32)
        pack25519(out, a)
        return out
    }
}
