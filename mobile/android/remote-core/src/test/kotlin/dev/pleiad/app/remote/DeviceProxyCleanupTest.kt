package dev.pleiad.app.remote

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProxyCleanupTest {
    @Test fun queuedWebSocketMessagesReturnTheirCredit() {
        val returned = AtomicInteger()
        val q = LinkedBlockingQueue<DeviceProxy.Ev>()
        q.put(DeviceProxy.Ev.Message(byteArrayOf(1), true) { returned.incrementAndGet() })
        q.put(DeviceProxy.Ev.End)

        releaseQueuedWsMessages(q)

        assertEquals(1, returned.get())
        assertEquals(0, q.size)
    }
}
