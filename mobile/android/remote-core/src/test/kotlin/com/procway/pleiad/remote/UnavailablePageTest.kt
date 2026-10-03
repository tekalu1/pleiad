package com.procway.pleiad.remote

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The notice page the proxy shows while the host is unreachable (docs/remote.md §8.2): a way back to the host list. */
class UnavailablePageTest {
    private val loop = Loop("test-loop")
    private val creds = HostCreds("h", ByteArray(32), "https://relay.example", "d", "t", "desk")

    @After fun done() = loop.shutdown()

    private fun page(state: String, texts: ProxyTexts = DefaultTexts) =
        DeviceProxy(loop, creds, KeyPair.generate(), texts = texts).unavailablePage(state)

    @Test fun hasAButtonBackToTheHostList() {
        for (state in listOf("offline", "host-offline", "revoked")) {
            val html = page(state)
            // Hidden until the app's host window provides window.backToHosts; the page has no CSP of its own, so the inline script runs
            assertTrue(state, html.contains("""<button type="button" id="back-to-hosts" hidden>Back to hosts</button>"""))
            assertTrue(state, html.contains("window.backToHosts()"))
            assertTrue(state, html.contains("typeof window.backToHosts==='function'"))
        }
    }

    @Test fun theButtonTextComesFromTheAppAndIsEscaped() {
        val texts = object : ProxyTexts by DefaultTexts {
            override fun backToHosts() = "<b>一覧</b>"
        }
        assertTrue(page("offline", texts).contains(">&lt;b&gt;一覧&lt;/b&gt;</button>"))
    }

    @Test fun keepsTheAutoRefreshExceptWhenRevoked() {
        assertTrue(page("offline").contains("""<meta http-equiv="refresh" content="5">"""))
        assertFalse(page("revoked").contains("http-equiv=\"refresh\""))
        assertEquals(-1, page("offline").indexOf("Content-Security-Policy"))
    }
}
