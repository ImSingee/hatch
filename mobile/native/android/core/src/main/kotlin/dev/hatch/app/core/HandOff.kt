package dev.hatch.app.core

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
    fun ask(post: (Runnable) -> Unit, timeoutMillis: Long, block: () -> Boolean): Boolean {
        // Waiting, then either started or given up on: never both.
        val state = AtomicInteger(WAITING)
        val task = FutureTask { state.compareAndSet(WAITING, STARTED) && block() }
        post(task)
        return try {
            task.get(timeoutMillis, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            if (state.compareAndSet(WAITING, GIVEN_UP)) false else runCatching { task.get() }.getOrDefault(false)
        } catch (_: Exception) {
            false
        }
    }
}
