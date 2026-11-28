package dev.hatch.appview

import android.app.Application
import android.content.Context
import dev.hatch.app.runtime.AppEngineHostDelegate
import dev.hatch.app.runtime.AppEngineListener
import dev.hatch.app.runtime.AppEngineManager
import dev.hatch.app.runtime.AppEngineState
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Where a running Hatch native App shows: the engine belongs to
 * [AppEngineManager] (mobile/native), this view only mounts it while React
 * Native shows the view, so the App keeps running when its screen goes.
 */
class HatchAppView(context: Context, appContext: AppContext) : ExpoView(context, appContext), AppEngineListener {
    // The engine's view is added after React Native laid this view out (on
    // every return to a running App): lay it out ourselves.
    override val shouldUseAndroidLayout = true
    private val onEngineState by EventDispatcher()
    private val onEngineTitle by EventDispatcher()
    private val onEngineRoute by EventDispatcher()
    var appId: String? = null
    var route: String? = null
    private var opened: String? = null

    fun update() {
        val appId = appId ?: return
        if (!isAttachedToWindow) return
        if (opened != appId) {
            opened?.let { AppEngineManager.detach(it, this) }
            opened = appId
            engineStateChanged(AppEngineManager.open(context, appId, route, this))
            AppEngineManager.title(appId)?.let { engineTitleChanged(it) }
        }
        AppEngineManager.attach(appId, this)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        update()
    }

    override fun onDetachedFromWindow() {
        // Leave the engine's view where it is: removing it during this
        // dispatch crashes NshView (see AppEngineManager.detach).
        opened?.let { AppEngineManager.detach(it, this) }
        opened = null
        super.onDetachedFromWindow()
    }

    override fun engineStateChanged(state: AppEngineState) {
        onEngineState(
            when (state) {
                is AppEngineState.Loading -> mapOf("state" to "loading")
                is AppEngineState.Running -> mapOf("state" to "running", "build" to state.build)
                is AppEngineState.UpdateAvailable -> mapOf("state" to "updateAvailable", "build" to state.build)
                is AppEngineState.Failed -> mapOf("state" to "failed", "code" to state.code, "message" to state.message)
            }
        )
    }

    override fun engineTitleChanged(title: String?) {
        onEngineTitle(mapOf("title" to (title ?: "")))
    }

    override fun engineRouteChanged(route: String) {
        onEngineRoute(mapOf("route" to route))
    }
}

/** The host app's side of the runtime: the session, the user's background minutes and theme, open requests. */
class HatchAppViewModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("HatchAppView")
        Events("onOpenApp", "onUnauthorized")

        OnCreate {
            (appContext.reactContext?.applicationContext as? Application)?.let { AppEngineManager.install(it) }
            val module = this@HatchAppViewModule
            AppEngineManager.delegate =
                object : AppEngineHostDelegate {
                    override fun openApp(slug: String, route: String): Boolean {
                        module.sendEvent("onOpenApp", mapOf("slug" to slug, "route" to route))
                        return true
                    }

                    override fun unauthorized() {
                        module.sendEvent("onUnauthorized", emptyMap<String, Any>())
                    }
                }
        }

        AsyncFunction("configure") { origin: String?, token: String? ->
            val context = appContext.reactContext ?: throw IllegalStateException("No React context.")
            AppEngineManager.configure(context, origin, token)
        }.runOnQueue(Queues.MAIN)
        AsyncFunction("setBackgroundMinutes") { minutes: Int -> AppEngineManager.setBackgroundMinutes(minutes) }
            .runOnQueue(Queues.MAIN)
        AsyncFunction("setTheme") { json: String? -> AppEngineManager.setTheme(json) }
            .runOnQueue(Queues.MAIN)
        AsyncFunction("navigate") { appId: String, route: String -> AppEngineManager.navigate(appId, route) }
            .runOnQueue(Queues.MAIN)
        AsyncFunction("reload") { appId: String -> AppEngineManager.reload(appId) }
            .runOnQueue(Queues.MAIN)
        AsyncFunction("stop") { appId: String -> AppEngineManager.stop(appId) }
            .runOnQueue(Queues.MAIN)
        // The system back gesture: true when the App went back itself.
        AsyncFunction("handleBack") { appId: String -> AppEngineManager.handleBack(appId) }
            .runOnQueue(Queues.MAIN)

        View(HatchAppView::class) {
            Events("onEngineState", "onEngineTitle", "onEngineRoute")
            Prop("appId") { view: HatchAppView, appId: String ->
                view.appId = appId
                view.update()
            }
            Prop("route") { view: HatchAppView, route: String? -> view.route = route }
        }
    }
}
