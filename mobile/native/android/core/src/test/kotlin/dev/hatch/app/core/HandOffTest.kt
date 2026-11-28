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
        val waitedOut = CountDownLatch(1)
        // The answer has begun before the caller waits, and ends only once
        // the caller's timed wait is over.
        val post = { task: Runnable ->
            thread { task.run() }
            assertTrue(started.await(5, TimeUnit.SECONDS))
        }
        val answer =
            HandOff.ask(post, 50, { waitedOut.countDown() }) {
                started.countDown()
                waitedOut.await(5, TimeUnit.SECONDS)
            }
        assertEquals(0, waitedOut.count)
        assertEquals(true, answer)
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
