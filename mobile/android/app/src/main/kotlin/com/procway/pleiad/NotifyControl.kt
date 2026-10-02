package com.procway.pleiad

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.procway.pleiad.remote.NotifySettings
import org.json.JSONObject

/**
 * The app's notification settings and the "turn on" flow, shared by the host list (Capacitor plugin) and the host window
 * (the band that asks after the first finished work). ADR 0086: the permission is never asked at install time; it is
 * asked when the user turns notifications on, and the battery-optimization guidance is shown once at that moment.
 */
object NotifyControl {
    private const val PREFS = "pleiad_notify"
    private const val KEY_BATTERY_ASKED = "batteryAsked"

    private fun app(ctx: Context) = ctx.applicationContext as PleiadApp

    fun hasPermission(ctx: Context) =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** { settings, permission: "granted"|"missing", enabled (on and allowed), dismissed (the band) , lines: { hostId: state } } */
    fun state(ctx: Context): JSONObject {
        val store = app(ctx).device.store
        val s = store.notifySettings()
        val granted = hasPermission(ctx)
        return JSONObject()
            .put("settings", s.toJson())
            .put("permission", if (granted) "granted" else "missing")
            .put("enabled", s.enabled && granted)
            .put("dismissed", store.notifyBandDismissed())
            .put("lines", JSONObject(app(ctx).notifyHub.states()))
    }

    /** Merge a partial settings object (any of the NotifySettings fields) and apply it. Turning on goes through [enable]. */
    fun update(ctx: Context, patch: JSONObject): JSONObject {
        val store = app(ctx).device.store
        val cur = store.notifySettings().toJson()
        for (k in patch.keys()) if (k in setOf("enabled", "reply", "failed", "done", "lockNames", "skipPc") && patch.get(k) is Boolean) cur.put(k, patch.get(k))
        store.saveNotifySettings(NotifySettings.fromJson(cur))
        app(ctx).notifyHub.settingsChanged()
        NotifyService.sync(ctx)
        return state(ctx)
    }

    /**
     * Turn notifications on: ask for the permission if needed (via [ask], which the caller implements with its own
     * activity), save, start the service, and show the battery guidance once. [done] gets { ok, permission, state }.
     */
    fun enable(activity: Activity, ask: (callback: (Boolean) -> Unit) -> Unit, done: (JSONObject) -> Unit) {
        fun proceed() {
            val state = update(activity, JSONObject().put("enabled", true))
            activity.runOnUiThread { batteryGuidance(activity) }
            done(JSONObject().put("ok", true).put("permission", "granted").put("state", state))
        }
        if (hasPermission(activity)) return proceed()
        ask { granted ->
            if (granted) proceed()
            else done(JSONObject().put("ok", false).put("permission", "missing").put("state", state(activity)))
        }
    }

    /** "Not now" on the band: remember it, never ask through the band again (the app's notification screen stays). */
    fun dismissBand(ctx: Context) = app(ctx).device.store.setNotifyBandDismissed(true)

    /** The system's page for this app's notifications (the permission was refused: the user can turn it on there). */
    fun openSystemSettings(ctx: Context) {
        val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { ctx.startActivity(i) } catch (_: Exception) {}
    }

    /** Once: explain that battery optimization can delay notifications and offer the system setting to exclude Pleiad. */
    private fun batteryGuidance(activity: Activity) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_BATTERY_ASKED, false)) return
        val pm = activity.getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(activity.packageName)) return
        prefs.edit().putBoolean(KEY_BATTERY_ASKED, true).apply()
        if (activity.isFinishing || activity.isDestroyed) return
        AlertDialog.Builder(activity)
            .setTitle(R.string.notify_battery_title)
            .setMessage(R.string.notify_battery_message)
            .setPositiveButton(R.string.notify_battery_open) { _, _ ->
                try { activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {}
            }
            .setNegativeButton(R.string.notify_battery_later, null)
            .show()
    }

    /** The host and conversation a pleiad://open link names (null when it is not one or the host is not paired here). */
    fun parseOpen(ctx: Context, uri: Uri?): Triple<String, String, Boolean>? {
        if (uri == null || uri.scheme != "pleiad" || uri.host != "open") return null
        val hostId = uri.getQueryParameter("h") ?: return null
        if (app(ctx).device.store.host(hostId) == null) return null
        return Triple(hostId, uri.getQueryParameter("s") ?: "", uri.getQueryParameter("b") == "1")
    }
}
