package com.procway.pleiad.remote

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as tests/unit/remote-links.mjs (desktop linkTarget). */
class LinkPolicyTest {
    private val proxy = 51234

    private fun of(url: String): LinkTarget {
        val u = URI(url)
        return LinkPolicy.classify(u.scheme, u.host, u.port, u.path, u.rawUserInfo != null, proxy)
    }

    @Test fun snapshotOnTheProxyOnly() {
        assertEquals(LinkTarget.SNAPSHOT, of("http://127.0.0.1:$proxy/visualization-snapshot?sessionId=s&id=i"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/local-file?path=x"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/visualization-snapshot/x"))
        // Another port on the device is not this window's proxy
        assertEquals(LinkTarget.HOST_ONLY, of("http://127.0.0.1:${proxy + 1}/visualization-snapshot?id=i"))
        assertEquals(LinkTarget.HOST_ONLY, of("https://127.0.0.1:$proxy/visualization-snapshot?id=i"))
    }

    @Test fun webPagesGoToTheBrowser() {
        assertEquals(LinkTarget.EXTERNAL, of("https://example.com/a?b=c"))
        assertEquals(LinkTarget.EXTERNAL, of("http://example.org/"))
        assertEquals(LinkTarget.EXTERNAL, of("http://192.168.1.10:3000/"))
        assertEquals(LinkTarget.BLOCKED, of("https://user:pass@example.com/"))
        assertEquals(LinkTarget.BLOCKED, of("intent://scan/#Intent;scheme=zxing;end"))
        assertEquals(LinkTarget.BLOCKED, of("file:///sdcard/x.html"))
        assertEquals(LinkTarget.BLOCKED, of("javascript:alert(1)"))
    }

    @Test fun loopbackIsTheHostsPc() {
        for (u in listOf("http://localhost:3000/", "http://LOCALHOST/", "http://app.localhost:5173/", "http://127.0.0.1:5173/",
            "http://127.1.2.3/", "http://0.0.0.0:8080/", "http://[::1]:3000/", "https://localhost./")) {
            assertEquals(u, LinkTarget.HOST_ONLY, of(u))
        }
        assertTrue(LinkPolicy.isLoopbackHost("::ffff:7f00:1"))
        assertTrue(LinkPolicy.isLoopbackHost("[::ffff:127.0.0.1]"))
        assertFalse(LinkPolicy.isLoopbackHost("localhost.example.com"))
        assertFalse(LinkPolicy.isLoopbackHost("128.0.0.1"))
        assertFalse(LinkPolicy.isLoopbackHost(null))
    }
}
