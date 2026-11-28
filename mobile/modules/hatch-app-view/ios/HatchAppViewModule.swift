import ExpoModulesCore
import HatchAppRuntime
import UIKit

/// Where a running Hatch native App shows: the engine belongs to
/// `AppEngineManager` (mobile/native), this view only mounts it while React
/// Native shows the view, so the App keeps running when its screen goes.
final class HatchAppView: ExpoView, AppEngineListener {
    let onEngineState = EventDispatcher()
    let onEngineTitle = EventDispatcher()
    let onEngineRoute = EventDispatcher()
    var appId: String?
    var route: String?
    private var opened: String?

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        clipsToBounds = true
    }

    func update() {
        guard let appId, window != nil else { return }
        let manager = AppEngineManager.shared
        if opened != appId {
            if let opened { manager.detach(opened, from: self) }
            opened = appId
            engineStateChanged(manager.open(appId, route: route, listener: self))
            if let title = manager.title(of: appId) { engineTitleChanged(title) }
        }
        manager.attach(appId, to: self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            if let opened { AppEngineManager.shared.detach(opened, from: self) }
            opened = nil
        } else {
            update()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let opened { AppEngineManager.shared.layout(opened, in: self) }
    }

    func engineStateChanged(_ state: AppEngineState) {
        switch state {
        case .loading: onEngineState(["state": "loading"])
        case .running(let build): onEngineState(["state": "running", "build": build])
        case .updateAvailable(let build): onEngineState(["state": "updateAvailable", "build": build])
        case .failed(let code, let message): onEngineState(["state": "failed", "code": code, "message": message])
        }
    }

    func engineTitleChanged(_ title: String?) { onEngineTitle(["title": title as Any]) }
    func engineRouteChanged(_ route: String) { onEngineRoute(["route": route]) }
}

/// The host app's side of the runtime: the session, the user's background
/// minutes and theme, and the Apps' requests to open other Apps.
@MainActor
final class HostDelegate: AppEngineHostDelegate {
    weak var module: HatchAppViewModule?

    func engineManager(openApp slug: String, route: String, origin: String) -> Bool {
        guard let module else { return false }
        module.sendEvent("onOpenApp", ["slug": slug, "route": route, "origin": origin])
        return true
    }

    func engineManagerUnauthorized() {
        module?.sendEvent("onUnauthorized", [:])
    }
}

public final class HatchAppViewModule: Module {
    private var host: HostDelegate?

    public func definition() -> ModuleDefinition {
        Name("HatchAppView")
        Events("onOpenApp", "onUnauthorized")

        OnCreate {
            Task { @MainActor in
                let host = HostDelegate()
                host.module = self
                self.host = host
                AppEngineManager.shared.delegate = host
            }
        }

        AsyncFunction("configure") { (origin: String?, token: String?) in
            MainActor.assumeIsolated { AppEngineManager.shared.configure(origin: origin.flatMap(URL.init(string:)), token: token) }
        }.runOnQueue(.main)
        AsyncFunction("forgetStorage") { (origin: String) in
            MainActor.assumeIsolated {
                if let url = URL(string: origin) { AppEngineManager.shared.forgetStorage(origin: url) }
            }
        }.runOnQueue(.main)
        AsyncFunction("setBackgroundMinutes") { (minutes: Int) in
            MainActor.assumeIsolated { AppEngineManager.shared.setBackgroundMinutes(minutes) }
        }.runOnQueue(.main)
        AsyncFunction("setTheme") { (json: String?) in
            MainActor.assumeIsolated { AppEngineManager.shared.setTheme(json) }
        }.runOnQueue(.main)
        AsyncFunction("navigate") { (appId: String, route: String) in
            MainActor.assumeIsolated { AppEngineManager.shared.navigate(appId, to: route) }
        }.runOnQueue(.main)
        AsyncFunction("reload") { (appId: String) in
            MainActor.assumeIsolated { AppEngineManager.shared.reload(appId) }
        }.runOnQueue(.main)
        AsyncFunction("stop") { (appId: String) in
            MainActor.assumeIsolated { AppEngineManager.shared.stop(appId) }
        }.runOnQueue(.main)
        // iOS has no system back for an App: its pages bring their own.
        AsyncFunction("handleBack") { (_: String) in false }

        View(HatchAppView.self) {
            Events("onEngineState", "onEngineTitle", "onEngineRoute")
            Prop("appId") { (view: HatchAppView, appId: String) in
                MainActor.assumeIsolated {
                    view.appId = appId
                    view.update()
                }
            }
            Prop("route") { (view: HatchAppView, route: String?) in
                MainActor.assumeIsolated { view.route = route }
            }
        }
    }
}
