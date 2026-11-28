import Foundation

/// What Apps saved on this device for one instance (`<instance>/storage`),
/// forgotten when the instance's account signs out so the next account there
/// finds none of it. A deletion that fails is not forgotten: a marker stays
/// until it succeeds, and the storage is not used again before then.
public enum AppStorage {
    private static let pending = "storage-forget-pending"

    /// Deletes the instance's App storage; false when some of it is still there.
    @discardableResult
    public static func forget(_ instanceDirectory: URL) -> Bool {
        try? FileManager.default.createDirectory(at: instanceDirectory, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: instanceDirectory.appendingPathComponent(pending).path, contents: Data())
        return clear(instanceDirectory)
    }

    /// Whether the instance's App storage may be used, finishing a deletion left pending.
    public static func ready(_ instanceDirectory: URL) -> Bool {
        !FileManager.default.fileExists(atPath: instanceDirectory.appendingPathComponent(pending).path)
            || clear(instanceDirectory)
    }

    private static func clear(_ instanceDirectory: URL) -> Bool {
        let files = FileManager.default
        let storage = instanceDirectory.appendingPathComponent("storage")
        if files.fileExists(atPath: storage.path) {
            guard (try? files.removeItem(at: storage)) != nil else { return false }
        }
        return (try? files.removeItem(at: instanceDirectory.appendingPathComponent(pending))) != nil
    }
}
