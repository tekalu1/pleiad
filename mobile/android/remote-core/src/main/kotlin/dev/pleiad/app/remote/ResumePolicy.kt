package dev.pleiad.app.remote

/** What the launcher start should do about the host the user was in last (docs/remote.md §8.2): open [hostId], or [forget] the saved one. */
data class ResumeDecision(val hostId: String?, val forget: Boolean)

/**
 * Whether the app opens straight into the last host instead of showing the host list. Pure, so the rules are unit-tested.
 *
 * Opens only when the start is a fresh launcher start (not a restore after the system recreated the activity, not a
 * pleiad://pair link) and the saved host is still paired and not revoked. A saved host that no longer qualifies is
 * forgotten, so it is not checked again at every start.
 */
object ResumePolicy {
    fun decide(saved: String?, hosts: List<HostRecord>, freshStart: Boolean, launcherStart: Boolean): ResumeDecision {
        if (saved.isNullOrEmpty()) return ResumeDecision(null, false)
        val host = hosts.find { it.hostId == saved }
        if (host == null || host.revokedAt != null) return ResumeDecision(null, true)
        if (!freshStart || !launcherStart) return ResumeDecision(null, false)
        return ResumeDecision(saved, false)
    }
}
