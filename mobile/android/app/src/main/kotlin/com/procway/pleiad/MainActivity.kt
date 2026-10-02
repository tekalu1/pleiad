package com.procway.pleiad

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.procway.pleiad.remote.ResumePolicy

/**
 * The shell: the bundled host list (mobile/www) in Capacitor's WebView. Only this WebView has the Capacitor bridge;
 * host pages open in HostActivity's plain WebView (docs/remote.md §8.2).
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Before Capacitor builds its WebView, so the host window is already queued when the list would first draw
        resumeLastHost(savedInstanceState)
        registerPlugin(PleiadRemotePlugin::class.java)
        super.onCreate(savedInstanceState)
        takePairLink(intent)
        takeOpenLink(intent)
        NotifyService.sync(this)
    }

    /**
     * A launcher start opens the host the user was in last (HostActivity on top; the list stays underneath). Not on a restore
     * (savedInstanceState) and not for a pleiad://pair link. ResumePolicy decides; the user's way back to the list is the
     * host window's "back to hosts", which forgets the host (ResumeStore).
     */
    private fun resumeLastHost(savedInstanceState: Bundle?) {
        val store = ResumeStore(this)
        val saved = store.hostId() ?: return
        val device = (application as PleiadApp).device
        val d = ResumePolicy.decide(saved, device.store.hosts(), savedInstanceState == null, intent?.action == Intent.ACTION_MAIN)
        if (d.forget) store.forget()
        d.hostId?.let { startActivity(Intent(this, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, it)) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takePairLink(intent)
        takeOpenLink(intent)
    }

    /**
     * pleiad://open?h=<hostId>&s=<sessionId> (a notification was tapped, ADR 0086): open that host's window on that conversation.
     * The notification system forgets the tapped notification; the planner is told so a bundle can shrink or go.
     */
    private fun takeOpenLink(intent: Intent?) {
        val (hostId, session, bundle) = NotifyControl.parseOpen(this, intent?.data) ?: return
        intent?.data = null   // handled once (a recreated activity must not open it again)
        (application as PleiadApp).notifyHub.opened(hostId, session.takeIf { it.isNotEmpty() }, bundle)
        startActivity(
            Intent(this, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, hostId)
                .apply { if (session.isNotEmpty()) putExtra(HostActivity.EXTRA_OPEN_SESSION, session) }
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    /** pleiad://pair?... opened from the system camera or another app: hand it to the host list (it asks before pairing). */
    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "pleiad" && data.host == "pair") PleiadRemotePlugin.offerLink(data.toString())
    }
}
