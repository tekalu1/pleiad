package dev.pleiad.app.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePolicyTest {
    private fun host(id: String, revokedAt: Long? = null) = HostRecord(id, "pc-$id", "", "https://relay.example", "key", "dev", 0, 1L, 2L, revokedAt)
    private val hosts = listOf(host("a"), host("b", revokedAt = 5L))

    private fun decide(saved: String?, fresh: Boolean = true, launcher: Boolean = true, list: List<HostRecord> = hosts) =
        ResumePolicy.decide(saved, list, fresh, launcher)

    @Test fun opensTheSavedHostOnAFreshLauncherStart() {
        assertEquals(ResumeDecision("a", false), decide("a"))
    }

    @Test fun showsTheListWhenNothingIsSaved() {
        assertEquals(ResumeDecision(null, false), decide(null))
        assertEquals(ResumeDecision(null, false), decide(""))
    }

    @Test fun showsTheListWhenRestoredOrOpenedByAPairLink() {
        assertEquals(ResumeDecision(null, false), decide("a", fresh = false))
        assertEquals(ResumeDecision(null, false), decide("a", launcher = false))
    }

    @Test fun forgetsAHostThatIsGoneOrRevoked() {
        assertEquals(ResumeDecision(null, true), decide("gone"))
        assertEquals(ResumeDecision(null, true), decide("b"))
        assertEquals(ResumeDecision(null, true), decide("a", list = emptyList()))
        // Even when it would not have opened anyway: it does not qualify any more
        assertEquals(ResumeDecision(null, true), decide("b", fresh = false))
    }
}
