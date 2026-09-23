package com.procway.pleiad

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * The shell: the bundled host list (mobile/www) in Capacitor's WebView. Only this WebView has the Capacitor bridge;
 * host pages open in HostActivity's plain WebView (docs/remote.md §8.2).
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PleiadRemotePlugin::class.java)
        super.onCreate(savedInstanceState)
        takePairLink(intent)
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
