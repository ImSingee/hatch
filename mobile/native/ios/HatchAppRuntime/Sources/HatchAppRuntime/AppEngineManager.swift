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
    /// An App asked to open another App (`hatch.nav.open`) on the instance
    /// it runs for (`origin`).
    func engineManager(openApp slug: String, route: String, origin: String) -> Bool
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

/// One signed-in instance. Everything started for it (engines, their host
/// calls, package loads) uses its origin, credential and trust store, never
/// another session's: a session that ends answers no more credentials.
@MainActor
final class EngineSession {
    let origin: URL
    let directory: URL
    private let tokenBox: TokenBox
    /// Shared with every session for the same instance: they use the same trust directory.
    private let trustDirectory: TrustDirectory<StoreOf>
    private(set) var active = true

    /// The credential, readable off the main actor by the bridge.
    final class TokenBox: @unchecked Sendable {
        private let lock = NSLock()
        private var token: String?
        init(_ token: String?) { self.token = token }
        var value: String? {
            get { lock.withLock { token } }
            set { lock.withLock { token = newValue } }
        }
    }

    init(origin: URL, token: String?, directory: URL) {
        self.origin = origin
        self.directory = directory
        tokenBox = TokenBox(token)
        trustDirectory = TrustDirectories.of(directory)
    }

    var token: String? {
        get { tokenBox.value }
        set { tokenBox.value = newValue }
    }

    var credential: @Sendable () -> String? {
        let box = tokenBox
        return { box.value }
    }

    func client(_ transport: HTTPTransport) -> PlatformClient {
        PlatformClient(origin: origin, credential: credential, transport: transport)
    }

    /// Runs `body` with the instance's trust store, first brought up to the
    /// instance's material (a newer revocation list applies before any package
    /// opens). Not for a session that ended, and never at the same time as
    /// another session's work on the same store.
    func withTrust<T>(_ client: PlatformClient, _ body: (NshTrust) async throws -> T) async throws -> T {
        guard active else { throw PlatformError(code: "unauthenticated", message: "Sign in to this instance again.") }
        let material = try await client.runtimeTrust()
        return try await trustDirectory.use(material: material, active: { active }) { try await body($0.trust) }
    }

    func retire() {
        active = false
        tokenBox.value = nil
    }
}

/// The one trust store per instance directory, for the life of the process.
@MainActor
private enum TrustDirectories {
    static var all: [String: TrustDirectory<StoreOf>] = [:]

    static func of(_ directory: URL) -> TrustDirectory<StoreOf> {
        if let existing = all[directory.path] { return existing }
        let created = TrustDirectory<StoreOf>(
            refresh: TrustRefresh(
                marker: directory.appendingPathComponent("trust/revocations-sequence"),
                state: directory.appendingPathComponent("trust/nsh-trust.json")),
            open: { StoreOf(try NshTrust(stateDirectory: directory.appendingPathComponent("trust"))) },
            fresh: {
                let dir = directory.appendingPathComponent("trust-probe-\(UUID().uuidString)", isDirectory: true)
                return StoreOf(try NshTrust(stateDirectory: dir), removing: dir)
            })
        all[directory.path] = created
        return created
    }
}

/// An `NshTrust` as `TrustRefresh` sees it; a probe's directory goes with it.
private final class StoreOf: TrustStore {
    let trust: NshTrust
    let directory: URL?
    private var roots: Set<String> = []
    init(_ trust: NshTrust, removing directory: URL? = nil) {
        self.trust = trust
        self.directory = directory
    }
    deinit { if let directory { try? FileManager.default.removeItem(at: directory) } }
    func addRoot(_ publicKey: String) throws {
        guard !roots.contains(publicKey) else { return }
        try trust.addRoot(publicKey)
        roots.insert(publicKey)
    }
    func updateRevocations(_ json: String) throws { try trust.updateRevocations(json) }
}

/// One running App: its engine, its bridge and what it last reported.
@MainActor
final class AppEngine {
    let appId: String
    let view: NshAppView
    let bridge: HostBridge
    let session: EngineSession
    var state: AppEngineState = .loading
    var title: String?
    var build: Int?
    weak var listener: AppEngineListener?
    var task: Task<Void, Never>?

    init(appId: String, view: NshAppView, bridge: HostBridge, session: EngineSession) {
        self.appId = appId
        self.view = view
        self.bridge = bridge
        self.session = session
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
    private var session: EngineSession?
    private let transport = URLSessionTransport()
    /// Apps whose package is being fetched or opened: one load per App at a
    /// time, since they share its cache directory.
    private var packageBusy: Set<String> = []
    private var packageWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var engines: [String: AppEngine] = [:]
    /// Where each App is shown now; kept when its engine stops, so an App
    /// stopped while its page stayed open starts again when the app returns.
    private var containers: [String: UIView] = [:]
    private var listeners: [String: WeakListener] = [:]
    private let ledger: RunLedger
    private var appActive = UIApplication.shared.applicationState != .background
    private var waitTimer: Timer?
    private var themeJSON: String?
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

    private func cacheRoot(_ origin: URL) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("hatch-apps/\(InstanceKey.of(origin))", isDirectory: true)
    }

    /// The signed-in instance and its session credential. Another instance,
    /// or none, stops every App.
    public func configure(origin: URL?, token: String?) {
        if let session, session.origin == origin, token != nil {
            // The same instance with a renewed credential: its work goes on.
            session.token = token
            return
        }
        stopAll()
        containers = [:]
        listeners = [:]
        ledger.reset()
        session?.retire()
        session = nil
        // Storage a sign-out could not delete yet is never handed to the next session.
        if let origin, let token, AppStorage.ready(Self.directory(of: origin)) {
            session = EngineSession(origin: origin, token: token, directory: Self.directory(of: origin))
        }
    }

    private static func directory(of origin: URL) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("hatch-apps/\(InstanceKey.of(origin))", isDirectory: true)
    }

    /// Deletes what Apps saved on this phone for `origin` (their storage),
    /// when its account signs out: the next account must not find it. The
    /// instance's engines stop first (`configure`).
    public func forgetStorage(origin: URL) throws {
        guard session?.origin != origin else { return }
        guard AppStorage.forget(Self.directory(of: origin)) else {
            throw PlatformError(code: "internal", message: "Could not delete the Apps' data on this device.")
        }
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
        guard let session, let scope = AppScope(appId: appId, deploymentId: "", rpcMethods: [:], hasData: false)
        else {
            let failed = AppEngineState.failed(code: "unauthenticated", message: "Sign in to this instance again.")
            listener?.engineStateChanged(failed)
            return failed
        }
        let start = route ?? ledger.route(of: appId) ?? ""
        for victim in ledger.start(appId, route: start) { stopEngine(victim) }
        let shell = EngineShell(appId: appId, manager: self)
        let bridge = HostBridge(
            origin: session.origin, scope: scope, credential: session.credential, transport: transport, shell: shell)
        let view = NshAppView()
        let engine = AppEngine(appId: appId, view: view, bridge: bridge, session: session)
        shell.engine = engine
        engine.listener = listener
        engines[appId] = engine
        let cacheRoot = cacheRoot(session.origin)
        engine.task = Task { [weak self] in
            await self?.load(engine, route: start, instanceDirectory: session.directory, cacheRoot: cacheRoot)
        }
        updateVisibility()
        return engine.state
    }

    private func acquirePackage(_ appId: String) async {
        if packageBusy.contains(appId) {
            await withCheckedContinuation { packageWaiters[appId, default: []].append($0) }
        } else {
            packageBusy.insert(appId)
        }
    }

    private func releasePackage(_ appId: String) {
        if var waiting = packageWaiters[appId], !waiting.isEmpty {
            // The next load takes the App's turn as this one hands it over.
            let next = waiting.removeFirst()
            packageWaiters[appId] = waiting.isEmpty ? nil : waiting
            next.resume()
        } else {
            packageBusy.remove(appId)
        }
    }

    private func load(_ engine: AppEngine, route: String, instanceDirectory: URL, cacheRoot: URL) async {
        let client = engine.session.client(transport)
        do {
            var app = try await client.describeApp(engine.appId)
            if app.archived {
                throw PlatformError(
                    code: "failed_precondition", publicCode: "APP_ARCHIVED", message: "This App is archived.")
            }
            guard app.runtime == "native" else {
                throw PlatformError(
                    code: "failed_precondition", publicCode: "APP_NOT_NATIVE",
                    message: "This App has a web frontend.")
            }
            await acquirePackage(engine.appId)
            defer { releasePackage(engine.appId) }
            guard engines[engine.appId] === engine else { return }
            let packages = cacheRoot.appendingPathComponent("packages/\(engine.appId)", isDirectory: true)
            var file = app.packageBuild.map { packages.appendingPathComponent("\($0).nshpkg") }
            var deploymentId = app.deploymentId ?? ""
            if file == nil || !FileManager.default.fileExists(atPath: file!.path) {
                let target = packages.appendingPathComponent("download-\(UUID().uuidString).nshpkg")
                let downloaded: AppPackageInfo
                do {
                    downloaded = try await client.downloadPackage(
                        appId: engine.appId, to: target, hasher: SHA256Hasher())
                } catch {
                    try? FileManager.default.removeItem(at: target)
                    throw error
                }
                let named = packages.appendingPathComponent("\(downloaded.build).nshpkg")
                if FileManager.default.fileExists(atPath: named.path) {
                    _ = try FileManager.default.replaceItemAt(named, withItemAt: target)
                } else {
                    try FileManager.default.moveItem(at: target, to: named)
                }
                // Only the live build is kept.
                for old in (try? FileManager.default.contentsOfDirectory(at: packages, includingPropertiesForKeys: nil))
                    ?? [] where old.lastPathComponent != named.lastPathComponent
                {
                    try? FileManager.default.removeItem(at: old)
                }
                file = named
                deploymentId = downloaded.deploymentId
                // The package is the live one now: describe that deployment.
                if deploymentId != app.deploymentId {
                    app = try await client.describeApp(engine.appId)
                    guard app.deploymentId == deploymentId else {
                        throw PlatformError(code: "unavailable", message: "The App changed while it opened. Try again.")
                    }
                }
            }
            guard engines[engine.appId] === engine, let file else { return }
            let package: NshPackage = try await engine.session.withTrust(client) { trust in
                do {
                    return try await trust.openPackage(at: file)
                } catch {
                    // A cached package the store refuses (revoked, or older than
                    // one it accepted) is fetched again when the App next opens.
                    try? FileManager.default.removeItem(at: file)
                    throw PlatformError(code: "failed_precondition", message: "\(error)")
                }
            }
            guard engines[engine.appId] === engine else { return }
            let build = Int(package.info.build)
            engine.bridge.scope = AppScope(
                appId: engine.appId, deploymentId: deploymentId, rpcMethods: app.rpcMethods, hasData: app.hasData)!
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
        // A stopped App's page still listens: its listener outlives the engine.
        let listener = engines[appId]?.listener ?? listeners[appId]?.listener
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
        // Its replacement starts hidden until shown: it is told so then.
        lastVisible.remove(appId)
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
        let wait = ContinuousClock.now.duration(to: nextDue).components
        let delay = min(max(0.5, Double(wait.seconds) + Double(wait.attoseconds) / 1e18), 60)
        waitTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleWait() }
        }
    }

    // MARK: - From the bridge

    /// Calls queued for an engine that was since replaced are dropped.
    fileprivate func engineSetTitle(_ engine: AppEngine, _ title: String?) {
        guard engines[engine.appId] === engine else { return }
        engine.title = title
        engine.listener?.engineTitleChanged(title)
    }

    fileprivate func engineSetRoute(_ engine: AppEngine, _ route: String) {
        guard engines[engine.appId] === engine else { return }
        ledger.setRoute(route, of: engine.appId)
        engine.listener?.engineRouteChanged(route)
    }

    fileprivate func engineOpen(_ engine: AppEngine, slug: String, route: String) -> Bool {
        guard engines[engine.appId] === engine else { return false }
        return delegate?.engineManager(openApp: slug, route: route, origin: engine.session.origin.absoluteString) ?? false
    }

    fileprivate func engineUnauthorized() {
        delegate?.engineManagerUnauthorized()
    }

    /// A newer deployment went live (the Data API said so, or the app came
    /// back to the front): running Apps keep their code and are told.
    fileprivate func refreshDeployments(_ only: String? = nil) {
        for engine in engines.values where only == nil || engine.appId == only {
            guard let build = engine.build else { continue }
            let client = engine.session.client(transport)
            Task { [weak self, weak engine] in
                guard let appId = engine?.appId, let app = try? await client.describeApp(appId),
                    let live = app.packageBuild, live != build, let engine, self?.engines[appId] === engine
                else { return }
                // A failed engine keeps its failure: reloading runs the new build anyway.
                if case .failed = engine.state { return }
                engine.view.send(HostEvents.update, [String: Any]())
                engine.setState(.updateAvailable(build: live))
            }
        }
    }

    fileprivate func engineDeploymentStale(_ engine: AppEngine) {
        guard engines[engine.appId] === engine else { return }
        refreshDeployments(engine.appId)
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
    /// The engine this shell serves (set once, on the main actor).
    weak var engine: AppEngine?

    init(appId: String, manager: AppEngineManager) {
        self.appId = appId
        self.manager = manager
    }

    func themeJSON() async -> String? { await MainActor.run { manager?.currentTheme } }
    func setTitle(_ title: String?) async {
        await MainActor.run { if let engine { manager?.engineSetTitle(engine, title) } }
    }
    func setRoute(_ route: String) async {
        await MainActor.run { if let engine { manager?.engineSetRoute(engine, route) } }
    }
    func openApp(slug: String, route: String) async -> Bool {
        await MainActor.run {
            guard let engine else { return false }
            return manager?.engineOpen(engine, slug: slug, route: route) ?? false
        }
    }
    func unauthorized() async { await MainActor.run { manager?.engineUnauthorized() } }
    func deploymentStale() async {
        await MainActor.run { if let engine { manager?.engineDeploymentStale(engine) } }
    }
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
