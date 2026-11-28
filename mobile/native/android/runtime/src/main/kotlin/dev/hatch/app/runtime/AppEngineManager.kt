package dev.hatch.app.runtime

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
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
import dev.hatch.app.core.TrustRefresh
import dev.hatch.app.core.TrustStore
import dev.hatch.app.core.UrlConnectionTransport
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
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
    private class Engine(
        val appId: String,
        val view: NshView,
        val bridge: HostBridge,
        val activity: Activity?,
        val session: Session,
    ) {
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

    /**
     * One signed-in instance. Everything started for it (engines, their host
     * calls, package loads) uses its origin, credential and trust store, never
     * another session's: a session that ends answers no more credentials, and
     * its trust store closes once the last verification using it is done.
     */
    private class Session(val origin: String, @Volatile var token: String?, val directory: File) {
        @Volatile var active = true
            private set

        private var store: NshTrust? = null
        private var users = 0
        private val trustRefresh = TrustRefresh(File(directory, "trust/revocations-sequence"))

        fun credential(): String? = if (active) token else null

        fun client(): PlatformClient = PlatformClient(origin, ::credential, transport)

        /** Runs `block` with this session's trust store, first brought up to the instance's material. */
        fun <T> withTrust(client: PlatformClient, block: (NshTrust) -> T): T {
            val store =
                synchronized(this) {
                    if (!active) throw PlatformException("unauthenticated", message = "Sign in to this instance again.")
                    users += 1
                    store ?: NshTrust(File(directory, "trust")).also { store = it }
                }
            try {
                val material = client.runtimeTrust()
                trustRefresh.refresh(StoreOf(store), material) {
                    val dir = File(directory, "trust-probe-${UUID.randomUUID()}")
                    StoreOf(NshTrust(dir), dir)
                }
                if (!active) throw PlatformException("unauthenticated", message = "Sign in to this instance again.")
                return block(store)
            } finally {
                synchronized(this) {
                    users -= 1
                    if (!active && users == 0) closeStore()
                }
            }
        }

        fun retire() {
            synchronized(this) {
                active = false
                if (users == 0) closeStore()
            }
        }

        private fun closeStore() {
            store?.close()
            store = null
        }
    }

    private class StoreOf(val trust: NshTrust, val directory: File? = null) : TrustStore {
        override fun addRoot(publicKey: String) = trust.addRoot(publicKey)

        override fun updateRevocations(json: String) = trust.updateRevocations(json)

        override fun close() {
            trust.close()
            directory?.deleteRecursively()
        }
    }

    private val main = Handler(Looper.getMainLooper())
    /** Package loads: downloads and verification, which can take a while. */
    private val loads = Executors.newFixedThreadPool(2) { Thread(it, "hatch-app-load").apply { isDaemon = true } }
    /** Short host calls (RPC, data queries and changes). */
    private val calls = Executors.newFixedThreadPool(4) { Thread(it, "hatch-app-call").apply { isDaemon = true } }
    /** `hatch.data.events` long polls, which wait up to 25 s each: apart, so they never hold up the rest. */
    private val polls = Executors.newFixedThreadPool(8) { Thread(it, "hatch-app-poll").apply { isDaemon = true } }
    private val transport = UrlConnectionTransport()
    /** One package load per App at a time: they share its cache directory. */
    private val packageLocks = mutableMapOf<String, Any>()
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
    private var session: Session? = null
    private var themeJson: String? = null
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

    private fun cacheRoot(context: Context, origin: String): File = File(context.cacheDir, "hatch-apps/${InstanceKey.of(origin)}")

    /** The signed-in instance and its session credential. Another instance, or none, stops every App. */
    fun configure(context: Context, origin: String?, token: String?) {
        val next = origin?.trimEnd('/')
        val current = session
        if (current != null && current.origin == next && token != null) {
            // The same instance with a renewed credential: its work goes on.
            current.token = token
            return
        }
        stopAll()
        containers.clear()
        listeners.clear()
        ledger().reset()
        current?.retire()
        session =
            if (next != null && token != null) {
                Session(next, token, File(context.applicationContext.filesDir, "hatch-apps/${InstanceKey.of(next)}"))
            } else {
                null
            }
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

    /** The activity a view's context belongs to (React Native wraps it). */
    private fun activityOf(context: Context): Activity? {
        var current: Context? = context
        while (current != null) {
            if (current is Activity) return current
            current = (current as? ContextWrapper)?.baseContext
        }
        return null
    }

    /** The state of `appId`'s engine, starting it (at its remembered route) in `context`'s activity if it does not run. */
    fun open(context: Context, appId: String, route: String?, listener: AppEngineListener?): AppEngineState {
        listeners[appId] = java.lang.ref.WeakReference(listener)
        engines[appId]?.let { engine ->
            engine.listener = listener
            if (route != null) navigate(appId, route)
            return engine.state
        }
        val session = session
        val scope = AppScope.of(appId, "", emptyMap(), false)
        if (session == null || scope == null) {
            val failed = AppEngineState.Failed("unauthenticated", "Sign in to this instance again.")
            listener?.engineStateChanged(failed)
            return failed
        }
        val start = route ?: ledger().route(appId) ?: ""
        for (victim in ledger().start(appId, start, now())) stopEngine(victim)
        val shell = EngineShell(appId)
        val bridge = HostBridge(session.origin, scope, session::credential, transport, shell)
        val engine = Engine(appId, NshView(context), bridge, activityOf(context), session)
        shell.engine = engine
        engine.listener = listener
        engines[appId] = engine
        val cacheRoot = cacheRoot(context, session.origin)
        loads.execute { load(engine, start, session.directory, cacheRoot) }
        updateVisibility()
        return engine.state
    }

    private fun load(engine: Engine, route: String, instanceDirectory: File, cacheRoot: File) {
        try {
            val session = engine.session
            val client = session.client()
            var app = client.describeApp(engine.appId)
            if (app.archived) throw PlatformException("failed_precondition", "APP_ARCHIVED", "This App is archived.")
            if (app.runtime != "native") {
                throw PlatformException("failed_precondition", "APP_NOT_NATIVE", "This App has a web frontend.")
            }
            val lock = synchronized(packageLocks) { packageLocks.getOrPut(engine.appId) { Any() } }
            val (pkg, deploymentId) =
                synchronized(lock) {
                    val packages = File(cacheRoot, "packages/${engine.appId}")
                    var file = app.packageBuild?.let { File(packages, "$it.nshpkg") }
                    var deploymentId = app.deploymentId ?: ""
                    if (file == null || !file.exists()) {
                        val target = File(packages, "download-${UUID.randomUUID()}.nshpkg")
                        val downloaded =
                            try {
                                client.downloadPackage(engine.appId, target, Sha256Hasher())
                            } catch (error: Exception) {
                                target.delete()
                                throw error
                            }
                        val named = File(packages, "${downloaded.build}.nshpkg")
                        Files.move(target.toPath(), named.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
                        // Only the live build is kept.
                        packages.listFiles()?.filter { it != named }?.forEach { it.delete() }
                        file = named
                        deploymentId = downloaded.deploymentId
                        // The package is the live one now: describe that deployment.
                        if (deploymentId != app.deploymentId) {
                            app = client.describeApp(engine.appId)
                            if (app.deploymentId != deploymentId) {
                                throw PlatformException("unavailable", message = "The App changed while it opened. Try again.")
                            }
                        }
                    }
                    val opened =
                        session.withTrust(client) { trust ->
                            try {
                                trust.openPackage(file)
                            } catch (error: NshPackage.RefusedException) {
                                // A cached package the store refuses (revoked, or
                                // older than one it accepted) is fetched again when
                                // the App next opens.
                                file.delete()
                                throw PlatformException("failed_precondition", message = error.message ?: "The package was refused.")
                            }
                        }
                    opened to deploymentId
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
                    // Set up but never run: the package is still ours to close.
                    pkg.close()
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
            val pool = if (name == "hatch.data.events") polls else calls
            view.handle(name) { data, reply -> pool.execute { reply.resolve(bridge.call(name, data)) } }
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
        val engine = engines[appId]
        val container = containers[appId]
        // A stopped App whose page stayed open starts again in that page.
        val context = engine?.view?.context ?: container?.context ?: return
        val listener = engine?.listener ?: listeners[appId]?.get()
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
        // Its replacement starts hidden until shown: it is told so then.
        lastVisible = lastVisible - appId
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
        for (engine in engines.values.filter { only == null || it.appId == only }) {
            val build = engine.build ?: continue
            calls.execute {
                val live = runCatching { engine.session.client().describeApp(engine.appId).packageBuild }.getOrNull()
                if (live != null && live != build) {
                    main.post {
                        if (engines[engine.appId] !== engine) return@post
                        // A failed engine keeps its failure: reloading runs the new build anyway.
                        if (engine.state is AppEngineState.Failed) return@post
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
        /** The engine this shell serves; calls queued for an engine that was replaced are dropped. */
        @Volatile var engine: Engine? = null

        private fun current(): Engine? = engine?.takeIf { engines[appId] === it }

        override fun themeJson(): String? = currentTheme

        override fun setTitle(title: String?) {
            main.post {
                val engine = current() ?: return@post
                engine.title = title
                engine.listener?.engineTitleChanged(title)
            }
        }

        override fun setRoute(route: String) {
            main.post {
                val engine = current() ?: return@post
                ledger().setRoute(route, appId)
                engine.listener?.engineRouteChanged(route)
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
            main.post { if (current() != null) refreshDeployments(appId) }
        }
    }
}
