import CryptoKit
import Foundation
import NativeShell
import UIKit

#if canImport(HatchAppCore)
    import HatchAppCore
#endif

struct SHA256Hasher: PackageHasher {
    private var hash = SHA256()
    mutating func update(_ data: Data) { hash.update(data: data) }
    func hexDigest() -> String { hash.finalize().map { String(format: "%02x", $0) }.joined() }
}

/// What a view showing an App hears about it.
@MainActor
public protocol AppEngineListener: AnyObject {
    func engineStateChanged(_ state: AppEngineState)
    func engineTitleChanged(_ title: String?)
    func engineRouteChanged(_ route: String)
}

/// What the host app hears from every engine.
@MainActor
public protocol AppEngineHostDelegate: AnyObject {
    /// An App asked to open another App (`hatch.nav.open`).
    func engineManager(openApp slug: String, route: String) -> Bool
    /// The instance refused the session's credential.
    func engineManagerUnauthorized()
}

public enum AppEngineState: Equatable {
    case loading
    case running(build: Int)
    /// A newer deployment is live; reloading runs it.
    case updateAvailable(build: Int)
    /// `code` is the platform's (`APP_NOT_NATIVE`, `APP_PACKAGE_UNAVAILABLE`)
    /// or the Connect code.
    case failed(code: String, message: String)
}

/// One running App: its engine, its bridge and what it last reported.
@MainActor
final class AppEngine {
    let appId: String
    let view: NshAppView
    let bridge: HostBridge
    var state: AppEngineState = .loading
    var title: String?
    var build: Int?
    weak var listener: AppEngineListener?
    var task: Task<Void, Never>?

    init(appId: String, view: NshAppView, bridge: HostBridge) {
        self.appId = appId
        self.view = view
        self.bridge = bridge
    }

    func setState(_ next: AppEngineState) {
        state = next
        listener?.engineStateChanged(next)
    }
}

/// The engines of every App the user opened, one per App, owned here (not by
/// a view) so an App keeps running while its screen is gone. Applies the
/// Desk's rules ([`RunLedger`]): a limit of running Apps (3 on a phone, 6 on
/// a tablet), and a hidden App stops once it has waited the user's
/// background minutes, measured from when the whole app went to the
/// background too. A stopped App reopens at the route it was left on.
///
/// Every engine runs its App's signed package from the instance
/// (`GetAppPackage`), verified against the instance's roots
/// (`GetAppRuntimeTrust`) in a trust store of its own per instance, with a
/// 96 MB heap and exactly the `{ host: [...] }` grant.
@MainActor
public final class AppEngineManager {
    public static let shared = AppEngineManager()

    public weak var delegate: AppEngineHostDelegate?
    private var origin: URL?
    private var token: String?
    private let transport = URLSessionTransport()
    private var engines: [String: AppEngine] = [:]
    /// Where each App is shown now; kept when its engine stops, so an App
    /// stopped while its page stayed open starts again when the app returns.
    private var containers: [String: UIView] = [:]
    private var listeners: [String: WeakListener] = [:]
    private let ledger: RunLedger
    private var appActive = UIApplication.shared.applicationState != .background
    private var waitTimer: Timer?
    private var themeJSON: String?
    private var trust: NshTrust?
    private var trustLoaded = false
    private var observers: [NSObjectProtocol] = []

    init() {
        ledger = RunLedger(
            limit: UIDevice.current.userInterfaceIdiom == .pad ? RunLedger.tabletLimit : RunLedger.phoneLimit)
        let center = NotificationCenter.default
        observers.append(
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.setAppActive(false) }
            })
        observers.append(
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated { self?.setAppActive(true) }
            })
    }

    // MARK: - Session

    private var instanceDirectory: URL? {
        guard let origin else { return nil }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("hatch-apps/\(InstanceKey.of(origin))", isDirectory: true)
    }

    private var cacheRoot: URL? {
        guard let origin else { return nil }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("hatch-apps/\(InstanceKey.of(origin))", isDirectory: true)
    }

    /// The signed-in instance and its session credential. Another instance,
    /// or none, stops every App.
    public func configure(origin: URL?, token: String?) {
        if origin != self.origin || token == nil {
            stopAll()
            containers = [:]
            listeners = [:]
            ledger.reset()
            trust = nil
            trustLoaded = false
        }
        self.origin = origin
        self.token = token
    }

    /// The user's background minutes (`GetDeskPreferences`).
    public func setBackgroundMinutes(_ minutes: Int) {
        ledger.setBackgroundMinutes(minutes)
        scheduleWait()
    }

    /// The NSH theme every App gets (`hatch.theme.get`, `hatch.theme`).
    public func setTheme(_ json: String?) {
        themeJSON = json
        let theme = json.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } ?? NSNull()
        for engine in engines.values { engine.view.send(HostEvents.theme, ["theme": theme]) }
    }

    var currentTheme: String? { themeJSON }

    private func client() -> PlatformClient? {
        guard let origin else { return nil }
        let token = self.token
        return PlatformClient(origin: origin, credential: { token }, transport: transport)
    }

    // MARK: - Showing Apps

    /// The state of `appId`'s engine, starting it (at its remembered route)
    /// if it does not run.
    @discardableResult
    public func open(_ appId: String, route: String? = nil, listener: AppEngineListener?) -> AppEngineState {
        listeners[appId] = WeakListener(listener)
        if let engine = engines[appId] {
            engine.listener = listener
            if let route { navigate(appId, to: route) }
            return engine.state
        }
        guard let origin, let instanceDirectory, let cacheRoot,
            let scope = AppScope(appId: appId, deploymentId: "", rpcMethods: [:], hasData: false)
        else {
            let failed = AppEngineState.failed(code: "unauthenticated", message: "Sign in to this instance again.")
            listener?.engineStateChanged(failed)
            return failed
        }
        let start = route ?? ledger.route(of: appId) ?? ""
        for victim in ledger.start(appId, route: start) { stopEngine(victim) }
        let token = self.token
        let shell = EngineShell(appId: appId, manager: self)
        let bridge = HostBridge(
            origin: origin, scope: scope, credential: { token }, transport: transport, shell: shell)
        let view = NshAppView()
        let engine = AppEngine(appId: appId, view: view, bridge: bridge)
        engine.listener = listener
        engines[appId] = engine
        engine.task = Task { [weak self] in
            await self?.load(engine, route: start, instanceDirectory: instanceDirectory, cacheRoot: cacheRoot)
        }
        updateVisibility()
        return engine.state
    }

    private func loadTrust(_ client: PlatformClient, directory: URL) async throws -> NshTrust {
        if let trust, trustLoaded { return trust }
        let store = try trust ?? NshTrust(stateDirectory: directory.appendingPathComponent("trust"))
        trust = store
        let material = try await client.runtimeTrust()
        guard material.initialized else {
            throw PlatformError(code: "failed_precondition", message: "This instance has no native App keys yet.")
        }
        for root in material.roots { try store.addRoot(root) }
        // The store takes only a newer list (it refuses one it has already):
        // apply each sequence once, and refuse to go on if a newer one fails.
        let applied = directory.appendingPathComponent("trust/revocations-sequence")
        let known = (try? String(contentsOf: applied, encoding: .utf8)).flatMap { Int($0) } ?? 0
        if let revocations = material.revocations, material.revocationSequence > known {
            try store.updateRevocations(revocations)
            try String(material.revocationSequence).write(to: applied, atomically: true, encoding: .utf8)
        }
        trustLoaded = true
        return store
    }

    private func load(_ engine: AppEngine, route: String, instanceDirectory: URL, cacheRoot: URL) async {
        guard let client = client() else { return }
        do {
            let app = try await client.describeApp(engine.appId)
            guard app.runtime == "native" else {
                throw PlatformError(
                    code: "failed_precondition", publicCode: "APP_NOT_NATIVE",
                    message: "This App has a web frontend.")
            }
            let trust = try await loadTrust(client, directory: instanceDirectory)
            let packages = cacheRoot.appendingPathComponent("packages/\(engine.appId)", isDirectory: true)
            var file = app.packageBuild.map { packages.appendingPathComponent("\($0).nshpkg") }
            var info: AppPackageInfo?
            if file == nil || !FileManager.default.fileExists(atPath: file!.path) {
                let target = packages.appendingPathComponent("download.nshpkg")
                let downloaded = try await client.downloadPackage(
                    appId: engine.appId, to: target, hasher: SHA256Hasher())
                let named = packages.appendingPathComponent("\(downloaded.build).nshpkg")
                try? FileManager.default.removeItem(at: named)
                try FileManager.default.moveItem(at: target, to: named)
                // Only the live build is kept.
                for old in (try? FileManager.default.contentsOfDirectory(at: packages, includingPropertiesForKeys: nil))
                    ?? [] where old != named
                {
                    try? FileManager.default.removeItem(at: old)
                }
                file = named
                info = downloaded
            }
            guard engines[engine.appId] === engine, let file else { return }
            let package: NshPackage
            do {
                package = try await trust.openPackage(at: file)
            } catch {
                // A cached package the store refuses (revoked, or older than
                // one it accepted) is fetched again when the App next opens.
                try? FileManager.default.removeItem(at: file)
                throw PlatformError(code: "failed_precondition", message: "\(error)")
            }
            guard engines[engine.appId] === engine else { return }
            let build = Int(package.info.build)
            engine.bridge.scope = AppScope(
                appId: engine.appId, deploymentId: info?.deploymentId ?? app.deploymentId ?? "",
                rpcMethods: app.rpcMethods, hasData: app.hasData)!
            let setup = EngineSetup(
                platform: "ios", route: route, packageBuild: build, appId: engine.appId,
                instanceDirectory: instanceDirectory, cacheRoot: cacheRoot)
            try apply(setup, to: engine)
            engine.build = build
            engine.view.run(package)
            engine.setState(.running(build: build))
        } catch {
            guard engines[engine.appId] === engine else { return }
            let failure = error as? PlatformError
            engine.setState(
                .failed(
                    code: failure?.publicCode ?? failure?.code ?? "unavailable",
                    message: failure?.message ?? "\(error)"))
        }
    }

    /// Limits, grant, params, directories and the bridge, before `run`.
    private func apply(_ setup: EngineSetup, to engine: AppEngine) throws {
        let view = engine.view
        try view.apply(setup)
        view.onError = { [weak self, weak engine] message in
            guard let engine, self?.engines[engine.appId] === engine else { return }
            engine.setState(.failed(code: "app_error", message: message))
        }
        let bridge = engine.bridge
        for name in HostCalls.names {
            view.handle(name) { data in await bridge.call(name, data) }
        }
    }

    /// Shows `appId`'s engine in `container` (sized by it once it has a size;
    /// a container without one keeps the engine's last size).
    public func attach(_ appId: String, to container: UIView) {
        guard let engine = engines[appId] else { return }
        containers[appId] = container
        let view = engine.view
        if view.superview !== container {
            view.removeFromSuperview()
            if container.bounds.size != .zero { view.frame = container.bounds }
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(view)
        }
        updateVisibility()
    }

    /// The container no longer shows `appId`; the engine keeps running.
    public func detach(_ appId: String, from container: UIView) {
        guard containers[appId] === container else { return }
        containers[appId] = nil
        if let view = engines[appId]?.view, view.superview === container { view.removeFromSuperview() }
        updateVisibility()
    }

    public func layout(_ appId: String, in container: UIView) {
        guard let view = engines[appId]?.view, view.superview === container, container.bounds.size != .zero
        else { return }
        view.frame = container.bounds
    }

    /// Asks the App to show `route` (`hatch.nav`).
    public func navigate(_ appId: String, to route: String) {
        engines[appId]?.view.send(HostEvents.nav, ["route": route])
    }

    /// Stops and starts `appId` again at its current route.
    public func reload(_ appId: String) {
        let listener = engines[appId]?.listener
        let container = containers[appId]
        stop(appId)
        open(appId, listener: listener)
        if let container { attach(appId, to: container) }
    }

    /// Stops `appId` (its route is remembered).
    public func stop(_ appId: String) {
        ledger.stop(appId)
        stopEngine(appId)
    }

    public func stopAll() {
        for appId in Array(engines.keys) { stop(appId) }
    }

    public func state(of appId: String) -> AppEngineState? { engines[appId]?.state }
    public func title(of appId: String) -> String? { engines[appId]?.title }
    public var runningApps: [String] { ledger.running }

    private func stopEngine(_ appId: String) {
        guard let engine = engines.removeValue(forKey: appId) else { return }
        engine.task?.cancel()
        engine.view.removeFromSuperview()
        engine.setState(.failed(code: "stopped", message: "The App was stopped."))
        // The engine stops when its view is released.
    }

    // MARK: - Visibility and background time

    private func setAppActive(_ active: Bool) {
        appActive = active
        if active {
            // A suspended app runs no timer: settle the background time first,
            // while every App still counts as hidden.
            for appId in ledger.stopWaiting().stopped { stopEngine(appId) }
            // Apps whose page stayed open while they waited out their time in
            // the background start again, at the route they were left on.
            for (appId, container) in containers where engines[appId] == nil {
                open(appId, listener: listeners[appId]?.listener)
                attach(appId, to: container)
            }
        }
        updateVisibility()
        if active { refreshDeployments() }
    }

    private var lastVisible: Set<String> = []

    private func updateVisibility() {
        let visible = appActive ? Set(containers.keys).intersection(engines.keys) : []
        ledger.setVisible(visible)
        for appId in engines.keys where visible.contains(appId) != lastVisible.contains(appId) {
            engines[appId]?.view.send(HostEvents.visibility, ["visible": visible.contains(appId)])
        }
        lastVisible = visible
        scheduleWait()
    }

    private func scheduleWait() {
        waitTimer?.invalidate()
        let (stopped, nextDue) = ledger.stopWaiting()
        for appId in stopped { stopEngine(appId) }
        guard let nextDue else { return }
        // Re-check at least every minute: timers stall while the app is
        // suspended, and the clock may jump meanwhile.
        let delay = min(max(0.5, nextDue.timeIntervalSinceNow), 60)
        waitTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleWait() }
        }
    }

    // MARK: - From the bridge

    fileprivate func engineSetTitle(_ appId: String, _ title: String?) {
        guard let engine = engines[appId] else { return }
        engine.title = title
        engine.listener?.engineTitleChanged(title)
    }

    fileprivate func engineSetRoute(_ appId: String, _ route: String) {
        ledger.setRoute(route, of: appId)
        engines[appId]?.listener?.engineRouteChanged(route)
    }

    fileprivate func engineOpen(slug: String, route: String) -> Bool {
        delegate?.engineManager(openApp: slug, route: route) ?? false
    }

    fileprivate func engineUnauthorized() {
        delegate?.engineManagerUnauthorized()
    }

    /// A newer deployment went live (the Data API said so, or the app came
    /// back to the front): running Apps keep their code and are told.
    fileprivate func refreshDeployments(_ only: String? = nil) {
        guard let client = client() else { return }
        for engine in engines.values where only == nil || engine.appId == only {
            guard let build = engine.build else { continue }
            Task { [weak engine] in
                guard let app = try? await client.describeApp(engine?.appId ?? ""),
                    let live = app.packageBuild, live != build, let engine
                else { return }
                engine.view.send(HostEvents.update, [String: Any]())
                engine.setState(.updateAvailable(build: live))
            }
        }
    }

    fileprivate func engineDeploymentStale(_ appId: String) {
        refreshDeployments(appId)
    }
}

private struct WeakListener {
    weak var listener: AppEngineListener?
    init(_ listener: AppEngineListener?) { self.listener = listener }
}

/// The bridge's view of the manager for one App.
private final class EngineShell: BridgeShell, @unchecked Sendable {
    let appId: String
    weak var manager: AppEngineManager?

    init(appId: String, manager: AppEngineManager) {
        self.appId = appId
        self.manager = manager
    }

    func themeJSON() async -> String? { await MainActor.run { manager?.currentTheme } }
    func setTitle(_ title: String?) async { await MainActor.run { manager?.engineSetTitle(appId, title) } }
    func setRoute(_ route: String) async { await MainActor.run { manager?.engineSetRoute(appId, route) } }
    func openApp(slug: String, route: String) async -> Bool {
        await MainActor.run { manager?.engineOpen(slug: slug, route: route) ?? false }
    }
    func unauthorized() async { await MainActor.run { manager?.engineUnauthorized() } }
    func deploymentStale() async { await MainActor.run { manager?.engineDeploymentStale(appId) } }
}

extension NshAppView {
    /// Sets an App's limits, grant, launch parameters and directories: what
    /// every engine gets before it runs a package.
    func apply(_ setup: EngineSetup) throws {
        var limits = NshLimits()
        limits.memoryMB = setup.heapMegabytes
        self.limits = limits
        try grantCapabilities(setup.grant)
        params = setup.params
        try FileManager.default.createDirectory(at: setup.storageDirectory, withIntermediateDirectories: true)
        storageDirectory = setup.storageDirectory
        cacheOptions = NshCacheOptions(location: .directory(setup.cacheDirectory))
    }
}
