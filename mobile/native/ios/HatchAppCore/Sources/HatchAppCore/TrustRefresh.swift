import Foundation

/// What the runtime needs of NSH's trust store (`NshTrust`).
public protocol TrustStore: AnyObject {
    func addRoot(_ publicKey: String) throws
    /// Applies a signed revocation list; throws when the store refuses it.
    func updateRevocations(_ json: String) throws
}

/// Brings a trust store up to the instance's material before a package is
/// opened: its roots, and its revocation list whenever the instance has a
/// newer one than the store was given (`marker` keeps that sequence).
///
/// NSH takes only a newer list, and it takes a list in memory before saving
/// it to `state` (its `nsh-trust.json`). So when the store refuses a list the
/// marker calls newer, the marker moves only once that list is saved:
/// - `state` already holds this list: the marker's own write was lost.
/// - Otherwise a store with nothing applied (`fresh`) checks the list. If it
///   refuses, the list is not valid and nothing opens. If it takes it, the
///   store took the list but did not save it: the store is opened again from
///   what is saved (`reopen`, which replaces it) and takes the list, saving
///   it, or the open fails and the next one tries again.
///
/// Every store gets the roots: NSH opens a store trusting none.
public final class TrustRefresh {
    private let marker: URL
    private let state: URL

    public init(marker: URL, state: URL) {
        self.marker = marker
        self.state = state
    }

    public func refresh(
        _ store: TrustStore, material: RuntimeTrust, reopen: () throws -> TrustStore,
        fresh: () throws -> TrustStore
    ) throws {
        guard material.initialized else {
            throw PlatformError(code: "failed_precondition", message: "This instance has no native App keys yet.")
        }
        for root in material.roots { try store.addRoot(root) }
        guard let list = material.revocations else { return }
        let applied = (try? String(contentsOf: marker, encoding: .utf8))
            .flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
        guard material.revocationSequence > applied else { return }
        do {
            try store.updateRevocations(list)
        } catch {
            if !saves(list) {
                guard applies(try fresh(), list, material.roots) else {
                    throw PlatformError(
                        code: "failed_precondition", message: "The instance's revocation list is not valid.")
                }
                guard applies(try reopen(), list, material.roots) else {
                    throw PlatformError(code: "unavailable", message: "Could not save the instance's revocation list.")
                }
            }
        }
        try FileManager.default.createDirectory(
            at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try String(material.revocationSequence).write(to: marker, atomically: true, encoding: .utf8)
    }

    private func applies(_ store: TrustStore, _ list: String, _ roots: [String]) -> Bool {
        do {
            for root in roots { try store.addRoot(root) }
            try store.updateRevocations(list)
            return true
        } catch {
            return false
        }
    }

    /// Whether the saved state holds `list` itself.
    private func saves(_ list: String) -> Bool {
        guard let data = try? Data(contentsOf: state),
            let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let revocations = saved["revocations"]
        else { return false }
        let wanted = (try? JSONSerialization.jsonObject(with: Data(list.utf8), options: .fragmentsAllowed)) ?? list
        return Self.canonical(revocations) != nil && Self.canonical(revocations) == Self.canonical(wanted)
    }

    private static func canonical(_ value: Any) -> Data? {
        try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    }
}

/// The one trust store of an instance's trust directory, shared by every
/// session for that instance. NSH saves a store's whole state at once, so a
/// second store on the same directory could write back what it read before
/// the first saved (a revocation list, an accepted build). One store, and one
/// caller at a time: refreshing it, replacing it, and whatever `use` runs with
/// it (opening and accepting a package) never overlap, and a session that
/// ended (`active` false) neither refreshes nor uses it.
@MainActor
public final class TrustDirectory<Store: TrustStore> {
    private let refresh: TrustRefresh
    private let open: () throws -> Store
    private let fresh: () throws -> TrustStore
    private var store: Store?
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// Callers waiting for the store now (for tests).
    var waitingCount: Int { waiting.count }

    public init(refresh: TrustRefresh, open: @escaping () throws -> Store, fresh: @escaping () throws -> TrustStore) {
        self.refresh = refresh
        self.open = open
        self.fresh = fresh
    }

    public func use<T>(
        material: RuntimeTrust, active: () -> Bool, _ body: (Store) async throws -> T
    ) async throws -> T {
        if busy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
        defer {
            if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
        }
        guard active() else { throw PlatformError(code: "unauthenticated", message: "Sign in to this instance again.") }
        let current = try store ?? open()
        store = current
        try refresh.refresh(
            current, material: material,
            reopen: {
                let reopened = try open()
                store = reopened
                return reopened
            }, fresh: fresh)
        guard let current = store, active() else {
            throw PlatformError(code: "unauthenticated", message: "Sign in to this instance again.")
        }
        return try await body(current)
    }
}
