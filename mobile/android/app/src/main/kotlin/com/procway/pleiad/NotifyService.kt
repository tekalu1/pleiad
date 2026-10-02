package com.procway.pleiad

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the notification lines (one light WebSocket per paired host, see remote-core NotifyHub) alive while notifications
 * are on, so approvals, failures and completions reach the phone when Pleiad is closed (ADR 0086). A foreground service of
 * type remoteMessaging (Android stops dataSync after 6 hours). Its own notification is the smallest possible: one quiet
 * line. The WebView is never woken; texts are built natively by [NotifyPresenter].
 *
 * It runs only while the setting is on; [sync] starts or stops it to match.
 */
class NotifyService : Service() {
    companion object {
        const val SERVICE_ID = 1

        /** Starts or stops the service to match the notification setting. Safe to call from anywhere (foreground components, boot). */
        fun sync(ctx: Context) {
            val app = ctx.applicationContext as PleiadApp
            val on = try { app.device.store.notifySettings().enabled } catch (_: Exception) { false }
            val intent = Intent(ctx, NotifyService::class.java)
            if (!on) { ctx.stopService(intent); app.notifyHub.stop(); return }
            try {
                ContextCompat.startForegroundService(ctx, intent)
            } catch (e: Exception) {
                // Android refuses to start a foreground service from the background in some states: it starts the next time the app is opened
                Log.w("Pleiad", "notify service not started: ${e.message}")
            }
        }
    }

    private val app get() = application as PleiadApp
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotifyPresenter.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val note: Notification = NotificationCompat.Builder(this, NotifyPresenter.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_pleiad)
            .setContentText(getString(R.string.notify_service_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true).setShowWhen(false).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
            else startForeground(SERVICE_ID, note)
        } catch (e: Exception) {
            Log.w("Pleiad", "notify service cannot run in the foreground: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        app.notifyHub.start()
        watchNetwork()
        return START_STICKY
    }

    private fun watchNetwork() {
        if (callback != null) return
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { app.notifyHub.networkAvailable() }
        }
        try { cm.registerDefaultNetworkCallback(cb); callback = cb } catch (_: Exception) {}
    }

    override fun onDestroy() {
        callback?.let { try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {} }
        callback = null
        super.onDestroy()
    }
}
