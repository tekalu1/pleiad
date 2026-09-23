package com.procway.pleiad.remote

import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

/**
 * X25519 (RFC 7748) with the platform's JCA "XDH" only (JVM 11+, Android API 33+ — the reason minSdk is 33;
 * developer.android.com lists KeyAgreement / KeyFactory "XDH" as 33+). No crypto of our own.
 * Keys are raw 32-byte arrays, the same shape as core/remote/noise.mjs; they are wrapped with the same fixed
 * PKCS#8 / SPKI DER prefixes. Checked against RFC 7748 §5.2/§6.1 and tests/remote/vectors.json.
 */
object X25519 {
    private val PKCS8 = hex("302e020100300506032b656e04220420")
    private val SPKI = hex("302a300506032b656e032100")
    private val BASE = ByteArray(32).also { it[0] = 9 }

    fun publicKey(privateKey: ByteArray): ByteArray = dh(privateKey, BASE)

    /** DH(priv, pub). An all-zero result (small-order peer key) is rejected like noise.mjs. */
    fun dh(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        require(privateKey.size == 32) { "private key must be 32 bytes" }
        require(publicKey.size == 32) { "public key must be 32 bytes" }
        val out = jcaDh(privateKey, publicKey)
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
