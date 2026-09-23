package com.procway.pleiad.remote

// Minimal RFC 6455 server-side framing for the loopback proxy (the WebView is the only client).

import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64

internal object Ws {
    const val OP_CONT = 0x0
    const val OP_TEXT = 0x1
    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA

    fun acceptKey(key: String): String {
        val sha1 = MessageDigest.getInstance("SHA-1").digest((key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(sha1)
    }

    /** Close codes that may be sent in a close frame (the same rule as sendableCode in device-proxy.mjs). */
    fun sendableCode(code: Int): Int =
        if (code == 1000 || code in 1001..1003 || code in 1007..1014 || code in 3000..4999) code else 1000

    class RawFrame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    class ProtocolError(val closeCode: Int, msg: String) : Exception(msg)

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val b = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(b, off, n - off)
            if (r < 0) throw EOFException()
            off += r
        }
        return b
    }

    /** Read one client frame (must be masked). maxPayload bounds a single frame. */
    fun readFrame(input: InputStream, maxPayload: Long): RawFrame {
        val h = readFully(input, 2)
        val b0 = h[0].toInt() and 0xff
        val b1 = h[1].toInt() and 0xff
        if (b0 and 0x70 != 0) throw ProtocolError(1002, "RSV bits set")
        val fin = b0 and 0x80 != 0
        val opcode = b0 and 0x0f
        val masked = b1 and 0x80 != 0
        if (!masked) throw ProtocolError(1002, "client frames must be masked")
        var len = (b1 and 0x7f).toLong()
        if (len == 126L) {
            val e = readFully(input, 2)
            len = (((e[0].toInt() and 0xff) shl 8) or (e[1].toInt() and 0xff)).toLong()
        } else if (len == 127L) {
            val e = readFully(input, 8)
            len = 0
            for (x in e) len = (len shl 8) or (x.toLong() and 0xff)
            if (len < 0) throw ProtocolError(1009, "frame too large")
        }
        if (opcode >= 0x8 && (len > 125 || !fin)) throw ProtocolError(1002, "bad control frame")
        if (len > maxPayload) throw ProtocolError(1009, "frame too large")
        val mask = readFully(input, 4)
        val payload = readFully(input, len.toInt())
        for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        return RawFrame(fin, opcode, payload)
    }

    /** Write one unmasked server frame. */
    fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray, fin: Boolean = true) {
        val head = java.io.ByteArrayOutputStream(10)
        head.write((if (fin) 0x80 else 0) or opcode)
        val n = payload.size
        when {
            n < 126 -> head.write(n)
            n <= 0xffff -> { head.write(126); head.write(n ushr 8); head.write(n and 0xff) }
            else -> { head.write(127); for (i in 7 downTo 0) head.write(((n.toLong() ushr (8 * i)) and 0xff).toInt()) }
        }
        out.write(head.toByteArray())
        out.write(payload)
    }

    fun closePayload(code: Int, reason: String): ByteArray {
        var r = reason.toByteArray(Charsets.UTF_8)
        if (r.size > 123) r = r.copyOf(123)
        return byteArrayOf((code ushr 8).toByte(), code.toByte()) + r
    }
}
