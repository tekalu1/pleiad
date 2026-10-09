package dev.pleiad.app.remote

// Where a link pressed in the host window goes on this device (docs/remote.md §8.5).
// The same rules as desktop/remote-windows.cjs (linkTarget) and web/host-only-links.mjs (isHostOnlyUrl).
// Pure: the app passes the pieces of android.net.Uri, the JVM tests pass strings.

enum class LinkTarget {
    /** The host's saved copy of a visualization on this window's proxy: shown in the app (the proxy's cookie is here only) */
    SNAPSHOT,
    /** A web page: the device's default browser */
    EXTERNAL,
    /** localhost / loopback: it means the host's PC, but on this device it would open the device itself */
    HOST_ONLY,
    /** Anything else (other schemes, credentials in the URL, other pages of the proxy): nothing opens */
    BLOCKED,
}

object LinkPolicy {
    const val SNAPSHOT_PATH = "/visualization-snapshot"
    private val LOOPBACK_V4 = Regex("^127(\\.\\d{1,3}){3}$")

    fun isLoopbackHost(host: String?): Boolean {
        val h = (host ?: return false).lowercase().removeSurrounding("[", "]").removeSuffix(".")
        return h == "localhost" || h.endsWith(".localhost") || LOOPBACK_V4.matches(h) || h == "0.0.0.0" ||
            h == "::1" || h == "::" || h.startsWith("::ffff:127.") || h.startsWith("::ffff:7f")
    }

    /**
     * @param port -1 when the URL has none
     * @param proxyPort the port of this window's in-app proxy (http://127.0.0.1:<proxyPort>)
     */
    fun classify(scheme: String?, host: String?, port: Int, path: String?, hasUserInfo: Boolean, proxyPort: Int): LinkTarget {
        val s = scheme?.lowercase() ?: return LinkTarget.BLOCKED
        if (s != "http" && s != "https") return LinkTarget.BLOCKED
        if (host.isNullOrEmpty() || hasUserInfo) return LinkTarget.BLOCKED
        val effectivePort = if (port == -1) (if (s == "https") 443 else 80) else port
        if (s == "http" && host == "127.0.0.1" && effectivePort == proxyPort) {
            return if (path == SNAPSHOT_PATH) LinkTarget.SNAPSHOT else LinkTarget.BLOCKED
        }
        return if (isLoopbackHost(host)) LinkTarget.HOST_ONLY else LinkTarget.EXTERNAL
    }
}
