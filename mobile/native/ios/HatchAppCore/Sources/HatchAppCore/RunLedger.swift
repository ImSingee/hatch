import Foundation

/// The Desk's run rules for a phone or tablet, without the engines: which
/// Apps run, which one goes first when the limit needs a place, and which
/// have waited off screen long enough to stop. A port of the web Desk's
/// `AppSessionStore` (`src/components/desk/app-sessions.tsx`):
///
/// - one engine per App; opening a running App shows it again;
/// - at the limit (3 on a phone, 6 on a tablet) the App shown least
///   recently stops first (an App on screen counts as shown now);
/// - an App off screen (its page closed, or the whole app in the
///   background) starts its background time; when it has waited the user's
///   background minutes it stops;
/// - a stopped App's route is remembered, so it reopens there.
public final class RunLedger {
    public static let phoneLimit = 3
    public static let tabletLimit = 6
    public static let defaultBackgroundMinutes = 5

    public private(set) var limit: Int
    public var backgroundTimeout: TimeInterval
    /// Running Apps in the order they were started.
    public private(set) var running: [String] = []
    private var shownAt: [String: Int] = [:]
    /// When each App left the screen, on a clock that neither jumps with the
    /// wall clock nor stops while the device sleeps.
    private var hiddenAt: [String: ContinuousClock.Instant] = [:]
    private var visible: Set<String> = []
    private var remembered: [String: String] = [:]
    private var routes: [String: String] = [:]
    private var clock = 0

    public init(limit: Int, backgroundMinutes: Int = RunLedger.defaultBackgroundMinutes) {
        self.limit = max(1, limit)
        self.backgroundTimeout = TimeInterval(max(1, backgroundMinutes) * 60)
    }

    public func setBackgroundMinutes(_ minutes: Int) {
        backgroundTimeout = TimeInterval(max(1, minutes) * 60)
    }

    private func tick() -> Int {
        clock += 1
        return clock
    }

    public func isRunning(_ app: String) -> Bool { running.contains(app) }

    /// The route an App reopens at: its live one while it runs, else the
    /// one it had when it stopped.
    public func route(of app: String) -> String? { routes[app] ?? remembered[app] }

    public func setRoute(_ route: String, of app: String) {
        if isRunning(app) { routes[app] = route }
    }

    /// Starts `app` (it is about to be shown) and returns the Apps to stop
    /// for it, least recently shown first. Their routes are remembered.
    @discardableResult
    public func start(_ app: String, route: String, now: ContinuousClock.Instant = .now) -> [String] {
        if isRunning(app) { return [] }
        var victims: [String] = []
        while running.count >= limit {
            let ranked = running.min { rank($0) < rank($1) }
            guard let victim = ranked else { break }
            victims.append(victim)
            stopped(victim)
        }
        running.append(app)
        routes[app] = route
        remembered[app] = nil
        shownAt[app] = tick()
        if !visible.contains(app) { hiddenAt[app] = now }
        return victims
    }

    private func rank(_ app: String) -> Double {
        visible.contains(app) ? .infinity : Double(shownAt[app] ?? 0)
    }

    private func stopped(_ app: String) {
        if let route = routes[app] { remembered[app] = route }
        running.removeAll { $0 == app }
        routes[app] = nil
        hiddenAt[app] = nil
        shownAt[app] = nil
    }

    /// Stops `app` (closed, failed, or signed out) and remembers its route.
    public func stop(_ app: String) {
        if isRunning(app) { stopped(app) }
    }

    /// Forgets everything (another instance or account).
    public func reset() {
        running = []
        shownAt = [:]
        hiddenAt = [:]
        visible = []
        remembered = [:]
        routes = [:]
    }

    /// Which Apps are on screen now. One that leaves the screen starts its
    /// background time; one that comes back is stamped as shown.
    public func setVisible(_ apps: Set<String>, now: ContinuousClock.Instant = .now) {
        for app in running {
            if apps.contains(app) {
                hiddenAt[app] = nil
            } else if hiddenAt[app] == nil {
                hiddenAt[app] = now
            }
            if apps.contains(app) != visible.contains(app) { shownAt[app] = tick() }
        }
        visible = apps
    }

    /// Stops every App that has waited off screen for the background time,
    /// and returns them with when the next waiting App is due (nil when
    /// none waits).
    public func stopWaiting(now: ContinuousClock.Instant = .now) -> (stopped: [String], nextDue: ContinuousClock.Instant?) {
        let expired = running.filter { app in
            guard let since = hiddenAt[app] else { return false }
            return since + .seconds(backgroundTimeout) <= now
        }
        for app in expired { stopped(app) }
        let next = running.compactMap { hiddenAt[$0].map { $0 + .seconds(backgroundTimeout) } }.min()
        return (expired, next)
    }
}
