package com.procway.pleiad

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.procway.pleiad.remote.DeviceProxy
import com.procway.pleiad.remote.LinkStatus
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * One host's window: a plain WebView (no Capacitor bridge) on the in-app loopback proxy, http://127.0.0.1:<p>/?token=…
 * (docs/remote.md §8.2, §8.3 option A). Into the host page we inject only `window.plyRemote`
 * ({ hostId, hostName, shell: 'mobile', status, onStatus, retry, backToHosts, closeWindow }), and only for the proxy's
 * origin and main frame (plus `window.backToHosts`, the same function, which web/remote-badge.mjs also looks for):
 * a document-start script plus a WebMessageListener whose messages are accepted only from the
 * main frame of that origin.
 *
 * Back button: first offered to the page as a cancelable `plyremote:back` event (so it can close a drawer or a menu);
 * if nobody calls preventDefault(), we go back to the host list. Leaving the window closes the host's proxy.
 */
class HostActivity : ComponentActivity() {
    companion object {
        const val EXTRA_HOST_ID = "hostId"
        private const val BRIDGE = "plyRemoteBridge"
        private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "pleiad-host").also { it.isDaemon = true } }
    }

    private val device get() = (application as PleiadApp).device
    private lateinit var hostId: String
    private var proxy: DeviceProxy? = null
    private var web: WebView? = null
    private lateinit var root: FrameLayout
    private lateinit var progress: ProgressBar
    @Volatile private var reply: JavaScriptReplyProxy? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var padBars = false
    private var lastBars: androidx.core.graphics.Insets? = null
    private val statusListener: (String, LinkStatus) -> Unit = { id, s -> if (id == hostId) runOnUiThread { pushStatus(s) } }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hostId = intent.getStringExtra(EXTRA_HOST_ID) ?: return finish()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this)
        root.setBackgroundColor(if (isNight()) Color.rgb(0x1c, 0x1c, 0x1c) else Color.rgb(0xf6, 0xf6, 0xf4))
        progress = ProgressBar(this).apply { isIndeterminate = true }
        root.addView(progress, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.CENTER))
        setContentView(root)
        // Edge-to-edge: the host page draws under the system bars and places itself with env(safe-area-inset-*)
        // (web/style.css; the host bar paints the status-bar area with the fill color, so the icons are light).
        // Only the keyboard is padded here (the page's interactive-widget=resizes-content expects a resized viewport).
        // If this WebView reports no safe-area insets, fall back to padding the bars (probeSafeArea).
        val bar = WindowCompat.getInsetsController(window, root)
        bar.isAppearanceLightStatusBars = false
        bar.isAppearanceLightNavigationBars = !isNight()
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            lastBars = bars
            if (padBars) v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            else v.setPadding(0, 0, 0, if (ime.bottom > 0) ime.bottom else 0)
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = offerBack()
        })
        device.onStatus(statusListener)
        worker.execute {
            try {
                val px = device.open(hostId)
                runOnUiThread { if (!isFinishing && !isDestroyed) showHost(px) }
            } catch (e: Exception) {
                runOnUiThread { showError(getString(R.string.host_open_failed)) }
            }
        }
    }

    private fun isNight() = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun showError(text: String) {
        progress.visibility = View.GONE
        root.addView(TextView(this).apply { this.text = text; setPadding(48, 48, 48, 48) })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showHost(px: DeviceProxy) {
        proxy = px
        val origin = "http://127.0.0.1:${px.port}"
        val w = WebView(this)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        injectRemote(w, origin, px)
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if ("${u.scheme}://${u.authority}" == origin) return false
                // Links out of the host UI (docs, OAuth pages to copy a code from) open in the browser
                if (request.isForMainFrame) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (_: ActivityNotFoundException) {}
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
                probeSafeArea(view)
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        w.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            // /local-file?download=1 through the proxy: the system downloader reaches 127.0.0.1 too; it needs the cookie
            try {
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", userAgent)
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mimeType))
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            } catch (_: Exception) {}
        }
        root.addView(w, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        w.loadUrl(px.url)
    }

    /** window.plyRemote for the proxy origin only. Never the Capacitor bridge. */
    private fun injectRemote(w: WebView, origin: String, px: DeviceProxy) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) return   // very old WebView: the host UI still works, just without the badge / back-to-hosts
        val rec = device.store.host(hostId)
        val info = JSONObject()
            .put("hostId", hostId)
            .put("hostName", rec?.label?.takeIf { it.isNotEmpty() } ?: rec?.hostName ?: "")
            .put("relay", rec?.relayUrl ?: "")
            .put("device", (application as PleiadApp).deviceName())
        WebViewCompat.addWebMessageListener(w, BRIDGE, setOf(origin)) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            if (!isMainFrame || sourceOrigin.toString() != origin) return@addWebMessageListener
            val type = try { JSONObject(message.data ?: "").optString("type") } catch (_: Exception) { "" }
            when (type) {
                "hello" -> { reply = replyProxy; pushStatus(px.link.status) }
                "retry" -> px.retryNow()
                "back" -> finish()
            }
        }
        WebViewCompat.addDocumentStartJavaScript(w, remoteScript(info), setOf(origin))
    }

    private fun remoteScript(info: JSONObject) = """
(() => {
  if (window.top !== window || window.plyRemote) return;
  const bridge = window.$BRIDGE;
  if (!bridge) return;
  try { delete window.$BRIDGE; } catch (e) {}
  const info = $info;
  const listeners = new Set();
  let last = null;
  bridge.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m && m.type === 'status') { last = m.status; for (const fn of listeners) { try { fn(last); } catch (_) {} } }
  };
  const post = (type) => bridge.postMessage(JSON.stringify({ type }));
  const api = Object.freeze({
    hostId: info.hostId, hostName: info.hostName, relay: info.relay, device: info.device, shell: 'mobile',
    status: () => Promise.resolve(last),
    onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    retry: () => { post('retry'); return Promise.resolve(); },
    backToHosts: () => post('back'),
    closeWindow: () => post('back'),
  });
  Object.defineProperty(window, 'plyRemote', { value: api, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(window, 'backToHosts', { value: api.backToHosts, writable: false, configurable: false, enumerable: false });
  post('hello');
})();
"""

    /** Older WebViews report env(safe-area-inset-top) as 0 even when drawing under the status bar: pad instead. */
    private fun probeSafeArea(view: WebView) {
        if (padBars) return
        val top = lastBars?.top ?: 0
        if (top <= 0) return
        val js = "(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';" +
            " document.documentElement.appendChild(d); const v = parseFloat(getComputedStyle(d).paddingTop) || 0; d.remove(); return v; })()"
        view.evaluateJavascript(js) { r ->
            if ((r?.toDoubleOrNull() ?: 0.0) <= 0.0) {
                padBars = true
                ViewCompat.requestApplyInsets(root)
            }
        }
    }

    private fun pushStatus(s: LinkStatus) {
        val r = reply ?: return
        try { r.postMessage(JSONObject().put("type", "status").put("status", s.toJson()).toString()) } catch (_: Exception) {}
    }

    private fun offerBack() {
        val w = web ?: return finish()
        w.evaluateJavascript("(() => { try { return !window.dispatchEvent(new CustomEvent('plyremote:back', { cancelable: true })); } catch (e) { return false; } })()") { result ->
            if (result != "true") finish()
        }
    }

    override fun onResume() {
        super.onResume()
        // Back in the foreground: sockets may have been cut while in the background; reconnect without waiting
        val st = proxy?.link?.state
        if (st == "offline" || st == "host-offline") proxy?.retryNow()
    }

    override fun onDestroy() {
        device.offStatus(statusListener)
        web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        web = null
        if (isFinishing) worker.execute { device.close(hostId) }
        super.onDestroy()
    }
}
