package dev.hatch.app.core

import dev.hatch.app.core.TrustRefreshTest.FakeStore
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue

class TrustDirectoryTest {
    private val dir = kotlin.io.path.createTempDirectory().toFile()
    private val state = File(dir, "nsh-trust.json")
    private val opened = mutableListOf<FakeStore>()
    private var failSave = false

    private fun directory() =
        TrustDirectory(
            TrustRefresh(File(dir, "sequence"), state),
            open = { FakeStore.opened(state).also { it.failSave = failSave; opened += it } },
            fresh = { FakeStore() },
        )

    private fun material(sequence: Int) =
        RuntimeTrust(initialized = true, roots = listOf("root"), revocations = "signed:$sequence", revocationSequence = sequence)

    @Test
    fun sessionsShareOneStoreThatTrustsTheRoots() {
        val trust = directory()
        val first = trust.use(material(1), { true }) { it }
        // Another session for the same instance (signed in again): the same store.
        val second = trust.use(material(1), { true }) { it }
        assertSame(first, second)
        assertEquals(listOf("root"), opened.single().roots)
    }

    @Test
    fun aStoreOpenedAgainToSaveAListTrustsTheRoots() {
        val trust = directory()
        failSave = true
        assertFailsWith<IllegalStateException> { trust.use(material(4), { true }) { it } }
        failSave = false
        val used = trust.use(material(4), { true }) { it }
        // Each store that kept list 4 only in memory was closed and replaced; the
        // last one opened again from disk saved it.
        assertEquals(3, opened.size)
        assertSame(opened.last(), used)
        assertEquals(listOf(true, true, false), opened.map { it.closed })
        assertEquals(listOf("root"), used.roots)
        assertEquals(4, FakeStore.opened(state).sequence)
    }

    @Test
    fun aSessionThatEndedNeitherRefreshesNorUsesTheStore() {
        val trust = directory()
        var used = false
        val error = assertFailsWith<PlatformException> { trust.use(material(1), { false }) { used = true } }
        assertEquals("unauthenticated", error.code)
        assertEquals(false, used)
        assertEquals(0, opened.size)
    }

    @Test
    fun workOnTheStoreNeverOverlaps() {
        val trust = directory()
        val verifying = CountDownLatch(1)
        val release = CountDownLatch(1)
        val order = java.util.Collections.synchronizedList(mutableListOf<String>())
        // A retired session still verifying a package…
        val first = thread {
            trust.use(material(1), { true }) {
                verifying.countDown()
                release.await(5, TimeUnit.SECONDS)
                order += "first done"
            }
        }
        assertTrue(verifying.await(5, TimeUnit.SECONDS))
        // …and the new session for the same instance, with a newer list.
        val second = thread { trust.use(material(2), { true }) { order += "second" } }
        Thread.sleep(200)
        assertEquals(emptyList<String>(), order.toList())
        release.countDown()
        first.join(5_000)
        second.join(5_000)
        assertEquals(listOf("first done", "second"), order.toList())
        assertEquals(2, FakeStore.opened(state).sequence)
    }
}
