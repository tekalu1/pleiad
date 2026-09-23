package com.procway.pleiad.remote

import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * A single-threaded event loop. Channel, Stream and DeviceLink state is confined to it (the Kotlin stand-in for
 * Node's event loop that the JS modules rely on). Socket I/O happens on other threads and posts here.
 */
class Loop(name: String = "pleiad-remote") {
    @Volatile private var thread: Thread? = null
    private val exec = ScheduledThreadPoolExecutor(1) { r ->
        Thread(r, name).also { it.isDaemon = true; thread = it }
    }.apply { removeOnCancelPolicy = true }

    var onError: (Throwable) -> Unit = { it.printStackTrace() }

    val inLoop: Boolean get() = Thread.currentThread() === thread

    fun post(fn: () -> Unit) {
        if (exec.isShutdown) return
        try {
            exec.execute { run(fn) }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
    }

    /** Run now if already on the loop, otherwise post. */
    fun run(fn: () -> Unit) {
        try { fn() } catch (t: Throwable) { onError(t) }
    }

    fun exec(fn: () -> Unit) { if (inLoop) run(fn) else post(fn) }

    fun schedule(ms: Long, fn: () -> Unit): Cancellable {
        if (exec.isShutdown) return Cancellable {}
        return try {
            val f: ScheduledFuture<*> = exec.schedule({ run(fn) }, ms, TimeUnit.MILLISECONDS)
            Cancellable { f.cancel(false) }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            Cancellable {}
        }
    }

    /** Run on the loop and wait for the result (never call from the loop itself). */
    fun <R> call(timeoutMs: Long = 30_000, fn: () -> R): R {
        check(!inLoop) { "Loop.call from the loop thread would deadlock" }
        return exec.submit<R> { fn() }.get(timeoutMs, TimeUnit.MILLISECONDS)
    }

    fun shutdown() { exec.shutdownNow() }
}

fun interface Cancellable { fun cancel() }
