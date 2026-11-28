package dev.hatch.app.core

import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/** A question handed to another thread (the main thread) for a yes or no. */
object HandOff {
    private const val WAITING = 0
    private const val STARTED = 1
    private const val GIVEN_UP = 2

    /**
     * Posts `block` with `post` and waits up to `timeoutMillis` for its
     * answer. One it gave up on never runs afterwards, so "no" is final; one
     * that already started is waited for, so "yes" is never lost.
     */
    fun ask(post: (Runnable) -> Unit, timeoutMillis: Long, block: () -> Boolean): Boolean =
        ask(post, timeoutMillis, {}, block)

    /** `ask`, telling `waitedOut` when the timed wait ended without an answer (for tests). */
    internal fun ask(
        post: (Runnable) -> Unit,
        timeoutMillis: Long,
        waitedOut: () -> Unit,
        block: () -> Boolean,
    ): Boolean {
        // Waiting, then either started or given up on: never both.
        val state = AtomicInteger(WAITING)
        val task = FutureTask { state.compareAndSet(WAITING, STARTED) && block() }
        post(task)
        val answer =
            try {
                return task.get(timeoutMillis, TimeUnit.MILLISECONDS)
            } catch (_: ExecutionException) {
                return false
            } catch (_: TimeoutException) {
                null
            } catch (_: InterruptedException) {
                // Interrupted like timed out, and the caller keeps the interrupt.
                Thread.currentThread().interrupt()
                null
            }
        if (answer != null) return answer
        waitedOut()
        return if (state.compareAndSet(WAITING, GIVEN_UP)) false else finish(task)
    }

    /** The answer of a task that already started, however long it takes. */
    private fun finish(task: FutureTask<Boolean>): Boolean {
        var interrupted = Thread.interrupted()
        try {
            while (true) {
                try {
                    return task.get()
                } catch (_: InterruptedException) {
                    interrupted = true
                } catch (_: ExecutionException) {
                    return false
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt()
        }
    }
}
