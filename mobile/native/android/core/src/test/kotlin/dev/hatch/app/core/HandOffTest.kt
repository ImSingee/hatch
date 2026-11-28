package dev.hatch.app.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HandOffTest {
    @Test
    fun answersWithWhatTheOtherThreadSaid() {
        assertEquals(true, HandOff.ask({ thread { it.run() } }, 1_000) { true })
        assertEquals(false, HandOff.ask({ thread { it.run() } }, 1_000) { false })
    }

    @Test
    fun aQuestionItGaveUpOnNeverRunsLater() {
        // The main thread is busy: the task waits in its queue past the timeout.
        var queued: Runnable? = null
        var ran = false
        assertEquals(false, HandOff.ask({ queued = it }, 50) { ran = true; true })
        queued!!.run()
        assertFalse(ran)
    }

    @Test
    fun aQuestionAlreadyBeingAnsweredIsWaitedFor() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val answer = AtomicReference<Boolean>()
        val asking = thread {
            answer.set(
                HandOff.ask({ thread { it.run() } }, 50) {
                    started.countDown()
                    release.await(5, TimeUnit.SECONDS)
                }
            )
        }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        // Well past its timeout, the caller is still waiting for the answer
        // that started in time, not answering "no".
        asking.join(500)
        assertTrue(asking.isAlive)
        release.countDown()
        asking.join(5_000)
        assertEquals(true, answer.get())
    }

    @Test
    fun anInterruptedCallerGivesUpAndTheQuestionNeverRunsLater() {
        val posted = CountDownLatch(1)
        var queued: Runnable? = null
        var ran = false
        val answer = AtomicReference<Boolean>()
        val stillInterrupted = AtomicReference<Boolean>()
        val asking = thread {
            answer.set(HandOff.ask({ queued = it; posted.countDown() }, 5_000) { ran = true; true })
            stillInterrupted.set(Thread.currentThread().isInterrupted)
        }
        assertTrue(posted.await(5, TimeUnit.SECONDS))
        asking.interrupt()
        asking.join(5_000)
        assertEquals(false, answer.get())
        assertEquals(true, stillInterrupted.get())
        queued!!.run()
        assertFalse(ran)
    }
}
