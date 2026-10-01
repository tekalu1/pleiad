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
    }

    /** pleiad://pair?... opened from the system camera or another app: hand it to the host list (it asks before pairing). */
    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "pleiad" && data.host == "pair") PleiadRemotePlugin.offerLink(data.toString())
    }
}
