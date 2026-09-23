package com.procway.pleiad.remote

// Kotlin port of core/remote/noise.mjs (docs/remote.md §3). Noise_IK_25519_AESGCM_SHA256 and
// Noise_IKpsk2_25519_AESGCM_SHA256, written as the spec's CipherState / SymmetricState / HandshakeState.
// AESGCM nonce = 4 zero bytes + 64-bit BIG-endian counter (spec §12.4; ChaChaPoly would be little-endian).
// Checked against the cacophony vectors and the Pleiad examples in tests/remote/vectors.json (NoiseVectorsTest).

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object NoiseConst {
    const val DHLEN = 32
    const val HASHLEN = 32
    const val TAGLEN = 16
    const val MAX_MESSAGE = 65535
    const val MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN
    /** Per-direction message limit (docs/remote.md §3.2). Reached = exception; the caller reconnects. */
    const val MAX_NONCE = 1L shl 32
    const val PROTOCOL_IK = "Noise_IK_25519_AESGCM_SHA256"
    const val PROTOCOL_IKPSK2 = "Noise_IKpsk2_25519_AESGCM_SHA256"
    const val PROLOGUE_PREFIX = "pleiad-remote/1"
}

private val EMPTY = ByteArray(0)
internal val secureRandom = SecureRandom()

fun hex(s: String): ByteArray {
    require(s.length % 2 == 0) { "odd hex length" }
    return ByteArray(s.length / 2) { i -> s.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { secureRandom.nextBytes(it) }

fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    for (p in parts) md.update(p)
    return md.digest()
}

internal fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    // HMAC accepts empty keys by definition; SecretKeySpec does not, so an empty key is padded to one zero byte
    // (HMAC pads keys with zeros to the block size, so the result is identical).
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
    for (p in parts) mac.update(p)
    return mac.doFinal()
}

/** Noise HKDF (spec §4.3). n = 2 or 3. */
internal fun noiseHkdf(chainingKey: ByteArray, ikm: ByteArray, n: Int): List<ByteArray> {
    val temp = hmac(chainingKey, ikm)
    val o1 = hmac(temp, byteArrayOf(1))
    val o2 = hmac(temp, o1, byteArrayOf(2))
    return if (n == 2) listOf(o1, o2) else listOf(o1, o2, hmac(temp, o2, byteArrayOf(3)))
}

class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray) {
    companion object {
        fun generate(): KeyPair = fromPrivate(randomBytes(32))
        fun fromPrivate(priv: ByteArray): KeyPair {
            require(priv.size == 32) { "private key must be 32 bytes" }
            return KeyPair(X25519.publicKey(priv), priv.copyOf())
        }
    }
}

class NonceExhausted : IllegalStateException("nonce exhausted (reconnect)")
class DecryptError(msg: String) : Exception(msg)

class CipherState(private val k: ByteArray? = null) {
    var n: Long = 0
        private set

    fun hasKey() = k != null

    private fun nonce(n: Long): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(n).array()

    fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        if (k == null) return plaintext.copyOf()
        if (n >= NoiseConst.MAX_NONCE) throw NonceExhausted()
        require(plaintext.size <= NoiseConst.MAX_PLAINTEXT) { "plaintext is limited to ${NoiseConst.MAX_PLAINTEXT} bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(NoiseConst.TAGLEN * 8, nonce(n)))
        c.updateAAD(ad)
        val out = c.doFinal(plaintext)
        n++
        return out
    }

    /** A failure does not advance n (spec §5.1); the caller drops the connection anyway. */
    fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        if (k == null) return ciphertext.copyOf()
        if (n >= NoiseConst.MAX_NONCE) throw NonceExhausted()
        if (ciphertext.size < NoiseConst.TAGLEN) throw DecryptError("ciphertext too short")
        val out = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(NoiseConst.TAGLEN * 8, nonce(n)))
            c.updateAAD(ad)
            c.doFinal(ciphertext)
        } catch (e: AEADBadTagException) {
            throw DecryptError("decryption failed (tampered, wrong key or out of order)")
        }
        n++
        return out
    }
}

private class SymmetricState(protocolName: String) {
    var h: ByteArray
    var ck: ByteArray
    var cs = CipherState()

    init {
        val name = protocolName.toByteArray(Charsets.US_ASCII)
        h = if (name.size <= NoiseConst.HASHLEN) name.copyOf(NoiseConst.HASHLEN) else sha256(name)
        ck = h.copyOf()
    }

    fun mixKey(ikm: ByteArray) {
        val (ck2, k) = noiseHkdf(ck, ikm, 2)
        ck = ck2
        cs = CipherState(k)
    }

    fun mixHash(data: ByteArray) { h = sha256(h, data) }

    fun mixKeyAndHash(ikm: ByteArray) {
        val (ck2, th, k) = noiseHkdf(ck, ikm, 3)
        ck = ck2
        mixHash(th)
        cs = CipherState(k)
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray = cs.encryptWithAd(h, plaintext).also { mixHash(it) }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray = cs.decryptWithAd(h, ciphertext).also { mixHash(ciphertext) }

    fun split(): Pair<CipherState, CipherState> {
        val (k1, k2) = noiseHkdf(ck, EMPTY, 2)
        return CipherState(k1) to CipherState(k2)
    }
}

enum class Pattern(val protocolName: String, val psk: Boolean, val messages: List<List<String>>) {
    IK(NoiseConst.PROTOCOL_IK, false, listOf(listOf("e", "es", "s", "ss"), listOf("e", "ee", "se"))),
    IKpsk2(NoiseConst.PROTOCOL_IKPSK2, true, listOf(listOf("e", "es", "s", "ss"), listOf("e", "ee", "se", "psk"))),
}

class HandshakeError(msg: String) : Exception(msg)

/**
 * IK / IKpsk2 handshake. The device is always the initiator; the responder side exists for the vectors and tests.
 * `ephemeral` is for the vectors only (normally a fresh key per handshake).
 */
class Handshake(
    val pattern: Pattern,
    val initiator: Boolean,
    prologue: ByteArray,
    staticKey: KeyPair,
    remoteStatic: ByteArray? = null,
    psk: ByteArray? = null,
    ephemeral: ByteArray? = null,
) {
    private val s = staticKey
    var rs: ByteArray? = remoteStatic?.copyOf()
        private set
    private val psk: ByteArray? = psk
    private val fixedE: KeyPair? = ephemeral?.let { KeyPair.fromPrivate(it) }
    private var e: KeyPair? = null
    private var re: ByteArray? = null
    private var index = 0
    private val ss = SymmetricState(pattern.protocolName)

    init {
        if (initiator) require(remoteStatic != null) { "the IK initiator requires the remote (host) static public key" }
        require(pattern.psk == (psk != null)) { "psk mismatch for $pattern" }
        remoteStatic?.let { require(it.size == 32) { "remote static public key must be 32 bytes" } }
        psk?.let { require(it.size == 32) { "psk must be 32 bytes" } }
        ss.mixHash(prologue)
        ss.mixHash(if (initiator) rs!! else s.publicKey)
    }

    val isComplete get() = index >= pattern.messages.size
    val isMyTurn get() = !isComplete && ((index % 2 == 0) == initiator)
    val handshakeHash: ByteArray get() = ss.h.copyOf()

    private fun dhToken(token: String): ByteArray = when (token) {
        "ee" -> X25519.dh(e!!.privateKey, re!!)
        "ss" -> X25519.dh(s.privateKey, rs!!)
        "es" -> if (initiator) X25519.dh(e!!.privateKey, rs!!) else X25519.dh(s.privateKey, re!!)
        "se" -> if (initiator) X25519.dh(s.privateKey, re!!) else X25519.dh(e!!.privateKey, rs!!)
        else -> throw IllegalStateException("unknown token $token")
    }

    fun writeMessage(payload: ByteArray = EMPTY): ByteArray {
        check(isMyTurn) { "not our turn to write" }
        val out = java.io.ByteArrayOutputStream()
        for (token in pattern.messages[index]) {
            when (token) {
                "e" -> {
                    val eph = fixedE ?: KeyPair.generate()
                    e = eph
                    out.write(eph.publicKey)
                    ss.mixHash(eph.publicKey)
                    if (pattern.psk) ss.mixKey(eph.publicKey)
                }
                "s" -> out.write(ss.encryptAndHash(s.publicKey))
                "psk" -> ss.mixKeyAndHash(psk!!)
                else -> ss.mixKey(dhToken(token))
            }
        }
        out.write(ss.encryptAndHash(payload))
        index++
        val msg = out.toByteArray()
        if (msg.size > NoiseConst.MAX_MESSAGE) throw HandshakeError("handshake message too large")
        return msg
    }

    fun readMessage(message: ByteArray): ByteArray {
        check(!isComplete && !isMyTurn) { "not the peer's turn to write" }
        if (message.size > NoiseConst.MAX_MESSAGE) throw HandshakeError("handshake message too large")
        var off = 0
        fun take(n: Int): ByteArray {
            if (message.size - off < n) throw HandshakeError("handshake message too short")
            return message.copyOfRange(off, off + n).also { off += n }
        }
        for (token in pattern.messages[index]) {
            when (token) {
                "e" -> {
                    val r = take(NoiseConst.DHLEN)
                    re = r
                    ss.mixHash(r)
                    if (pattern.psk) ss.mixKey(r)
                }
                "s" -> {
                    val len = if (ss.cs.hasKey()) NoiseConst.DHLEN + NoiseConst.TAGLEN else NoiseConst.DHLEN
                    rs = ss.decryptAndHash(take(len))
                }
                "psk" -> ss.mixKeyAndHash(psk!!)
                else -> ss.mixKey(dhToken(token))
            }
        }
        val payload = ss.decryptAndHash(message.copyOfRange(off, message.size))
        index++
        return payload
    }

    fun split(): Transport {
        check(isComplete) { "handshake not complete" }
        val (c1, c2) = ss.split()
        return if (initiator) Transport(c1, c2, handshakeHash) else Transport(c2, c1, handshakeHash)
    }
}

/** Established transport. One nonce per message (reordering, loss or replay = decrypt failure). */
class Transport(private val sendCs: CipherState, private val recvCs: CipherState, val handshakeHash: ByteArray) {
    @Synchronized fun encrypt(plaintext: ByteArray): ByteArray = sendCs.encryptWithAd(EMPTY, plaintext)
    @Synchronized fun decrypt(ciphertext: ByteArray): ByteArray = recvCs.decryptWithAd(EMPTY, ciphertext)
}

// ── Pleiad conventions (docs/remote.md §3) ──

object Pleiad {
    fun prologueFor(hostId: String): ByteArray =
        NoiseConst.PROLOGUE_PREFIX.toByteArray(Charsets.US_ASCII) + hostId.toByteArray(Charsets.UTF_8)

    private const val B32 = "abcdefghijklmnopqrstuvwxyz234567"

    /** RFC 4648 base32, lower case, no padding. */
    fun base32(buf: ByteArray): String {
        var bits = 0
        var value = 0
        val out = StringBuilder()
        for (b in buf) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(B32[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) out.append(B32[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    fun hostIdFor(hostPublicKey: ByteArray): String {
        require(hostPublicKey.size == 32) { "host public key must be 32 bytes" }
        return base32(sha256(hostPublicKey)).substring(0, 26)
    }

    /** RFC 5869 HKDF-SHA256 with empty salt, info = label (UTF-8), 32 bytes. */
    fun hkdfLabel(secret: ByteArray, label: String): ByteArray {
        val prk = hmac(ByteArray(32), secret)            // extract: salt = HashLen zeros (RFC 5869 when salt is empty)
        return hmac(prk, label.toByteArray(Charsets.UTF_8), byteArrayOf(1))   // expand: one block = 32 bytes
    }

    class PairingKeys(val psk: ByteArray, val ticket: ByteArray, val ticketHash: ByteArray)

    fun derivePairing(secret: ByteArray): PairingKeys {
        require(secret.size == 32) { "pairing secret must be 32 bytes" }
        val psk = hkdfLabel(secret, "pleiad pair psk")
        val ticket = hkdfLabel(secret, "pleiad pair ticket")
        return PairingKeys(psk, ticket, sha256(ticket))
    }

    /** 6-digit code: HMAC-SHA256(key = h, "pleiad pair code"), first 4 bytes BE mod 10^6, zero-padded. */
    fun confirmationCode(handshakeHash: ByteArray): String {
        require(handshakeHash.size == 32) { "handshake hash must be 32 bytes" }
        val m = hmac(handshakeHash, "pleiad pair code".toByteArray(Charsets.UTF_8))
        val v = ByteBuffer.wrap(m, 0, 4).int.toLong() and 0xffffffffL
        return (v % 1_000_000).toString().padStart(6, '0')
    }

    fun formatConfirmationCode(code: String) = "${code.substring(0, 3)} ${code.substring(3)}"
}
