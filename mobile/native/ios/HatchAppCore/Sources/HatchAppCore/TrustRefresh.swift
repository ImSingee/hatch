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
/// NSH takes only a newer list and checks its signature first. So when the
/// store refuses a list the marker calls newer (the marker was not written
/// after the store took it), a store with nothing applied (`fresh`) settles
/// it: if that one takes the list, it is valid and the store already has it
/// or a newer one; if not, the list is not valid and nothing opens.
public final class TrustRefresh {
    private let marker: URL
    private var roots: Set<String> = []

    public init(marker: URL) {
        self.marker = marker
    }

    public func refresh(_ store: TrustStore, material: RuntimeTrust, fresh: () throws -> TrustStore) throws {
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
            let probe = try fresh()
            for root in roots { try probe.addRoot(root) }
            do {
                try probe.updateRevocations(list)
            } catch {
                throw PlatformError(code: "failed_precondition", message: "The instance's revocation list is not valid.")
            }
        }
        try FileManager.default.createDirectory(
            at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try String(material.revocationSequence).write(to: marker, atomically: true, encoding: .utf8)
    }
}
