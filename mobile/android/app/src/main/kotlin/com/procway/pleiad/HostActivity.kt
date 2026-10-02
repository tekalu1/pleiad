package com.procway.pleiad

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
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
import com.procway.pleiad.remote.LinkPolicy
import com.procway.pleiad.remote.LinkStatus
import com.procway.pleiad.remote.LinkTarget
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * One host's window: a plain WebView (no Capacitor bridge) on the in-app loopback proxy, http://127.0.0.1:<p>/?token=…
 * (docs/remote.md §8.2, §8.3 option A). Into the host page we inject only `window.plyRemote`
 * ({ hostId, hostName, shell: 'mobile', status, onStatus, retry, backToHosts, closeWindow, setTheme }), and only for the proxy's
 * origin and main frame (plus `window.backToHosts`, the same function, which web/remote-badge.mjs also looks for):
 * a document-start script plus a WebMessageListener whose messages are accepted only from the
 * main frame of that origin.
 *
 * Back button / edge swipe: first offered to the page as a cancelable `plyremote:back` event (so it can close a dialog,
 * a menu or the drawer); if nobody calls preventDefault(), the app goes to the background like any root screen. It does
 * not go back to the host list (the host name under the title does that). Leaving the window closes the host's proxy.
 *
 * Links (docs/remote.md §8.5): a new window the page asks for (target=_blank, window.open) becomes a bare WebView whose
 * first navigation decides where it goes (LinkPolicy): a visualization's saved copy on the proxy shows in a sheet over the
 * page (the proxy's cookie lives only in this app, so the device's browser would get a 401); a web page goes to the
 * device's browser; localhost is the host's PC, so it only shows a short notice. The page itself stays where it is.
 */
class HostActivity : ComponentActivity() {
    companion object {
        const val EXTRA_HOST_ID = "hostId"
        /** A conversation to open once the page is up (a tapped notification, ADR 0086). */
        const val EXTRA_OPEN_SESSION = "open"
        private const val BRIDGE = "plyRemoteBridge"
        private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "pleiad-host").also { it.isDaemon = true } }
    }

    private val device get() = (application as PleiadApp).device
    private lateinit var hostId: String
    private var proxy: DeviceProxy? = null
    private var web: WebView? = null
    /** The window the page opened last (not yet placed), and the sheet it shows in once it holds a snapshot. */
    private var popup: WebView? = null
    private var sheet: LinearLayout? = null
    private lateinit var root: FrameLayout
    private lateinit var frame: FrameLayout
    private lateinit var topBand: View
    private lateinit var progress: ProgressBar
    @Volatile private var reply: JavaScriptReplyProxy? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    /** The conversation a tapped notification wants, until the page can be told. */
    private var pendingOpen: String? = null
    private var notifyPermissionCallback: ((Boolean) -> Unit)? = null
    private val askNotifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notifyPermissionCallback?.invoke(granted)
        notifyPermissionCallback = null
    }
    private val statusListener: (String, LinkStatus) -> Unit = { id, s -> if (id == hostId) runOnUiThread { pushStatus(s) } }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hostId = intent.getStringExtra(EXTRA_HOST_ID) ?: return finish()
        ResumeStore(this).remember(hostId)
        pendingOpen = intent.getStringExtra(EXTRA_OPEN_SESSION)
        NotifyService.sync(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // The system bars are colored, but nothing of the page is drawn under them (2026-09-24): the page sits in `frame`,
        // padded by the bars, the cutout and the keyboard. The bars show the page's colors instead (topBand for the status
        // bar, root for the navigation bar and the sides), and their icons follow the page's theme: the system's until the
        // page reports its own via plyRemote.setTheme (applyBars). The insets are consumed here, so the page's
        // env(safe-area-inset-*) is 0 and a resized viewport matches the page's interactive-widget=resizes-content.
        root = FrameLayout(this)
        topBand = View(this)
        frame = FrameLayout(this)
        progress = ProgressBar(this).apply { isIndeterminate = true }
        frame.addView(progress, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.CENTER))
        root.addView(frame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(topBand, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, android.view.Gravity.TOP))
        setContentView(root)
        val paper = if (isNight()) Color.rgb(0x1b, 0x1c, 0x23) else Color.WHITE   // --surface-paper (web/tokens.css)
        applyBars(isNight(), paper, paper)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            frame.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            topBand.layoutParams = topBand.layoutParams.apply { height = bars.top }
            WindowInsetsCompat.CONSUMED
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

    /** The bars' colors (top: status bar; bottom: navigation bar and sides) and icons: dark page surface -> light icons. */
    private fun applyBars(dark: Boolean, top: Int, bottom: Int) {
        topBand.setBackgroundColor(top)
        root.setBackgroundColor(bottom)
        val bar = WindowCompat.getInsetsController(window, root)
        bar.isAppearanceLightStatusBars = !dark
        bar.isAppearanceLightNavigationBars = !dark
    }

    private fun isNight() = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun showError(text: String) {
        progress.visibility = View.GONE
        frame.addView(TextView(this).apply { this.text = text; setPadding(48, 48, 48, 48) })
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
            // New windows (target=_blank, window.open) come to onCreateWindow; only on a tap (isUserGesture)
            setSupportMultipleWindows(true)
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
                if (request.isForMainFrame) openOutside(u)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
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

            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false
                closePopup()
                val p = newPopup(px.port)
                popup = p
                (resultMsg.obj as WebView.WebViewTransport).webView = p
                resultMsg.sendToTarget()
                // A window that never goes anywhere (the page gave up) is dropped
                root.postDelayed({ if (popup === p && sheet == null) closePopup() }, 10_000)   // p is not attached: its own post would wait
                return true
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
        frame.addView(w, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        // A tapped notification names the conversation: the page opens it after it is ready (?open=, taken once)
        val open = pendingOpen?.let { "&open=" + Uri.encode(it) } ?: ""
        pendingOpen = null
        w.loadUrl(px.url + open)
    }

    /** A notification for this host was tapped while this window exists: tell the page, or keep it for when it is up. */
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        val target = intent.getStringExtra(EXTRA_HOST_ID)
        val session = intent.getStringExtra(EXTRA_OPEN_SESSION)
        if (target != null && target != hostId) {
            // Another host's notification: this window goes, the other host's takes its place
            finish()
            startActivity(android.content.Intent(this, HostActivity::class.java).putExtras(intent))
            return
        }
        if (session.isNullOrEmpty()) return
        val w = web
        if (w == null) { pendingOpen = session; return }
        w.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('plyremote:open', { detail: { sessionId: ${JSONObject.quote(session)} } }))", null,
        )
    }

    /** The page is told when the app leaves / returns to the front, so a conversation open here does not count as being watched in the background. */
    override fun onStart() {
        super.onStart()
        web?.evaluateJavascript("window.dispatchEvent(new Event('plyremote:start'))", null)
    }

    override fun onStop() {
        web?.evaluateJavascript("window.dispatchEvent(new Event('plyremote:stop'))", null)
        super.onStop()
    }

    /** Answers a request from the page: { type: 'reply', id, result } (the page's promise resolves with result). */
    private fun replyTo(id: Int, result: JSONObject) {
        runOnUiThread { try { reply?.postMessage(JSONObject().put("type", "reply").put("id", id).put("result", result).toString()) } catch (_: Exception) {} }
    }

    /** Where a link goes on this device (LinkPolicy). Web pages open in the device's browser, localhost only tells why not. */
    private fun linkTarget(u: Uri): LinkTarget =
        LinkPolicy.classify(u.scheme, u.host, u.port, u.path, u.userInfo != null, proxy?.port ?: -1)

    private fun openOutside(u: Uri) {
        when (linkTarget(u)) {
            LinkTarget.EXTERNAL -> try {
                startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {}
            LinkTarget.HOST_ONLY -> Toast.makeText(this, R.string.link_host_only, Toast.LENGTH_SHORT).show()
            else -> {}
        }
    }

    /**
     * A window the page opened. Nothing of the host UI goes in: no plyRemote, no downloads, no further windows (a
     * target=_blank inside navigates this one and is routed like the rest). Scripts run for the snapshot, which the host
     * serves with `Content-Security-Policy: sandbox allow-scripts` (an opaque origin, docs/visualize.md).
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun newPopup(proxyPort: Int): WebView {
        val p = WebView(this)
        p.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(p, false)
        p.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                return !place(view, request.url)
            }

            // Some WebView versions start a new window's first page without asking shouldOverrideUrlLoading
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (url == "about:blank" || (view === popup && sheet != null)) return
                if (!place(view, Uri.parse(url))) view.stopLoading()
            }
        }
        p.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) {
                if (view === popup) sheet?.findViewWithTag<TextView>("title")?.text = title ?: ""
            }
        }
        return p
    }

    /** true = load it here (the snapshot, shown in the sheet). Otherwise it went outside, and a window that only carried it goes away. */
    private fun place(view: WebView, u: Uri): Boolean {
        if (linkTarget(u) == LinkTarget.SNAPSHOT) {
            if (view === popup && sheet == null) showSheet(view)
            return view === popup
        }
        openOutside(u)
        if (view === popup && sheet == null) root.post { if (popup === view && sheet == null) closePopup() }
        return false
    }

    /** The snapshot over the page (inside the bars, like the page), with its title and a close button. Back closes it too. */
    private fun showSheet(p: WebView) {
        val dark = isNight()
        val paper = (topBand.background as? android.graphics.drawable.ColorDrawable)?.color ?: if (dark) Color.rgb(0x1b, 0x1c, 0x23) else Color.WHITE
        val ink = if (Color.luminance(paper) < 0.4f) Color.rgb(0xdf, 0xe3, 0xf2) else Color.rgb(0x1c, 0x22, 0x47)
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setBackgroundColor(paper)
            setPadding(40, 8, 16, 8)
            addView(TextView(this@HostActivity).apply {
                tag = "title"; setTextColor(ink); textSize = 16f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Button(this@HostActivity, null, android.R.attr.borderlessButtonStyle).apply {
                setText(R.string.sheet_close); setTextColor(ink); isAllCaps = false
                setOnClickListener { closePopup() }
            })
        }
        val s = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(paper)
            isClickable = true   // taps do not fall through to the page
            addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(p, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        sheet = s
        frame.addView(s, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun closePopup() {
        val p = popup ?: return
        popup = null
        sheet?.let { frame.removeView(it) }
        sheet = null
        (p.parent as? ViewGroup)?.removeView(p)
        p.destroy()
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
                "theme" -> applyTheme(message.data)
                "back" -> backToList()
                // The notification band (web/mobile-notify.mjs, ADR 0086)
                "notify.state" -> replyTo(idOf(message.data), NotifyControl.state(this))
                "notify.enable" -> {
                    val id = idOf(message.data)
                    NotifyControl.enable(this, ask = { cb -> notifyPermissionCallback = cb; askNotifyPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS) },
                        done = { result -> replyTo(id, result) })
                }
                "notify.dismiss" -> NotifyControl.dismissBand(this)
            }
        }
        WebViewCompat.addDocumentStartJavaScript(w, remoteScript(info), setOf(origin))
    }

    private fun idOf(data: String?) = try { JSONObject(data ?: "").optInt("id") } catch (_: Exception) { 0 }

    private fun remoteScript(info: JSONObject) = """
(() => {
  if (window.top !== window || window.plyRemote) return;
  const bridge = window.$BRIDGE;
  if (!bridge) return;
  try { delete window.$BRIDGE; } catch (e) {}
  const info = $info;
  const listeners = new Set();
  let last = null;
  const waiting = new Map();
  let nextId = 0;
  bridge.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m && m.type === 'status') { last = m.status; for (const fn of listeners) { try { fn(last); } catch (_) {} } }
    else if (m && m.type === 'reply' && waiting.has(m.id)) { const done = waiting.get(m.id); waiting.delete(m.id); done(m.result); }
  };
  const post = (type, extra) => bridge.postMessage(JSON.stringify(Object.assign({ type }, extra || {})));
  const ask = (type) => new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    post(type, { id });
    setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 120000);
  });
  // Notifications while away (ADR 0086): the page shows the band and asks the shell to turn them on
  const notify = Object.freeze({
    state: () => ask('notify.state'),
    enable: () => ask('notify.enable'),
    dismiss: () => post('notify.dismiss'),
  });
  const api = Object.freeze({
    hostId: info.hostId, hostName: info.hostName, relay: info.relay, device: info.device, shell: 'mobile',
    status: () => Promise.resolve(last),
    onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    retry: () => { post('retry'); return Promise.resolve(); },
    backToHosts: () => post('back'),
    closeWindow: () => post('back'),
    setTheme: (dark, colors) => post('theme', { dark: dark === true, top: String((colors && colors.top) || ''), bottom: String((colors && colors.bottom) || '') }),
    notify,
  });
  Object.defineProperty(window, 'plyRemote', { value: api, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(window, 'backToHosts', { value: api.backToHosts, writable: false, configurable: false, enumerable: false });
  post('hello');
})();
"""

    /** { dark, top, bottom } from plyRemote.setTheme. Colors are #rrggbb; anything else keeps the current color. */
    private fun applyTheme(data: String?) {
        val m = try { JSONObject(data ?: "") } catch (_: Exception) { return }
        val dark = m.optBoolean("dark", isNight())
        fun color(key: String, fallback: Int) = m.optString(key).takeIf { Regex("^#[0-9a-fA-F]{6}$").matches(it) }?.let { Color.parseColor(it) } ?: fallback
        runOnUiThread {
            val top = color("top", (topBand.background as? android.graphics.drawable.ColorDrawable)?.color ?: Color.WHITE)
            val bottom = color("bottom", (root.background as? android.graphics.drawable.ColorDrawable)?.color ?: Color.WHITE)
            applyBars(dark, top, bottom)
        }
    }

    private fun pushStatus(s: LinkStatus) {
        val r = reply ?: return
        try { r.postMessage(JSONObject().put("type", "status").put("status", s.toJson()).toString()) } catch (_: Exception) {}
    }

    /** The user left for the host list: the next launcher start shows the list too, not this host (ResumeStore). */
    private fun backToList() {
        ResumeStore(this).forget(hostId)
        runOnUiThread { finish() }
    }

    private fun offerBack() {
        if (sheet != null) return closePopup()
        val w = web ?: return backToList()
        w.evaluateJavascript("(() => { try { return !window.dispatchEvent(new CustomEvent('plyremote:back', { cancelable: true })); } catch (e) { return false; } })()") { result ->
            if (result != "true") moveTaskToBack(true)
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
        closePopup()
        web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        web = null
        if (isFinishing) worker.execute { device.close(hostId) }
        super.onDestroy()
    }
}
