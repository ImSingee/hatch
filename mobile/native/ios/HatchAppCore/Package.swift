// swift-tools-version:5.9
// Host-independent core of Hatch's native App runtime: the host bridge, the
// platform client and the run rules. Foundation only, so it builds and tests
// anywhere Swift runs (CI runs `swift test` here on Linux).
import PackageDescription

let package = Package(
    name: "HatchAppCore",
    platforms: [.iOS("16.4"), .macOS(.v13)],
    products: [.library(name: "HatchAppCore", targets: ["HatchAppCore"])],
    targets: [
        .target(name: "HatchAppCore"),
        .testTarget(name: "HatchAppCoreTests", dependencies: ["HatchAppCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
