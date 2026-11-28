import Foundation

/// The host functions a Hatch native App may call, and the grant a shell
/// hands NSH for every App it runs.
///
/// The list is the platform's `NATIVE_HOST_CALLS`
/// (`src/server/apps/native/nsh-config.ts`); a repository test keeps them
/// equal. The grant is exactly `{ "host": [...] }`: nothing else (no network,
/// clipboard, files or URLs). It must always be set: without a grant NSH lets
/// a package do whatever it declares.
public enum HostCalls {
    public static let names: [String] = [
        "hatch.rpc",
        "hatch.data.query",
        "hatch.data.mutate",
        "hatch.data.events",
        "hatch.theme.get",
        "hatch.nav.setTitle",
        "hatch.nav.setRoute",
        "hatch.nav.open",
        "hatch.native.supports",
    ]

    /// The capabilities document NSH reads (`grantCapabilities`).
    public static var grant: String {
        let quoted = names.map { "\"\($0)\"" }.joined(separator: ",")
        return "{\"host\":[\(quoted)]}"
    }
}

/// Events a shell sends to a running App (`host.on` in the App).
public enum HostEvents {
    public static let theme = "hatch.theme"
    public static let nav = "hatch.nav"
    public static let visibility = "hatch.visibility"
    public static let update = "hatch.update"
}
