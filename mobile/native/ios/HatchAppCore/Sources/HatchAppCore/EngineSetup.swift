import Foundation

/// Everything a runtime sets on an NSH view before it runs an App's package.
/// Built in one place, so every engine gets the same grant and limits.
public struct EngineSetup: Equatable {
    /// The JS heap of one engine, as on the web Desk.
    public static let heapMegabytes: UInt32 = 96

    public let heapMegabytes: UInt32
    /// The capabilities document for `grantCapabilities`: never nil.
    public let grant: String
    /// `host.params`: the platform (`@hatch/ui` takes its look), the route
    /// the App opens at and the package's build number.
    public let params: [String: AnyHashable]
    /// Where the App keeps `Storage` (per instance, account and App) and NSH
    /// its caches.
    public let storageDirectory: URL
    public let cacheDirectory: URL

    public init(
        platform: String, route: String, packageBuild: Int, appId: String, accountDirectory: URL,
        cacheRoot: URL
    ) {
        heapMegabytes = Self.heapMegabytes
        grant = HostCalls.grant
        params = ["platform": platform, "route": route, "packageBuild": packageBuild]
        storageDirectory = accountDirectory.appendingPathComponent("storage/\(appId)", isDirectory: true)
        cacheDirectory = cacheRoot.appendingPathComponent("nsh", isDirectory: true)
    }
}

/// A stable directory name for an instance origin (its URL may hold
/// characters a path cannot).
public enum InstanceKey {
    public static func of(_ origin: URL) -> String {
        // FNV-1a 64: stable across launches and platforms, unlike `hashValue`.
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in origin.absoluteString.lowercased().utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}
