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
///   store took the list but did not save it: a store opened again from what
///   is saved (`reopen`) takes it and saves it, or the open fails and the next
///   one tries again.
public final class TrustRefresh {
    private let marker: URL
    private let state: URL
    private var roots: Set<String> = []

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
        for root in material.roots where !roots.contains(root) {
            try store.addRoot(root)
            roots.insert(root)
        }
        guard let list = material.revocations else { return }
        let applied = (try? String(contentsOf: marker, encoding: .utf8))
            .flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
        guard material.revocationSequence > applied else { return }
        do {
            try store.updateRevocations(list)
        } catch {
            if !saves(list) {
                guard applies(try fresh(), list) else {
                    throw PlatformError(
                        code: "failed_precondition", message: "The instance's revocation list is not valid.")
                }
                guard applies(try reopen(), list) else {
                    throw PlatformError(code: "unavailable", message: "Could not save the instance's revocation list.")
                }
            }
        }
        try FileManager.default.createDirectory(
            at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try String(material.revocationSequence).write(to: marker, atomically: true, encoding: .utf8)
    }

    private func applies(_ store: TrustStore, _ list: String) -> Bool {
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
