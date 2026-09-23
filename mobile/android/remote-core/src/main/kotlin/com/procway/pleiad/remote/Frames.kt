package com.procway.pleiad.remote

// Kotlin port of core/remote/frames.mjs (docs/remote.md §4.1).
//   type (u8) | stream (u32, BE) | payload
// One frame = one Noise message = one binary WebSocket message to the relay.

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import org.json.JSONObject

object T {
    const val HELLO = 0x01
    const val PING = 0x02
    const val PONG = 0x03
    const val GOAWAY = 0x04
    const val HTTP_REQ = 0x10
    const val HTTP_RES = 0x11
    const val DATA = 0x12
    const val END = 0x13
    const val RESET = 0x14
    const val WS_OPEN = 0x20
    const val WS_ACCEPT = 0x21
    const val WS_REJECT = 0x22
    const val WS_MSG = 0x23
    const val WS_CLOSE = 0x24
    const val WINDOW = 0x30

    val NAMES = mapOf(
        HELLO to "HELLO", PING to "PING", PONG to "PONG", GOAWAY to "GOAWAY",
        HTTP_REQ to "HTTP_REQ", HTTP_RES to "HTTP_RES", DATA to "DATA", END to "END", RESET to "RESET",
        WS_OPEN to "WS_OPEN", WS_ACCEPT to "WS_ACCEPT", WS_REJECT to "WS_REJECT", WS_MSG to "WS_MSG", WS_CLOSE to "WS_CLOSE",
        WINDOW to "WINDOW",
    )
    internal val CHANNEL_ONLY = setOf(HELLO, PING, PONG, GOAWAY)
}

object ResetCode {
    const val CANCEL = 0
    const val PROTOCOL = 1
    const val REFUSED = 2
    const val FORBIDDEN = 3
    const val INTERNAL = 4
    const val FLOW_CONTROL = 5
    const val CHANNEL_CLOSED = 6
    const val TOO_LARGE = 7
}

class FrameError(msg: String, val tooLarge: Boolean = false) : Exception(msg)

class Frame(val type: Int, val stream: Long, val payload: ByteArray)

object Frames {
    const val HEADER_BYTES = 5
    const val MAX_FRAME = NoiseConst.MAX_PLAINTEXT
    const val MAX_PAYLOAD = MAX_FRAME - HEADER_BYTES
    const val CHUNK = 60 * 1024
    const val PROTO = 1
    const val WS_TEXT = 0x01
    const val WS_FIN = 0x02

    fun encode(type: Int, stream: Long, payload: ByteArray?): ByteArray {
        if (type !in T.NAMES) throw FrameError("unknown type: $type")
        if (stream < 0 || stream > 0xffffffffL) throw FrameError("stream out of range: $stream")
        val body = payload ?: ByteArray(0)
        if (body.size > MAX_PAYLOAD) throw FrameError("payload too large (${body.size} > $MAX_PAYLOAD)")
        val out = ByteBuffer.allocate(HEADER_BYTES + body.size)
        out.put(type.toByte())
        out.putInt(stream.toInt())
        out.put(body)
        return out.array()
    }

    fun decode(buf: ByteArray): Frame {
        if (buf.size < HEADER_BYTES) throw FrameError("frame too short")
        if (buf.size > MAX_FRAME) throw FrameError("frame too large")
        val type = buf[0].toInt() and 0xff
        val stream = ByteBuffer.wrap(buf, 1, 4).int.toLong() and 0xffffffffL
        val name = T.NAMES[type] ?: throw FrameError("unknown type: 0x${type.toString(16)}")
        if (type in T.CHANNEL_ONLY && stream != 0L) throw FrameError("$name is only allowed on stream 0")
        if (type !in T.CHANNEL_ONLY && type != T.WINDOW && stream == 0L) throw FrameError("$name is not allowed on stream 0")
        return Frame(type, stream, buf.copyOfRange(HEADER_BYTES, buf.size))
    }

    fun jsonEncode(v: JSONObject): ByteArray = v.toString().toByteArray(Charsets.UTF_8)

    fun jsonDecode(buf: ByteArray): JSONObject = try {
        JSONObject(String(buf, Charsets.UTF_8))
    } catch (e: Exception) {
        throw FrameError("invalid JSON")
    }

    fun u16(n: Int): ByteArray = byteArrayOf((n ushr 8).toByte(), n.toByte())
    fun readU16(b: ByteArray): Int {
        if (b.size != 2) throw FrameError("bad u16 length")
        return ((b[0].toInt() and 0xff) shl 8) or (b[1].toInt() and 0xff)
    }
    fun u32(n: Long): ByteArray = ByteBuffer.allocate(4).putInt(n.toInt()).array()
    fun readU32(b: ByteArray): Long {
        if (b.size != 4) throw FrameError("bad u32 length")
        return ByteBuffer.wrap(b).int.toLong() and 0xffffffffL
    }

    fun encodeWsClose(code: Int = 1000, reason: String = ""): ByteArray {
        var r = reason.toByteArray(Charsets.UTF_8)
        if (r.size > 123) r = r.copyOf(123)
        return u16(code) + r
    }

    fun decodeWsClose(b: ByteArray): Pair<Int, String> {
        if (b.size < 2) throw FrameError("WS_CLOSE too short")
        return readU16(b.copyOf(2)) to String(b, 2, b.size - 2, Charsets.UTF_8)
    }

    fun encodeWsFragment(chunk: ByteArray, text: Boolean, fin: Boolean): ByteArray =
        byteArrayOf(((if (text) WS_TEXT else 0) or (if (fin) WS_FIN else 0)).toByte()) + chunk

    class WsFragment(val text: Boolean, val fin: Boolean, val data: ByteArray)

    fun decodeWsFragment(b: ByteArray): WsFragment {
        if (b.isEmpty()) throw FrameError("WS_MSG too short")
        val flags = b[0].toInt() and 0xff
        if (flags and (WS_TEXT or WS_FIN).inv() != 0) throw FrameError("unknown WS_MSG flag bits")
        return WsFragment(flags and WS_TEXT != 0, flags and WS_FIN != 0, b.copyOfRange(1, b.size))
    }
}

/** Reassembles WS_MSG fragments. Exceeding maxBytes throws FrameError(tooLarge = true) (RESET TOO_LARGE). */
class WsAssembler(private val maxBytes: Long = 64L * 1024 * 1024) {
    private var parts = ByteArrayOutputStream()
    private var text: Boolean? = null

    class Message(val data: ByteArray, val text: Boolean)

    fun push(payload: ByteArray): Message? {
        val f = Frames.decodeWsFragment(payload)
        val t = text
        if (t == null) text = f.text
        else if (t != f.text) throw FrameError("WS_MSG switched between text and binary mid-message")
        if (parts.size().toLong() + f.data.size > maxBytes) throw FrameError("WebSocket message exceeds the limit", tooLarge = true)
        parts.write(f.data)
        if (!f.fin) return null
        val msg = Message(parts.toByteArray(), text!!)
        parts = ByteArrayOutputStream()
        text = null
        return msg
    }
}
