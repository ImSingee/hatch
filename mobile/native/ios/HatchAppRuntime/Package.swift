// swift-tools-version:5.9
// Hatch's native App runtime on iOS: one NSH engine per App, owned here and
// not by any view, verified packages, the fixed grant and the host bridge.
// Depends on UIKit and NSH only (no React Native, no Expo). Needs the NSH SDK
// in ../vendor (`node ../../scripts/fetch-nsh-sdk.mjs ios`).
import PackageDescription

let package = Package(
    name: "HatchAppRuntime",
    platforms: [.iOS("16.4")],
    products: [.library(name: "HatchAppRuntime", targets: ["HatchAppRuntime"])],
    dependencies: [.package(path: "../HatchAppCore")],
    targets: [
        .binaryTarget(name: "NativeShell", path: "../vendor/NativeShell.xcframework"),
        .target(
            name: "HatchAppRuntime",
            dependencies: ["NativeShell", .product(name: "HatchAppCore", package: "HatchAppCore")],
            // NSH 0.7.0's static framework does not auto-link Network.
            linkerSettings: [.linkedFramework("Network")]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
