package dev.hatch.app.runtime

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ViewGroup
import com.longbridge.nsh.NshCacheOptions
import com.longbridge.nsh.NshPackage
import com.longbridge.nsh.NshTrust
import com.longbridge.nsh.NshView
import dev.hatch.app.core.AppScope
import dev.hatch.app.core.BridgeShell
import dev.hatch.app.core.EngineSetup
import dev.hatch.app.core.HostBridge
import dev.hatch.app.core.HostCalls
import dev.hatch.app.core.HostEvents
import dev.hatch.app.core.InstanceKey
import dev.hatch.app.core.Json
import dev.hatch.app.core.PackageHasher
import dev.hatch.app.core.PlatformClient
import dev.hatch.app.core.PlatformException
import dev.hatch.app.core.RunLedger
import dev.hatch.app.core.UrlConnectionTransport
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

class Sha256Hasher : PackageHasher {
    private val digest = MessageDigest.getInstance("SHA-256")

    override fun update(data: ByteArray) = digest.update(data)

    override fun hexDigest(): String = digest.digest().joinToString("") { "%02x".format(it) }
}

/** What a view showing an App hears about it (on the main thread). */
interface AppEngineListener {
    fun engineStateChanged(state: AppEngineState)

    fun engineTitleChanged(title: String?)

    fun engineRouteChanged(route: String)
}

/** What the host app hears from every engine (on the main thread). */
interface AppEngineHostDelegate {
    /** An App asked to open another App (`hatch.nav.open`). */
    fun openApp(slug: String, route: String): Boolean

    /** The instance refused the session's credential. */
    fun unauthorized()
}

sealed class AppEngineState {
    object Loading : AppEngineState()

    data class Running(val build: Int) : AppEngineState()

    /** A newer deployment is live; reloading runs it. */
    data class UpdateAvailable(val build: Int) : AppEngineState()

    /** `code` is the platform's (`APP_NOT_NATIVE`, `APP_PACKAGE_UNAVAILABLE`) or the Connect code. */
    data class Failed(val code: String, val message: String) : AppEngineState()
}

/** Sets an App's limits, grant, launch parameters and directories: what every engine gets before it runs. */
fun NshView.apply(setup: EngineSetup) {
    setLimits(setup.heapMegabytes, 0, 0, 0, 0)
    check(setGrantedCapabilities(setup.grant)) { "NSH refused the grant." }
    setParams(setup.params)
    setup.storageDirectory.mkdirs()
    setStorageDirectory(setup.storageDirectory)
    setCacheOptions(NshCacheOptions.builder().location(setup.cacheDirectory).build())
}

/**
 * The engines of every App the user opened, one per App, owned here (not by
 * a view) so an App keeps running while its screen is gone. Applies the
 * Desk's rules ([RunLedger]): a limit of running Apps (3 on a phone, 6 on a
 * tablet), and a hidden App stops once it has waited the user's background
 * minutes, measured from when the whole app went to the background too
 * (Android does not suspend the engines itself). A stopped App reopens at
 * the route it was left on.
 *
 * An engine's views belong to the activity it started in; when that activity
 * goes away for good, its engines stop as if they had waited too long.
 *
 * Every engine runs its App's signed package from the instance
 * (`GetAppPackage`), verified against the instance's roots
 * (`GetAppRuntimeTrust`) in a trust store of its own per instance, with a
 * 96 MB heap and exactly the `{ host: [...] }` grant. Use it on the main
 * thread.
 */
object AppEngineManager {
    private class Engine(val appId: String, val view: NshView, val bridge: HostBridge, val activity: Activity?) {
        var state: AppEngineState = AppEngineState.Loading
            private set
        var title: String? = null
        var build: Int? = null
        var listener: AppEngineListener? = null

        fun moveTo(next: AppEngineState) {
            state = next
            listener?.engineStateChanged(next)
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val network = Executors.newFixedThreadPool(4) { Thread(it, "hatch-app-engine").apply { isDaemon = true } }
    private val transport = UrlConnectionTransport()
    private val engines = mutableMapOf<String, Engine>()
    /**
     * Where each App is shown now; kept when its engine stops, so an App
     * stopped while its page stayed open starts again when the app returns.
     */
    private val containers = mutableMapOf<String, ViewGroup>()
    private val listeners = mutableMapOf<String, java.lang.ref.WeakReference<AppEngineListener>>()
    private var ledger: RunLedger? = null
    private var application: Application? = null
    private var started = 0
    private var origin: String? = null
    @Volatile private var token: String? = null
    private var themeJson: String? = null
    private var trust: NshTrust? = null
    @Volatile private var trustLoaded = false
    private var lastVisible = emptySet<String>()
    private val waitCheck = Runnable { scheduleWait() }

    var delegate: AppEngineHostDelegate? = null

    /** Once, with the application: follows the activities to tell foreground from background. */
    fun install(application: Application) {
        if (this.application != null) return
        this.application = application
        val tablet = application.resources.configuration.smallestScreenWidthDp >= 600
        ledger = RunLedger(if (tablet) RunLedger.TABLET_LIMIT else RunLedger.PHONE_LIMIT)
        application.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityStarted(activity: Activity) {
                    started += 1
                    if (started == 1) {
                        // A frozen process runs no timer: settle the background
                        // time first, while every App still counts as hidden.
                        ledger().stopWaiting(now()).first.forEach { stopEngine(it) }
                        // Apps whose page stayed open while they waited out their
                        // time in the background start again where they were.
                        for ((appId, container) in containers.toMap()) {
                            if (appId in engines || !container.isAttachedToWindow) continue
                            open(container.context, appId, null, listeners[appId]?.get())
                            attach(appId, container)
                        }
                        updateVisibility(refresh = true)
                    }
                }

                override fun onActivityStopped(activity: Activity) {
                    started = maxOf(0, started - 1)
                    if (started == 0) updateVisibility()
                }

                override fun onActivityDestroyed(activity: Activity) {
                    if (activity.isChangingConfigurations) return
                    for (engine in engines.values.filter { it.activity === activity }) stop(engine.appId)
                }

                override fun onActivityCreated(activity: Activity, state: Bundle?) {}

                override fun onActivityResumed(activity: Activity) {}

                override fun onActivityPaused(activity: Activity) {}

                override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            }
        )
    }

    private fun ledger(): RunLedger = ledger ?: RunLedger(RunLedger.PHONE_LIMIT).also { ledger = it }

    private fun now() = SystemClock.elapsedRealtime()

    private fun instanceDirectory(context: Context): File? =
        origin?.let { File(context.filesDir, "hatch-apps/${InstanceKey.of(it)}") }

    private fun cacheRoot(context: Context): File? = origin?.let { File(context.cacheDir, "hatch-apps/${InstanceKey.of(it)}") }

    /** The signed-in instance and its session credential. Another instance, or none, stops every App. */
    fun configure(origin: String?, token: String?) {
        if (origin != this.origin || token == null) {
            stopAll()
            containers.clear()
            listeners.clear()
            ledger().reset()
            trust?.close()
            trust = null
            trustLoaded = false
        }
        this.origin = origin?.trimEnd('/')
        this.token = token
    }

    /** The user's background minutes (`GetDeskPreferences`). */
    fun setBackgroundMinutes(minutes: Int) {
        ledger().setBackgroundMinutes(minutes)
        scheduleWait()
    }

    /** The NSH theme every App gets (`hatch.theme.get`, `hatch.theme`). */
    fun setTheme(json: String?) {
        themeJson = json
        val theme = json?.let { runCatching { Json.parse(it) }.getOrNull() }
        for (engine in engines.values) engine.view.send(HostEvents.THEME, mapOf("theme" to theme))
    }

    private fun client(): PlatformClient? {
        val origin = origin ?: return null
        return PlatformClient(origin, { token }, transport)
    }

    /** The state of `appId`'s engine, starting it (at its remembered route) in `context`'s activity if it does not run. */
    fun open(context: Context, appId: String, route: String?, listener: AppEngineListener?): AppEngineState {
        listeners[appId] = java.lang.ref.WeakReference(listener)
        engines[appId]?.let { engine ->
            engine.listener = listener
            if (route != null) navigate(appId, route)
            return engine.state
        }
        val origin = origin
        val scope = AppScope.of(appId, "", emptyMap(), false)
        val instanceDirectory = instanceDirectory(context)
        val cacheRoot = cacheRoot(context)
        if (origin == null || scope == null || instanceDirectory == null || cacheRoot == null) {
            val failed = AppEngineState.Failed("unauthenticated", "Sign in to this instance again.")
            listener?.engineStateChanged(failed)
            return failed
        }
        val start = route ?: ledger().route(appId) ?: ""
        for (victim in ledger().start(appId, start, now())) stopEngine(victim)
        val shell = EngineShell(appId)
        val bridge = HostBridge(origin, scope, { token }, transport, shell)
        val engine = Engine(appId, NshView(context), bridge, context as? Activity)
        engine.listener = listener
        engines[appId] = engine
        network.execute { load(engine, start, instanceDirectory, cacheRoot) }
        updateVisibility()
        return engine.state
    }

    @Synchronized
    private fun loadTrust(client: PlatformClient, directory: File): NshTrust {
        val store = trust ?: NshTrust(File(directory, "trust")).also { trust = it }
        if (trustLoaded) return store
        val material = client.runtimeTrust()
        if (!material.initialized) {
            throw PlatformException("failed_precondition", message = "This instance has no native App keys yet.")
        }
        for (root in material.roots) check(store.addRoot(root)) { "The instance's root key is not valid." }
        // The store takes only a newer list (it refuses one it has already):
        // apply each sequence once, and refuse to go on if a newer one fails.
        val applied = File(directory, "trust/revocations-sequence")
        val known = runCatching { applied.readText().trim().toInt() }.getOrDefault(0)
        val revocations = material.revocations
        if (revocations != null && material.revocationSequence > known) {
            check(store.updateRevocations(revocations)) { "The instance's revocation list is not valid." }
            applied.writeText(material.revocationSequence.toString())
        }
        trustLoaded = true
        return store
    }

    private fun load(engine: Engine, route: String, instanceDirectory: File, cacheRoot: File) {
        try {
            val client = client() ?: return
            val app = client.describeApp(engine.appId)
            if (app.runtime != "native") {
                throw PlatformException("failed_precondition", "APP_NOT_NATIVE", "This App has a web frontend.")
            }
            val trust = loadTrust(client, instanceDirectory)
            val packages = File(cacheRoot, "packages/${engine.appId}")
            var file = app.packageBuild?.let { File(packages, "$it.nshpkg") }
            var deploymentId = app.deploymentId ?: ""
            if (file == null || !file.exists()) {
                val target = File(packages, "download.nshpkg")
                val downloaded = client.downloadPackage(engine.appId, target, Sha256Hasher())
                val named = File(packages, "${downloaded.build}.nshpkg")
                named.delete()
                check(target.renameTo(named)) { "Could not keep the package." }
                // Only the live build is kept.
                packages.listFiles()?.filter { it != named }?.forEach { it.delete() }
                file = named
                deploymentId = downloaded.deploymentId
            }
            val pkg: NshPackage =
                try {
                    trust.openPackage(file)
                } catch (error: NshPackage.RefusedException) {
                    // A cached package the store refuses (revoked, or older than
                    // one it accepted) is fetched again when the App next opens.
                    file.delete()
                    throw PlatformException("failed_precondition", message = error.message ?: "The package was refused.")
                }
            val scope = AppScope.of(engine.appId, deploymentId, app.rpcMethods, app.hasData)!!
            val build = pkg.build.toInt()
            main.post {
                if (engines[engine.appId] !== engine) {
                    pkg.close()
                    return@post
                }
                try {
                    engine.bridge.scope = scope
                    val setup = EngineSetup.of("android", route, build, engine.appId, instanceDirectory, cacheRoot)
                    install(engine, setup)
                    engine.build = build
                    engine.view.runPackage(pkg)
                    engine.moveTo(AppEngineState.Running(build))
                } catch (error: Exception) {
                    engine.moveTo(AppEngineState.Failed("unavailable", error.message ?: error.toString()))
                }
            }
        } catch (error: Exception) {
            main.post {
                if (engines[engine.appId] !== engine) return@post
                val failure = error as? PlatformException
                engine.moveTo(
                    AppEngineState.Failed(failure?.publicCode ?: failure?.code ?: "unavailable", error.message ?: error.toString())
                )
            }
        }
    }

    private fun install(engine: Engine, setup: EngineSetup) {
        val view = engine.view
        view.apply(setup)
        view.setErrorListener { message ->
            main.post { if (engines[engine.appId] === engine) engine.moveTo(AppEngineState.Failed("app_error", message)) }
        }
        val bridge = engine.bridge
        for (name in HostCalls.names) {
            view.handle(name) { data, reply -> network.execute { reply.resolve(bridge.call(name, data)) } }
        }
    }

    /** Shows `appId`'s engine in `container`; the engine keeps its last size until the container has one. */
    fun attach(appId: String, container: ViewGroup) {
        val engine = engines[appId] ?: return
        containers[appId] = container
        val view = engine.view
        if (view.parent !== container) {
            release(view)
            container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        updateVisibility()
    }

    /**
     * Takes an engine's view out of its old container. A container in a screen
     * that is animating out keeps a removed child as "disappearing" (still its
     * parent) until the animation ends: end that for this view at once.
     */
    private fun release(view: NshView) {
        val old = view.parent as? ViewGroup ?: return
        old.removeView(view)
        old.endViewTransition(view)
    }

    /**
     * The container no longer shows `appId`; the engine keeps running. Its view
     * stays in the container until another one takes it: removing it while the
     * container is being detached runs NshView's own detach twice, which
     * crashes (it unregisters a receiver twice).
     */
    fun detach(appId: String, container: ViewGroup) {
        if (containers[appId] !== container) return
        containers.remove(appId)
        updateVisibility()
    }

    /** Asks the App to show `route` (`hatch.nav`). */
    fun navigate(appId: String, route: String) {
        engines[appId]?.view?.send(HostEvents.NAV, mapOf("route" to route))
    }

    /** The system back gesture: true when the App went back itself. */
    fun handleBack(appId: String): Boolean = engines[appId]?.view?.handleBack() == true

    /** Stops and starts `appId` again at its current route. */
    fun reload(appId: String) {
        val engine = engines[appId] ?: return
        val listener = engine.listener
        val container = containers[appId]
        val context = engine.view.context
        stop(appId)
        open(context, appId, null, listener)
        container?.let { attach(appId, it) }
    }

    /** Stops `appId` (its route is remembered). */
    fun stop(appId: String) {
        ledger().stop(appId)
        stopEngine(appId)
    }

    fun stopAll() {
        for (appId in engines.keys.toList()) stop(appId)
    }

    fun state(appId: String): AppEngineState? = engines[appId]?.state

    fun title(appId: String): String? = engines[appId]?.title

    val runningApps: List<String>
        get() = ledger().running

    private fun stopEngine(appId: String) {
        val engine = engines.remove(appId) ?: return
        engine.moveTo(AppEngineState.Failed("stopped", "The App was stopped."))
        engine.listener = null
        // Off the current dispatch: the view may be inside a detaching container.
        main.post {
            release(engine.view)
            engine.view.destroy()
        }
    }

    private fun updateVisibility(refresh: Boolean = false) {
        val visible = if (started > 0 || application == null) containers.keys.intersect(engines.keys) else emptySet()
        ledger().setVisible(visible, now())
        for (appId in engines.keys) {
            if ((appId in visible) != (appId in lastVisible)) {
                engines[appId]?.view?.send(HostEvents.VISIBILITY, mapOf("visible" to (appId in visible)))
            }
        }
        lastVisible = visible
        scheduleWait()
        if (refresh) refreshDeployments(null)
    }

    private fun scheduleWait() {
        main.removeCallbacks(waitCheck)
        val (stopped, nextDue) = ledger().stopWaiting(now())
        stopped.forEach { stopEngine(it) }
        if (nextDue != null) main.postDelayed(waitCheck, (nextDue - now()).coerceIn(500, 60_000))
    }

    /** A newer deployment went live: running Apps keep their code and are told. */
    private fun refreshDeployments(only: String?) {
        val client = client() ?: return
        for (engine in engines.values.filter { only == null || it.appId == only }) {
            val build = engine.build ?: continue
            network.execute {
                val live = runCatching { client.describeApp(engine.appId).packageBuild }.getOrNull()
                if (live != null && live != build) {
                    main.post {
                        if (engines[engine.appId] !== engine) return@post
                        engine.view.send(HostEvents.UPDATE, emptyMap<String, Any>())
                        engine.moveTo(AppEngineState.UpdateAvailable(live))
                    }
                }
            }
        }
    }

    internal val currentTheme: String?
        get() = themeJson

    /** The bridge's view of the manager for one App; calls arrive off the main thread. */
    private class EngineShell(val appId: String) : BridgeShell {
        override fun themeJson(): String? = currentTheme

        override fun setTitle(title: String?) {
            main.post {
                val engine = engines[appId] ?: return@post
                engine.title = title
                engine.listener?.engineTitleChanged(title)
            }
        }

        override fun setRoute(route: String) {
            main.post {
                ledger().setRoute(route, appId)
                engines[appId]?.listener?.engineRouteChanged(route)
            }
        }

        override fun openApp(slug: String, route: String): Boolean {
            if (delegate == null) return false
            main.post { delegate?.openApp(slug, route) }
            return true
        }

        override fun unauthorized() {
            main.post { delegate?.unauthorized() }
        }

        override fun deploymentStale() {
            main.post { refreshDeployments(appId) }
        }
    }
}
