package dev.hatch.app.core

import java.io.File

/**
 * The Desk's run rules for a phone or tablet, without the engines: which
 * Apps run, which one goes first when the limit needs a place, and which
 * have waited off screen long enough to stop. A port of the web Desk's
 * `AppSessionStore` (`src/components/desk/app-sessions.tsx`), as the iOS
 * runtime's `RunLedger`:
 * - one engine per App; opening a running App shows it again;
 * - at the limit (3 on a phone, 6 on a tablet) the App shown least
 *   recently stops first (an App on screen counts as shown now);
 * - an App off screen (its page closed, or the whole app in the
 *   background) starts its background time; when it has waited the user's
 *   background minutes it stops;
 * - a stopped App's route is remembered, so it reopens there.
 *
 * Times are milliseconds on any clock that only moves forward.
 */
class RunLedger(limit: Int, backgroundMinutes: Int = DEFAULT_BACKGROUND_MINUTES) {
    companion object {
        const val PHONE_LIMIT = 3
        const val TABLET_LIMIT = 6
        const val DEFAULT_BACKGROUND_MINUTES = 5
    }

    val limit = maxOf(1, limit)
    var backgroundTimeoutMillis = maxOf(1, backgroundMinutes) * 60_000L
        private set

    private val runningApps = mutableListOf<String>()
    val running: List<String>
        get() = runningApps.toList()

    private val shownAt = mutableMapOf<String, Long>()
    private val hiddenAt = mutableMapOf<String, Long>()
    private var visible = emptySet<String>()
    private val remembered = mutableMapOf<String, String>()
    private val routes = mutableMapOf<String, String>()
    private var clock = 0L

    fun setBackgroundMinutes(minutes: Int) {
        backgroundTimeoutMillis = maxOf(1, minutes) * 60_000L
    }

    private fun tick() = ++clock

    fun isRunning(app: String) = app in runningApps

    /** The route an App reopens at: its live one while it runs, else the one it had when it stopped. */
    fun route(app: String): String? = routes[app] ?: remembered[app]

    fun setRoute(route: String, app: String) {
        if (isRunning(app)) routes[app] = route
    }

    /** Starts `app` and returns the Apps to stop for it, least recently shown first. */
    fun start(app: String, route: String, now: Long): List<String> {
        if (isRunning(app)) return emptyList()
        val victims = mutableListOf<String>()
        while (runningApps.size >= limit) {
            val victim = runningApps.minByOrNull { rank(it) } ?: break
            victims.add(victim)
            stopped(victim)
        }
        runningApps.add(app)
        routes[app] = route
        remembered.remove(app)
        shownAt[app] = tick()
        if (app !in visible) hiddenAt[app] = now
        return victims
    }

    private fun rank(app: String): Double = if (app in visible) Double.POSITIVE_INFINITY else (shownAt[app] ?: 0L).toDouble()

    private fun stopped(app: String) {
        routes[app]?.let { remembered[app] = it }
        runningApps.remove(app)
        routes.remove(app)
        hiddenAt.remove(app)
        shownAt.remove(app)
    }

    /** Stops `app` (closed, failed, or signed out) and remembers its route. */
    fun stop(app: String) {
        if (isRunning(app)) stopped(app)
    }

    /** Forgets everything (another instance or account). */
    fun reset() {
        runningApps.clear()
        shownAt.clear()
        hiddenAt.clear()
        visible = emptySet()
        remembered.clear()
        routes.clear()
    }

    /** Which Apps are on screen now. */
    fun setVisible(apps: Set<String>, now: Long) {
        for (app in runningApps) {
            if (app in apps) hiddenAt.remove(app) else if (app !in hiddenAt) hiddenAt[app] = now
            if ((app in apps) != (app in visible)) shownAt[app] = tick()
        }
        visible = apps
    }

    /** Stops every App that has waited off screen for the background time; returns them and when the next is due. */
    fun stopWaiting(now: Long): Pair<List<String>, Long?> {
        val expired = runningApps.filter { app -> hiddenAt[app]?.let { it + backgroundTimeoutMillis <= now } == true }
        expired.forEach { stopped(it) }
        val next = runningApps.mapNotNull { app -> hiddenAt[app]?.let { it + backgroundTimeoutMillis } }.minOrNull()
        return expired to next
    }
}

/**
 * Everything a runtime sets on an NSH view before it runs an App's package.
 * Built in one place, so every engine gets the same grant and limits.
 */
data class EngineSetup(
    val heapMegabytes: Int,
    /** The capabilities document for `setGrantedCapabilities`: never null. */
    val grant: String,
    /** `host.params`: the platform, the route the App opens at and the package's build. */
    val params: Map<String, Any>,
    val storageDirectory: File,
    val cacheDirectory: File,
) {
    companion object {
        /** The JS heap of one engine, as on the web Desk. */
        const val HEAP_MEGABYTES = 96

        fun of(
            platform: String,
            route: String,
            packageBuild: Int,
            appId: String,
            instanceDirectory: File,
            cacheRoot: File,
        ) =
            EngineSetup(
                heapMegabytes = HEAP_MEGABYTES,
                grant = HostCalls.grant,
                params = mapOf("platform" to platform, "route" to route, "packageBuild" to packageBuild),
                storageDirectory = File(instanceDirectory, "storage/$appId"),
                cacheDirectory = File(cacheRoot, "nsh"),
            )
    }
}

/** A stable directory name for an instance origin (FNV-1a 64, as on iOS). */
object InstanceKey {
    fun of(origin: String): String {
        var hash = -0x340d631b7bdddcdbL
        for (byte in origin.lowercase().toByteArray()) {
            hash = hash xor (byte.toLong() and 0xff)
            hash *= 0x100000001b3L
        }
        return java.lang.Long.toUnsignedString(hash, 16)
    }
}
