package dev.pleiad.app.remote

// Keeps this device's notification lines alive (one per paired host) and its key registered with each host, and feeds
// what arrives to the planner (docs/remote.md §11-5, ADR 0086). The Android service owns one NotifyHub; everything
// here is plain JVM so the whole flow (relay + host + line + planner) is tested against the real Node relay.
//
// - Lines run only while notifications are on (settings.enabled) and for hosts that are not revoked.
// - Registration (key + settings) happens when a line connects (the host is then online) and whenever the settings change.
//   A host that predates notifications is left alone until the next start; failures retry with a growing delay.
// - The settings are also enforced here (NotifyPlanner), so a change made in the app takes effect even before the host
//   has been told.

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

interface NotifySink {
    /** Show / update / remove notifications. May be called from any thread. */
    fun act(actions: List<NotifyAction>, settings: NotifySettings)
    /** Notifications were turned off: remove everything this app showed. */
    fun clear() {}
    /** A host's line changed state (for the shell's status, logs). */
    fun lineState(hostId: String, state: String) {}
}

class NotifyHub(
    private val store: FileDeviceStore,
    private val loop: Loop,
    private val app: String,
    private val name: String,
    private val sink: NotifySink,
    private val lineBackoff: Backoff = Backoff(5_000, 300_000, 60_000),
    private val pingMs: Long = 240_000,
    private val registerRetryMs: Long = 60_000,
    private val reregisterMs: Long = 6 * 60 * 60_000L,
    private val log: (String) -> Unit = {},
) {
    private class Reg(var version: Long = -1, var at: Long = 0, var failures: Int = 0, var unsupported: Boolean = false, var running: Boolean = false)

    private val planner = NotifyPlanner()
    private val lines = ConcurrentHashMap<String, NotifyLine>()
    private val regs = ConcurrentHashMap<String, Reg>()
    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "pleiad-notify-hub").also { it.isDaemon = true } }
    private val timer = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "pleiad-notify-timer").also { it.isDaemon = true } }
    private val registrar by lazy { NotifyRegistrar(loop, store.identity(), app, name, log = log) }
    @Volatile private var settings = NotifySettings()
    @Volatile private var settingsVersion = 0L
    @Volatile private var running = false

    /** Latest settings (from the store). */
    fun settings(): NotifySettings = settings

    /** Start (or re-read everything): reads the settings and makes the lines match them. */
    @Synchronized
    fun start() {
        running = true
        applySettings()
    }

    /** The settings file changed (the app's notification screen). Registers the new settings with the hosts. */
    @Synchronized
    fun settingsChanged() {
        if (!running) return
        applySettings()
    }

    /** The host list changed (paired / removed / revoked): add and drop lines. */
    @Synchronized
    fun hostsChanged() {
        if (running) reconcile()
    }

    @Synchronized
    fun stop() {
        running = false
        for (line in lines.values) line.stop()
        lines.clear()
        planner.reset()
    }

    /** The network came back: lines that are waiting for their backoff try now. */
    fun networkAvailable() { for (line in lines.values) line.retryNow() }

    /** The user opened a notification (tap): the planner forgets it and may re-shape the completions bundle. */
    fun opened(hostId: String, session: String?, bundle: Boolean) {
        sink.act(planner.opened(hostId, session, bundle), settings)
    }

    /** Test / diagnostics: the line states by host. */
    fun states(): Map<String, String> = lines.mapValues { it.value.state }

    private fun applySettings() {
        settings = store.notifySettings()
        settingsVersion++
        if (!settings.enabled) {
            for (line in lines.values) line.stop()
            lines.clear()
            planner.reset()
            sink.clear()
            return
        }
        reconcile()
        // Tell the connected hosts about the new settings
        for (hostId in lines.keys) maybeRegister(hostId, force = false)
    }

    private fun reconcile() {
        if (!settings.enabled) return
        val hosts = store.hosts().filter { it.revokedAt == null }
        val keep = hosts.map { it.hostId }.toSet()
        for ((id, line) in lines.entries.toList()) if (id !in keep) { line.stop(); lines.remove(id); regs.remove(id) }
        val key = store.notifyKey()
        for (h in hosts) {
            if (lines.containsKey(h.hostId)) continue
            val creds = store.credentials(h.hostId) ?: continue
            val line = NotifyLine(
                creds, key,
                onNotice = { n -> sink.act(planner.onNotice(n, settings), settings) },
                onState = { s -> onLineState(h.hostId, s) },
                backoff = lineBackoff, pingMs = pingMs, log = log,
            )
            lines[h.hostId] = line
            line.start()
        }
    }

    private fun onLineState(hostId: String, state: String) {
        try { sink.lineState(hostId, state) } catch (_: Exception) {}
        if (state == "connected") maybeRegister(hostId, force = false)
        if (state == "revoked") {
            lines.remove(hostId)?.stop()
            regs.remove(hostId)
        }
    }

    /** Registers the key and settings with a host when needed (a new version of the settings, a long time since, or never). */
    private fun maybeRegister(hostId: String, force: Boolean) {
        if (!running || !settings.enabled) return
        val reg = regs.getOrPut(hostId) { Reg() }
        synchronized(reg) {
            if (reg.running || reg.unsupported && !force) return
            val due = force || reg.version != settingsVersion || System.currentTimeMillis() - reg.at > reregisterMs
            if (!due) return
            reg.running = true
        }
        val version = settingsVersion
        val snapshot = settings
        workers.execute {
            val creds = store.credentials(hostId)
            val result = if (creds == null) RegisterResult.Failed("unknown-host") else try {
                registrar.register(creds, store.notifyKey(), snapshot)
            } catch (e: Exception) { RegisterResult.Failed("error", e.message) }
            synchronized(reg) {
                reg.running = false
                when (result) {
                    is RegisterResult.Done -> { reg.version = version; reg.at = System.currentTimeMillis(); reg.failures = 0 }
                    is RegisterResult.Unsupported -> { reg.unsupported = true; log("notify: host $hostId does not support notifications") }
                    is RegisterResult.Failed -> {
                        reg.failures++
                        log("notify: registering with $hostId failed (${result.state}${result.detail?.let { ": $it" } ?: ""})")
                        val delay = minOf(30 * 60_000L, registerRetryMs * (1L shl minOf(reg.failures - 1, 6)))
                        try { timer.schedule({ maybeRegister(hostId, force = false) }, delay, TimeUnit.MILLISECONDS) } catch (_: Exception) {}
                    }
                }
            }
            // The settings changed while we were registering: do it again with the newest
            if (result is RegisterResult.Done && version != settingsVersion) maybeRegister(hostId, force = false)
        }
    }

    /** For tests: the registration state of a host. */
    internal fun registered(hostId: String): Boolean = regs[hostId]?.let { it.version == settingsVersion } ?: false
}
