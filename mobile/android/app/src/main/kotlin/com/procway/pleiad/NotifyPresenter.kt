package com.procway.pleiad

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.procway.pleiad.remote.NoticeKind
import com.procway.pleiad.remote.NotifyAction
import com.procway.pleiad.remote.NotifySettings
import com.procway.pleiad.remote.NotifySink

/**
 * Turns the planner's [NotifyAction]s into Android notifications (ADR 0086, docs/design.md「通知」).
 *
 * Texts are built here in the app's language from what the host sent (kind, host name, conversation name): the title
 * says what happened, the body is the conversation name only (never message text), the sub-text is the host name. On the
 * lock screen the conversation name is hidden unless the user allowed it (VISIBILITY_PRIVATE and a generic public
 * version). Two channels: "needs attention" (high) for approvals, questions and failures, and "finished" (default).
 * Tapping opens the conversation: pleiad://open?h=<hostId>&s=<sessionId> (a bundle opens the newest one).
 */
class NotifyPresenter(private val ctx: Context) : NotifySink {
    companion object {
        const val CH_ATTENTION = "attention"
        const val CH_DONE = "done"
        const val CH_SERVICE = "service"
        const val GROUP_KEY = "pleiad-notices"

        fun ensureChannels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_ATTENTION, ctx.getString(R.string.notify_channel_attention), NotificationManager.IMPORTANCE_HIGH)
                .apply { description = ctx.getString(R.string.notify_channel_attention_desc) })
            nm.createNotificationChannel(NotificationChannel(CH_DONE, ctx.getString(R.string.notify_channel_done), NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = ctx.getString(R.string.notify_channel_done_desc) })
            nm.createNotificationChannel(NotificationChannel(CH_SERVICE, ctx.getString(R.string.notify_channel_service), NotificationManager.IMPORTANCE_MIN)
                .apply { description = ctx.getString(R.string.notify_channel_service_desc); setShowBadge(false) })
        }

        /** The link a notification opens. A bundle carries b=1 (and the newest conversation). */
        fun openUri(hostId: String, session: String, bundle: Boolean): Uri = Uri.Builder().scheme("pleiad").authority("open")
            .appendQueryParameter("h", hostId).appendQueryParameter("s", session).apply { if (bundle) appendQueryParameter("b", "1") }.build()
    }

    private val nm = NotificationManagerCompat.from(ctx)

    override fun clear() {
        for (n in nm.activeNotifications) if (n.id != NotifyService.SERVICE_ID) nm.cancel(n.id)
    }

    override fun act(actions: List<NotifyAction>, settings: NotifySettings) {
        if (actions.isEmpty()) return
        ensureChannels(ctx)
        for (a in actions) {
            when (a) {
                is NotifyAction.Cancel -> nm.cancel(idOf(a.key))
                is NotifyAction.Post -> show(a.key, post(a, settings))
                is NotifyAction.Bundle -> show(a.key, bundle(a, settings))
            }
        }
    }

    private fun idOf(key: String) = key.hashCode()

    @Suppress("MissingPermission")   // checked by areNotificationsEnabled()
    private fun show(key: String, n: Notification) {
        if (!nm.areNotificationsEnabled()) return
        try { nm.notify(idOf(key), n) } catch (_: SecurityException) { /* permission revoked meanwhile */ }
    }

    private fun intent(hostId: String, session: String, bundle: Boolean, key: String): PendingIntent {
        val i = Intent(Intent.ACTION_VIEW, openUri(hostId, session, bundle), ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(ctx, idOf(key), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun title(a: NotifyAction.Post): String = when (a.kind) {
        NoticeKind.APPROVAL -> if (a.pending > 1) ctx.getString(R.string.notify_approval_many, a.pending) else ctx.getString(R.string.notify_approval)
        NoticeKind.QUESTION -> if (a.pending > 1) ctx.getString(R.string.notify_question_many, a.pending) else ctx.getString(R.string.notify_question)
        NoticeKind.FAILED -> ctx.getString(R.string.notify_failed)
        NoticeKind.SCHEDULE_MISSED -> ctx.getString(R.string.notify_schedule_missed)
        else -> ctx.getString(R.string.notify_done)
    }

    private fun publicText(kind: String): String = ctx.getString(when (kind) {
        NoticeKind.APPROVAL -> R.string.notify_public_approval
        NoticeKind.QUESTION -> R.string.notify_public_question
        NoticeKind.FAILED -> R.string.notify_public_failed
        NoticeKind.SCHEDULE_MISSED -> R.string.notify_public_schedule_missed
        else -> R.string.notify_public_done
    })

    private fun base(channel: String, key: String, host: String, at: Long, settings: NotifySettings, publicText: String): NotificationCompat.Builder {
        val b = NotificationCompat.Builder(ctx, channel)
            // Our own bundling (NotifyPlanner) decides what is grouped; keep Android from folding four of them into its own group
            .setGroup("$GROUP_KEY:$key")
            .setSmallIcon(R.drawable.ic_stat_pleiad)
            .setSubText(host.takeIf { it.isNotEmpty() })
            .setWhen(at.takeIf { it > 0 } ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setCategory(if (channel == CH_ATTENTION) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (channel == CH_ATTENTION) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        if (settings.lockNames) {
            b.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        } else {
            // The lock screen shows only a generic sentence; the conversation name appears once unlocked
            b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            b.setPublicVersion(NotificationCompat.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat_pleiad)
                .setContentTitle(ctx.getString(R.string.app_name)).setContentText(publicText).setSubText(host.takeIf { it.isNotEmpty() }).build())
        }
        return b
    }

    private fun post(a: NotifyAction.Post, settings: NotifySettings): Notification {
        val body = a.title.ifBlank { ctx.getString(R.string.notify_untitled) }
        val b = base(if (a.attention) CH_ATTENTION else CH_DONE, a.key, a.host, a.at, settings, publicText(a.kind))
            .setContentTitle(title(a)).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(intent(a.hostId, a.session, false, a.key))
        if (a.silent) b.setOnlyAlertOnce(true).setSilent(true)
        return b.build()
    }

    private fun bundle(a: NotifyAction.Bundle, settings: NotifySettings): Notification {
        val title = ctx.resources.getQuantityString(R.plurals.notify_bundle, a.count, a.count)
        val names = a.titles.map { it.ifBlank { ctx.getString(R.string.notify_untitled) } }
        val shown = names.take(5)
        val style = NotificationCompat.InboxStyle().setBigContentTitle(title)
        for (n in shown) style.addLine(n)
        if (names.size > shown.size) style.setSummaryText(ctx.getString(R.string.notify_bundle_more, names.size - shown.size))
        val b = base(CH_DONE, a.key, a.host, a.at, settings, title)
            .setContentTitle(title).setContentText(names.take(3).joinToString(" / "))
            .setStyle(style)
            .setContentIntent(intent(a.hostId, a.session, true, a.key))
        if (a.silent) b.setOnlyAlertOnce(true).setSilent(true)
        return b.build()
    }
}
