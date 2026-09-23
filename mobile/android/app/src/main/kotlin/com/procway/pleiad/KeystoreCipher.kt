package com.procway.pleiad

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.procway.pleiad.remote.SecretCipher
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the device's secrets file (device static key + per-host relay tokens) with an AES-256-GCM key that lives in the
 * Android Keystore (hardware-backed where available; never leaves it). docs/remote.md §3.1 "Android は Keystore で包む".
 * Format: 0x01 | IV (12) | ciphertext+tag. Backups are disabled in the manifest: the Keystore key is not backed up, so a
 * restored file could never be opened anyway.
 */
class KeystoreCipher(private val alias: String = "pleiad-remote-secrets") : SecretCipher {
    override val encrypted = true

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val iv = c.iv
        require(iv.size == 12)
        return byteArrayOf(1) + iv + c.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > 13 && sealed[0] == 1.toByte()) { "secrets file has an unexpected format" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed.copyOfRange(1, 13)))
        return c.doFinal(sealed.copyOfRange(13, sealed.size))
    }
}
