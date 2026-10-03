package com.procway.pleiad.remote

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun loadNotifyVectors(): JSONObject {
    val path = System.getProperty("pleiad.notifyVectors") ?: "../../../tests/remote/notify-vectors.json"
    return JSONObject(File(path).readText(Charsets.UTF_8))
}

/** tests/remote/notify-vectors.json: the same file core/notify/crypto.mjs (tests/unit/push-notify.mjs) reads. */
class NotifyCryptoTest {
    private val v = loadNotifyVectors()
    private val key = hex(v.getString("key"))
    private val hostId = v.getString("hostId")
    private val deviceId = v.getString("deviceId")

    @Test fun opensWhatNodeSealed() {
        val cases = v.getJSONArray("cases")
        assertTrue(cases.length() >= 5)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val want = c.getJSONObject("notice")
            val got = NotifyCrypto.open(key, hostId, deviceId, c.getString("blob"))
            assertNotNull(c.getString("name"), got)
            assertEquals(want.getString("kind"), got!!.kind)
            assertEquals(want.getLong("seq"), got.seq)
            assertEquals(want.getLong("at"), got.at)
            assertEquals(want.getString("hostId"), got.hostId)
            assertEquals(want.getString("host"), got.host)
            assertEquals(want.getString("session"), got.session)
            assertEquals(want.getString("title"), got.title)
            assertEquals(want.optString("id").takeIf { it.isNotEmpty() }, got.id)
            assertEquals(want.optString("cancel").takeIf { it.isNotEmpty() }, got.cancel)
        }
    }

    @Test fun japaneseTitleSurvives() {
        val c = v.getJSONArray("cases").getJSONObject(0)
        assertEquals(c.getJSONObject("notice").getString("title"), NotifyCrypto.open(key, hostId, deviceId, c.getString("blob"))!!.title)
    }

    @Test fun refusesWrongKeyHostDeviceAndTampering() {
        val blob = v.getJSONArray("cases").getJSONObject(1).getString("blob")
        assertNull(NotifyCrypto.open(NotifyCrypto.generateKey(), hostId, deviceId, blob))
        assertNull(NotifyCrypto.open(key, "zzzzzzzzzzzzzzzzzzzzzzzzzz", deviceId, blob))
        assertNull(NotifyCrypto.open(key, hostId, "dOther", blob))
        val raw = java.util.Base64.getUrlDecoder().decode(blob)
        raw[40] = (raw[40].toInt() xor 1).toByte()
        assertNull(NotifyCrypto.open(key, hostId, deviceId, java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw)))
        assertNull(NotifyCrypto.open(key, hostId, deviceId, "short"))
        assertNull(NotifyCrypto.open(key, hostId, deviceId, ""))
    }

    @Test fun sealAndOpenRoundTrip() {
        val k = NotifyCrypto.generateKey()
        val json = JSONObject().put("v", 1).put("seq", 5).put("at", 1).put("kind", "done").put("hostId", hostId).put("host", "h").put("session", "s").put("title", "題")
        val blob = NotifyCrypto.seal(k, hostId, deviceId, json)
        assertEquals(java.util.Base64.getUrlDecoder().decode(blob).size, NotifyCrypto.BLOB_BYTES)
        assertEquals("題", NotifyCrypto.open(k, hostId, deviceId, blob)!!.title)
    }
}

class NotifyPlannerTest {
    private val host = "abcdefghijklmnopqrstuvwxyz"
    private var seq = 100L
    private val on = NotifySettings(enabled = true)
    private val p = NotifyPlanner()

    private fun notice(kind: String, session: String, title: String = "t-$session", id: String? = null, cancel: String? = null, hostId: String = host, s: Long = ++seq) =
        PushNotice(s, 1000 + s, kind, hostId, "main-pc", session, title, id, cancel)

    private fun slot(session: String, hostId: String = host) = NotifyPlanner.slotKey(hostId, session)

    @Test fun approvalPostsAttentionAndCancelRemoves() {
        val a = p.onNotice(notice(NoticeKind.APPROVAL, "s1", "migrate", id = "p1"), on)
        val post = a.single() as NotifyAction.Post
        assertEquals(slot("s1"), post.key); assertTrue(post.attention); assertEquals("migrate", post.title); assertEquals(1, post.pending)
        assertEquals("main-pc", post.host)
        val c = p.onNotice(notice(NoticeKind.CANCEL, "s1", id = "p1", cancel = "approval"), on)
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("s1"))), c)
    }

    @Test fun twoApprovalsInOneConversationShareOneNotification() {
        p.onNotice(notice(NoticeKind.APPROVAL, "s1", id = "p1"), on)
        val second = p.onNotice(notice(NoticeKind.QUESTION, "s1", id = "p2"), on).single() as NotifyAction.Post
        assertEquals(2, second.pending); assertEquals(NoticeKind.QUESTION, second.kind)
        val one = p.onNotice(notice(NoticeKind.CANCEL, "s1", id = "p1", cancel = "approval"), on).single() as NotifyAction.Post
        assertEquals(1, one.pending); assertTrue("updating the count does not alert again", one.silent)
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("s1"))), p.onNotice(notice(NoticeKind.CANCEL, "s1", id = "p2", cancel = "approval"), on))
    }

    @Test fun completionsBundleFromTheSecondOne() {
        val first = p.onNotice(notice(NoticeKind.DONE, "a"), on).single() as NotifyAction.Post
        assertFalse(first.attention); assertFalse(first.silent)
        val second = p.onNotice(notice(NoticeKind.DONE, "b"), on)
        assertEquals("the first one goes away, one bundle replaces it", listOf(NotifyAction.Cancel(slot("a"))), second.filterIsInstance<NotifyAction.Cancel>())
        val bundle = second.filterIsInstance<NotifyAction.Bundle>().single()
        assertEquals(2, bundle.count); assertEquals(listOf("t-b", "t-a"), bundle.titles); assertEquals("b", bundle.session); assertFalse(bundle.silent)
        val third = p.onNotice(notice(NoticeKind.DONE, "c"), on)
        assertEquals(listOf<NotifyAction>(), third.filterIsInstance<NotifyAction.Cancel>())
        assertEquals(3, (third.single() as NotifyAction.Bundle).count)
    }

    @Test fun bundleShrinksAndComesBackToOne() {
        p.onNotice(notice(NoticeKind.DONE, "a"), on); p.onNotice(notice(NoticeKind.DONE, "b"), on); p.onNotice(notice(NoticeKind.DONE, "c"), on)
        val seen = p.onNotice(notice(NoticeKind.CANCEL, "c", cancel = "seen"), on)
        assertTrue(seen.first() == NotifyAction.Cancel(slot("c")))
        val b2 = seen.filterIsInstance<NotifyAction.Bundle>().single()
        assertEquals(2, b2.count); assertTrue("shrinking a bundle is quiet", b2.silent)
        val seenB = p.onNotice(notice(NoticeKind.CANCEL, "b", cancel = "seen"), on)
        assertTrue(seenB.contains(NotifyAction.Cancel(bundleKeyOf())))
        val back = seenB.filterIsInstance<NotifyAction.Post>().single()
        assertEquals(slot("a"), back.key); assertTrue("coming back from a bundle is quiet", back.silent); assertFalse(back.attention)
    }

    private fun bundleKeyOf() = NotifyPlanner.bundleKey(host)

    @Test fun failuresAreSeparateFromBundledCompletions() {
        p.onNotice(notice(NoticeKind.DONE, "a"), on); p.onNotice(notice(NoticeKind.DONE, "b"), on)
        val f = p.onNotice(notice(NoticeKind.FAILED, "x"), on).single() as NotifyAction.Post
        assertTrue(f.attention); assertEquals(NoticeKind.FAILED, f.kind)
        val seen = p.onNotice(notice(NoticeKind.CANCEL, "x", cancel = "seen"), on)
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("x"))), seen)
    }

    @Test fun limitReadyRequiresAttentionAndFollowsFailurePreference() {
        val post = p.onNotice(notice(NoticeKind.LIMIT_READY, "s1"), on).single() as NotifyAction.Post
        assertEquals(NoticeKind.LIMIT_READY, post.kind)
        assertTrue(post.attention)
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("s1"))),
            p.onNotice(notice(NoticeKind.CANCEL, "s1", cancel = "seen"), on))
        val noFailed = NotifySettings(enabled = true, failed = false)
        assertTrue(p.onNotice(notice(NoticeKind.LIMIT_READY, "s2"), noFailed).isEmpty())
        val guarded = p.onNotice(notice(NoticeKind.LIMIT_GUARDED, "s3"), on).single() as NotifyAction.Post
        assertTrue(guarded.attention)
        assertTrue(p.onNotice(notice(NoticeKind.LIMIT_GUARDED, "s4"), noFailed).isEmpty())
    }

    @Test fun anApprovalOverwritesAFinishedConversationAndLeavesTheBundle() {
        p.onNotice(notice(NoticeKind.DONE, "a"), on); p.onNotice(notice(NoticeKind.DONE, "b"), on)
        val out = p.onNotice(notice(NoticeKind.APPROVAL, "a", id = "p9"), on)
        assertTrue(out.any { it is NotifyAction.Post && it.key == slot("a") && it.attention })
        assertTrue("one completion left: the bundle goes, the single one is back", out.any { it == NotifyAction.Cancel(bundleKeyOf()) } && out.any { it is NotifyAction.Post && it.key == slot("b") })
    }

    @Test fun replaysAndOldSequenceNumbersAreIgnored() {
        val n = notice(NoticeKind.APPROVAL, "s1", id = "p1")
        assertEquals(1, p.onNotice(n, on).size)
        assertEquals(0, p.onNotice(n, on).size)
        assertEquals(0, p.onNotice(notice(NoticeKind.APPROVAL, "s2", id = "p2", s = n.seq - 5), on).size)
        assertEquals(1, p.onNotice(notice(NoticeKind.APPROVAL, "s2", id = "p2", s = n.seq + 5), on).size)
        val other = p.onNotice(notice(NoticeKind.APPROVAL, "s3", id = "p3", hostId = "bbbbbbbbbbbbbbbbbbbbbbbbbb", s = 1), on)
        assertEquals("sequence numbers are per host", 1, other.size)
    }

    @Test fun settingsAreEnforcedHereToo() {
        val off = NotifySettings(enabled = false)
        assertEquals(0, p.onNotice(notice(NoticeKind.APPROVAL, "s1", id = "p1"), off).size)
        val noReply = NotifySettings(enabled = true, reply = false)
        assertEquals(0, p.onNotice(notice(NoticeKind.APPROVAL, "s1", id = "p1"), noReply).size)
        assertEquals(0, p.onNotice(notice(NoticeKind.QUESTION, "s1", id = "p2"), noReply).size)
        assertEquals(1, p.onNotice(notice(NoticeKind.FAILED, "s2"), noReply).size)
        val noFailed = NotifySettings(enabled = true, failed = false)
        assertEquals(0, p.onNotice(notice(NoticeKind.FAILED, "s3"), noFailed).size)
        val noDone = NotifySettings(enabled = true, done = false)
        assertEquals(0, p.onNotice(notice(NoticeKind.DONE, "s4"), noDone).size)
        // a cancel is applied even when notifications were turned off since
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("s2"))), p.onNotice(notice(NoticeKind.CANCEL, "s2", cancel = "seen"), off))
    }

    @Test fun aCancelWithoutStateStillCancels() {
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("lost"))), p.onNotice(notice(NoticeKind.CANCEL, "lost", id = "p1", cancel = "approval"), on))
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(slot("lost2"))), p.onNotice(notice(NoticeKind.CANCEL, "lost2", cancel = "seen"), on))
    }

    @Test fun anApprovalCancelDoesNotRemoveACompletion() {
        p.onNotice(notice(NoticeKind.DONE, "a"), on)
        assertEquals(0, p.onNotice(notice(NoticeKind.CANCEL, "a", id = "px", cancel = "approval"), on).size)
        assertEquals(0, p.onNotice(notice(NoticeKind.CANCEL, "a", cancel = "bogus"), on).size)
    }

    @Test fun tappingOpensAndBundleTapClearsAllCompletions() {
        p.onNotice(notice(NoticeKind.DONE, "a"), on); p.onNotice(notice(NoticeKind.DONE, "b"), on)
        val one = p.opened(host, "b", false)
        assertTrue("the other completion comes back alone", one.contains(NotifyAction.Cancel(bundleKeyOf())) && one.any { it is NotifyAction.Post && it.key == slot("a") })
        p.onNotice(notice(NoticeKind.DONE, "c"), on)
        val cleared = p.opened(host, null, true)
        assertEquals(listOf<NotifyAction>(NotifyAction.Cancel(bundleKeyOf())), cleared)
        assertEquals("nothing is left to bundle", 1, (p.onNotice(notice(NoticeKind.DONE, "d"), on).single() as NotifyAction.Post).let { 1 })
    }

    @Test fun settingsJsonRoundTrip() {
        val s = NotifySettings(enabled = true, reply = false, failed = true, done = false, lockNames = true, skipPc = false)
        assertEquals(s, NotifySettings.fromJson(s.toJson()))
        assertEquals(NotifySettings(), NotifySettings.fromJson(JSONObject()))
        assertEquals(NotifySettings(), NotifySettings.fromJson(null))
    }

    private fun assertFalse(b: Boolean) = org.junit.Assert.assertFalse(b)
    private fun assertFalse(msg: String, b: Boolean) = org.junit.Assert.assertFalse(msg, b)
    private fun assertTrue(msg: String, b: Boolean) = org.junit.Assert.assertTrue(msg, b)
    private fun assertTrue(b: Boolean) = org.junit.Assert.assertTrue(b)
}
