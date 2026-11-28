import Foundation

/// What Apps saved on this device for one instance (`<instance>/storage`),
/// forgotten when the instance's account signs out so the next account there
/// finds none of it. Until the storage is gone, it is not used again: a
/// deletion that fails stays pending, on disk (a marker) and in this process
/// (in case the marker could not be written either).
public enum AppStorage {
    private static let pendingMarker = "storage-forget-pending"
    private static let forgottenPrefix = "storage-forgotten-"
    private static let lock = NSLock()
    /// Instance directories with a deletion pending in this process.
    private final class Pending: @unchecked Sendable { var paths: Set<String> = [] }
    private static let pending = Pending()

    /// Deletes the instance's App storage; false when some of it is still there.
    @discardableResult
    public static func forget(_ instanceDirectory: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        pending.paths.insert(instanceDirectory.path)
        try? FileManager.default.createDirectory(at: instanceDirectory, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: instanceDirectory.appendingPathComponent(pendingMarker).path, contents: Data())
        return clear(instanceDirectory)
    }

    /// Whether the instance's App storage may be used, finishing a deletion left pending.
    public static func ready(_ instanceDirectory: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if pending.paths.contains(instanceDirectory.path)
            || FileManager.default.fileExists(atPath: instanceDirectory.appendingPathComponent(pendingMarker).path)
        {
            return clear(instanceDirectory)
        }
        sweep(instanceDirectory)
        return true
    }

    private static func clear(_ instanceDirectory: URL) -> Bool {
        let files = FileManager.default
        let storage = instanceDirectory.appendingPathComponent("storage")
        if files.fileExists(atPath: storage.path) {
            // Out of the way first, in one step: nothing reads it there even
            // if deleting it fails.
            let forgotten = instanceDirectory.appendingPathComponent("\(forgottenPrefix)\(UUID().uuidString)")
            if (try? files.moveItem(at: storage, to: forgotten)) == nil { try? files.removeItem(at: storage) }
        }
        guard !files.fileExists(atPath: storage.path) else { return false }
        sweep(instanceDirectory)
        try? files.removeItem(at: instanceDirectory.appendingPathComponent(pendingMarker))
        pending.paths.remove(instanceDirectory.path)
        return true
    }

    private static func sweep(_ instanceDirectory: URL) {
        let files = FileManager.default
        for name in (try? files.contentsOfDirectory(atPath: instanceDirectory.path)) ?? []
        where name.hasPrefix(forgottenPrefix) {
            try? files.removeItem(at: instanceDirectory.appendingPathComponent(name))
        }
    }
}
