package com.procway.pleiad.remote

// Notifications while away (docs/remote.md §11-5, ADR 0086): the data shapes. The host encrypts a small, fixed-size
// notice per device (core/notify/crypto.mjs); the device decrypts it here, decides what to show (NotifyPlanner) and the
// app turns that into Android notifications in the app's language. Pure JVM: nothing here touches Android.

import org.json.JSONObject

/** The device's own notification settings (per device; the host also keeps a copy so it can filter before sending). */
data class NotifySettings(
    val enabled: Boolean = false,
    val reply: Boolean = true,
    val failed: Boolean = true,
    val done: Boolean = true,
    /** Show the conversation title on the lock screen (default off: a generic sentence is shown instead). */
    val lockNames: Boolean = false,
    /** Do not notify about a conversation that is open on the PC (the host filters; this flag tells it to). */
    val skipPc: Boolean = true,
) {
    /** The shape the host's `notifyRegister` takes (core/notify/policy.mjs normalizeDeviceSettings). */
    fun toJson(): JSONObject = JSONObject()
        .put("enabled", enabled).put("reply", reply).put("failed", failed).put("done", done)
        .put("lockNames", lockNames).put("skipPc", skipPc)

    companion object {
        fun fromJson(o: JSONObject?): NotifySettings {
            if (o == null) return NotifySettings()
            val d = NotifySettings()
            return NotifySettings(
                enabled = o.optBoolean("enabled", d.enabled), reply = o.optBoolean("reply", d.reply),
                failed = o.optBoolean("failed", d.failed), done = o.optBoolean("done", d.done),
                lockNames = o.optBoolean("lockNames", d.lockNames), skipPc = o.optBoolean("skipPc", d.skipPc),
            )
        }
    }
}

object NoticeKind {
    const val APPROVAL = "approval"
    const val QUESTION = "question"
    const val FAILED = "failed"
    const val SCHEDULE_MISSED = "scheduleMissed"
    const val DONE = "done"
    const val CANCEL = "cancel"
}

/** One decrypted notice. Titles are conversation names only (never message text). */
data class PushNotice(
    val seq: Long,
    val at: Long,
    val kind: String,
    val hostId: String,
    val host: String,
    val session: String,
    val title: String,
    /** The approval / question id (approval, question, and cancel of an approval). */
    val id: String?,
    /** For [NoticeKind.CANCEL]: "approval" (decided somewhere) or "seen" (a completion / failure was looked at). */
    val cancel: String?,
) {
    companion object {
        fun fromJson(o: JSONObject): PushNotice? {
            if (o.optInt("v") != 1) return null
            val kind = o.optString("kind")
            if (kind !in setOf(NoticeKind.APPROVAL, NoticeKind.QUESTION, NoticeKind.FAILED, NoticeKind.SCHEDULE_MISSED, NoticeKind.DONE, NoticeKind.CANCEL)) return null
            val seq = o.optLong("seq", 0)
            if (seq <= 0) return null
            return PushNotice(
                seq, o.optLong("at", 0), kind, o.optString("hostId"), o.optString("host"), o.optString("session"),
                o.optString("title"), o.optString("id").takeIf { it.isNotEmpty() }, o.optString("cancel").takeIf { it.isNotEmpty() },
            )
        }
    }
}

/** What the app should do to the notification shade. The app keys notifications by [key] (a stable id per key). */
sealed interface NotifyAction {
    val key: String

    /**
     * One conversation's notification (one per conversation: a newer one overwrites). [attention] = needs a reply or
     * failed (high-priority channel), otherwise the completion channel. [silent]: re-post without alerting again
     * (an unbundled completion coming back after its bundle shrank).
     */
    data class Post(
        override val key: String,
        val kind: String,
        val hostId: String,
        val host: String,
        val session: String,
        val title: String,
        val at: Long,
        val attention: Boolean,
        val silent: Boolean = false,
        /** Number of approvals / questions pending in this conversation. */
        val pending: Int = 1,
    ) : NotifyAction

    /** "N conversations finished" for one host: completions are bundled from the second one. */
    data class Bundle(
        override val key: String,
        val hostId: String,
        val host: String,
        val count: Int,
        /** Newest first. */
        val titles: List<String>,
        /** Opened when the bundle is tapped: the newest finished conversation. */
        val session: String,
        val at: Long,
        val silent: Boolean = false,
    ) : NotifyAction

    data class Cancel(override val key: String) : NotifyAction
}
