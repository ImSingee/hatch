import Foundation

/// What Apps save on this device: per instance, then per account
/// (`<instance>/accounts/<account key>/storage/<App id>`), so an account never
/// opens what another one saved, even if deleting it failed. Signing out
/// deletes every account's App storage for the instance.
public enum AppStorage {
    private static let accounts = "accounts"
    private static let forgottenPrefix = "accounts-forgotten-"
    private static let lock = NSLock()

    /// Where an account's Apps keep their storage on this instance.
    public static func accountDirectory(_ instanceDirectory: URL, accountKey: String) -> URL {
        instanceDirectory.appendingPathComponent("\(accounts)/\(accountKey)", isDirectory: true)
    }

    /// Deletes what Apps saved for the instance; false when some of it is still there.
    @discardableResult
    public static func forget(_ instanceDirectory: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        let all = instanceDirectory.appendingPathComponent(accounts)
        if files.fileExists(atPath: all.path) {
            // Out of the way first, in one step, then deleted.
            let forgotten = instanceDirectory.appendingPathComponent("\(forgottenPrefix)\(UUID().uuidString)")
            if (try? files.moveItem(at: all, to: forgotten)) == nil { try? files.removeItem(at: all) }
        }
        var left = files.fileExists(atPath: all.path)
        for name in (try? files.contentsOfDirectory(atPath: instanceDirectory.path)) ?? []
        where name.hasPrefix(forgottenPrefix) {
            if (try? files.removeItem(at: instanceDirectory.appendingPathComponent(name))) == nil { left = true }
        }
        return !left
    }
}
