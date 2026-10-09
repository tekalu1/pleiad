package dev.pleiad.app

import android.content.Context

/**
 * The host the user was in last, so a launcher start opens it instead of the host list (ResumePolicy, docs/remote.md §8.2).
 * Only the host id (no secret). Set when a host window opens; forgotten when the user goes back to the list or removes the host.
 */
class ResumeStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("resume", Context.MODE_PRIVATE)

    fun hostId(): String? = prefs.getString(KEY, null)

    fun remember(hostId: String) {
        prefs.edit().putString(KEY, hostId).apply()
    }

    /** Forget the saved host: any (hostId = null) or only if it is [hostId]. */
    fun forget(hostId: String? = null) {
        if (hostId == null || prefs.getString(KEY, null) == hostId) prefs.edit().remove(KEY).apply()
    }

    private companion object {
        const val KEY = "hostId"
    }
}
