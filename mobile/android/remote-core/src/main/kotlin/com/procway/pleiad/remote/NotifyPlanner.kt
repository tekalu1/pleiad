package com.procway.pleiad.remote

// Decides what the notification shade should look like for each notice (docs/remote.md §11-5, ADR 0086). Pure state
// machine, no Android: the app turns [NotifyAction]s into notifications in its own language.
//
// Rules:
//   - one notification per conversation (a newer notice overwrites it); approvals / questions / failures are separate
//     "needs attention" notifications, completions are plain ones
//   - completions are bundled per host from the second one: "N conversations finished" (the individual ones go away);
//     when the bundle shrinks to one, that one comes back (silently)
//   - a cancel (decided somewhere / looked at somewhere) removes the notification; a cancel for a conversation we have no
//     state for (the service restarted since) still cancels, because cancelling a notification that is not there is harmless
//   - notices are applied once, in order: a sequence number not above the last one seen for a host is a replay
//   - the settings are applied again here (the host filters first, but the settings may have changed since)

class NotifyPlanner {
    private class Slot(var kind: String, var title: String, var host: String, var at: Long, val ids: MutableSet<String> = LinkedHashSet()) {
        /** Currently shown as its own notification (a completion inside a bundle is not). */
        var shown = false
    }

    private class HostState {
        var lastSeq = 0L
        /** session -> slot, oldest first (re-inserted when overwritten). */
        val slots = LinkedHashMap<String, Slot>()
        var bundled = false
        var host = ""
    }

    private val hosts = HashMap<String, HostState>()

    companion object {
        const val MAX_SLOTS = 100
        fun slotKey(hostId: String, session: String) = "$hostId|$session"
        fun bundleKey(hostId: String) = "$hostId|bundle"
        private fun attention(kind: String) = kind != NoticeKind.DONE
    }

    @Synchronized
    fun onNotice(n: PushNotice, s: NotifySettings): List<NotifyAction> {
        val h = hosts.getOrPut(n.hostId) { HostState() }
        if (n.seq <= h.lastSeq) return emptyList()
        h.lastSeq = n.seq
        if (n.host.isNotEmpty()) h.host = n.host
        return when (n.kind) {
            NoticeKind.CANCEL -> cancel(h, n)
            NoticeKind.APPROVAL, NoticeKind.QUESTION -> if (s.enabled && s.reply) post(h, n) else emptyList()
            NoticeKind.FAILED, NoticeKind.LIMIT_READY, NoticeKind.LIMIT_GUARDED, NoticeKind.SCHEDULE_MISSED -> if (s.enabled && s.failed) post(h, n) else emptyList()
            NoticeKind.DONE -> if (s.enabled && s.done) post(h, n) else emptyList()
            else -> emptyList()
        }
    }

    /**
     * The user opened a notification (tap). [bundle] = the "N conversations finished" one: all completions of the host
     * are acknowledged. Otherwise only that conversation's own notification (Android removes it on tap by itself).
     */
    @Synchronized
    fun opened(hostId: String, session: String?, bundle: Boolean): List<NotifyAction> {
        val h = hosts[hostId] ?: return emptyList()
        val out = ArrayList<NotifyAction>()
        if (bundle) {
            h.slots.entries.removeAll { it.value.kind == NoticeKind.DONE }
            if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
            return out
        }
        val removed = if (session != null) h.slots.remove(session) else null
        if (removed?.kind == NoticeKind.DONE) out += syncDone(h, hostId, alert = false)
        return out
    }

    @Synchronized
    fun reset() { hosts.clear() }

    private fun post(h: HostState, n: PushNotice): List<NotifyAction> {
        val hostId = n.hostId
        val old = h.slots.remove(n.session)
        val slot = Slot(n.kind, n.title, h.host, n.at)
        if (attention(n.kind) && n.kind != NoticeKind.FAILED && n.kind != NoticeKind.LIMIT_READY && n.kind != NoticeKind.LIMIT_GUARDED && n.kind != NoticeKind.SCHEDULE_MISSED) {
            // approvals / questions already waiting in this conversation stay counted
            if (old != null && attention(old.kind) && old.kind != NoticeKind.FAILED && old.kind != NoticeKind.LIMIT_READY && old.kind != NoticeKind.LIMIT_GUARDED && old.kind != NoticeKind.SCHEDULE_MISSED) slot.ids += old.ids
            slot.ids += n.id ?: "?"
        }
        h.slots[n.session] = slot
        while (h.slots.size > MAX_SLOTS) h.slots.remove(h.slots.keys.first())
        val out = ArrayList<NotifyAction>()
        if (attention(n.kind)) {
            slot.shown = true
            out += NotifyAction.Post(
                slotKey(hostId, n.session), n.kind, hostId, h.host, n.session, n.title, n.at, attention = true,
                pending = maxOf(1, slot.ids.size),
            )
            if (old != null && old.kind == NoticeKind.DONE) out += syncDone(h, hostId, alert = false)
        } else {
            out += syncDone(h, hostId, alert = true)
        }
        return out
    }

    private fun cancel(h: HostState, n: PushNotice): List<NotifyAction> {
        val hostId = n.hostId
        val slot = h.slots[n.session]
        val key = slotKey(hostId, n.session)
        return when (n.cancel) {
            "approval" -> when {
                slot == null -> listOf(NotifyAction.Cancel(key))
                slot.kind != NoticeKind.APPROVAL && slot.kind != NoticeKind.QUESTION -> emptyList()
                else -> {
                    if (n.id != null) slot.ids.remove(n.id) else slot.ids.clear()
                    if (slot.ids.isEmpty()) { h.slots.remove(n.session); listOf(NotifyAction.Cancel(key)) }
                    else listOf(NotifyAction.Post(key, slot.kind, hostId, h.host, n.session, slot.title, slot.at, attention = true, silent = true, pending = slot.ids.size))
                }
            }
            "seen" -> when {
                slot == null -> listOf(NotifyAction.Cancel(key))
                slot.kind == NoticeKind.DONE || slot.kind == NoticeKind.FAILED || slot.kind == NoticeKind.LIMIT_READY || slot.kind == NoticeKind.LIMIT_GUARDED || slot.kind == NoticeKind.SCHEDULE_MISSED -> {
                    h.slots.remove(n.session)
                    listOf<NotifyAction>(NotifyAction.Cancel(key)) + (if (slot.kind == NoticeKind.DONE) syncDone(h, hostId, alert = false) else emptyList())
                }
                else -> emptyList()
            }
            else -> emptyList()
        }
    }

    /** Brings the completions of one host to the right shape: nothing, one notification, or one bundle. */
    private fun syncDone(h: HostState, hostId: String, alert: Boolean): List<NotifyAction> {
        val dones = h.slots.entries.filter { it.value.kind == NoticeKind.DONE }
        val out = ArrayList<NotifyAction>()
        when {
            dones.isEmpty() -> if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
            dones.size == 1 -> {
                val (session, slot) = dones[0]
                if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
                if (!slot.shown || alert) {
                    // Overwriting its own earlier notification keeps it quiet; a first showing alerts unless it comes back from a bundle
                    val comingBack = !alert
                    slot.shown = true
                    out += NotifyAction.Post(slotKey(hostId, session), NoticeKind.DONE, hostId, h.host, session, slot.title, slot.at, attention = false, silent = comingBack)
                }
            }
            else -> {
                for ((session, slot) in dones) if (slot.shown) { slot.shown = false; out += NotifyAction.Cancel(slotKey(hostId, session)) }
                val newest = dones.last()
                h.bundled = true
                out += NotifyAction.Bundle(bundleKey(hostId), hostId, h.host, dones.size, dones.reversed().map { it.value.title }, newest.key, newest.value.at, silent = !alert)
            }
        }
        return out
    }
}
