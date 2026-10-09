package dev.pleiad.app.remote

// Decrypts the host's notice (core/notify/crypto.mjs), docs/remote.md §11-5.
//
//   blob = base64url( nonce(12) || AES-256-GCM(plain 512 bytes) || tag(16) )
//   plain = u16(BE: JSON length) || JSON (UTF-8) || zero padding
//   AAD = "pleiad-notify/1\n" + hostId + "\n" + deviceId
//
// The key is the device's own 32-byte notification key (made here, registered with the host over the E2E channel).

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

object NotifyCrypto {
    const val PLAIN_BYTES = 512
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16
    const val BLOB_BYTES = NONCE_BYTES + PLAIN_BYTES + TAG_BYTES
    const val KEY_BYTES = 32

    fun generateKey(): ByteArray = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }

    fun encodeKey(key: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(key)

    private fun aad(hostId: String, deviceId: String) = "pleiad-notify/1\n$hostId\n$deviceId".toByteArray(Charsets.UTF_8)

    /** The decrypted notice, or null when it does not open (wrong key / host / device, tampered, malformed). */
    fun open(key: ByteArray, hostId: String, deviceId: String, blob: String): PushNotice? = try {
        val raw = Base64.getUrlDecoder().decode(blob.trimEnd('='))
        if (raw.size != BLOB_BYTES || key.size != KEY_BYTES) null else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, raw, 0, NONCE_BYTES))
            cipher.updateAAD(aad(hostId, deviceId))
            // javax.crypto wants ciphertext || tag, which is exactly what follows the nonce
            val plain = cipher.doFinal(raw, NONCE_BYTES, raw.size - NONCE_BYTES)
            val len = ((plain[0].toInt() and 0xff) shl 8) or (plain[1].toInt() and 0xff)
            if (len < 2 || len > PLAIN_BYTES - 2) null
            else PushNotice.fromJson(JSONObject(String(plain, 2, len, Charsets.UTF_8)))
        }
    } catch (_: Exception) { null }

    /** For tests (the host seals; a device never does). */
    internal fun seal(key: ByteArray, hostId: String, deviceId: String, json: JSONObject, nonce: ByteArray = ByteArray(NONCE_BYTES).also { SecureRandom().nextBytes(it) }): String {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        require(body.size <= PLAIN_BYTES - 2)
        val plain = ByteArray(PLAIN_BYTES)
        plain[0] = (body.size shr 8).toByte(); plain[1] = body.size.toByte()
        System.arraycopy(body, 0, plain, 2, body.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.updateAAD(aad(hostId, deviceId))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(nonce + cipher.doFinal(plain))
    }
}
