package dev.hatch.app.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
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
        assertEquals(false, ran)
    }

    @Test
    fun aQuestionAlreadyBeingAnsweredIsWaitedFor() {
        val started = CountDownLatch(1)
        // The answer has begun before the timeout and ends well after it.
        val answer =
            HandOff.ask({ task ->
                thread { task.run() }
                assertTrue(started.await(1, TimeUnit.SECONDS))
            }, 50) {
                started.countDown()
                Thread.sleep(300)
                true
            }
        assertEquals(true, answer)
    }
}
