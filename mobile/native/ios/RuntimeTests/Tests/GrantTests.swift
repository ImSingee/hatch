import NativeShell
import UIKit
import XCTest

@testable import HatchAppRuntime

#if canImport(HatchAppCore)
    import HatchAppCore
#endif

/// The grant on a real engine, in a test host app (an engine needs
/// UIApplication). The fixture (`mobile/native/fixtures/grant-probe`, built
/// by `mobile/native/scripts/test-ios.sh`) declares every capability and
/// reports what it reached.
@MainActor
final class GrantTests: XCTestCase {
    private func probe(_ configure: (NshAppView) throws -> Void) async throws -> [String: String] {
        let bundle = try XCTUnwrap(
            Bundle(for: GrantTests.self).url(forResource: "bundle", withExtension: "js", subdirectory: "grant-probe"),
            "run mobile/native/scripts/test-ios.sh, which builds the fixture")
        let view = NshAppView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        // An engine runs while its view is in a window.
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        window?.addSubview(view)
        defer { view.removeFromSuperview() }
        var failure: String?
        view.onError = { failure = $0 }
        try configure(view)
        var reached = false
        view.handle("probe.reach") { _ in
            reached = true
            return ["ok": true]
        }
        let reported = expectation(description: "the probe reports")
        var results: [String: String] = [:]
        view.handle("hatch.nav.setTitle") { data in
            let title = (data as? [String: Any])?["title"] as? String ?? "{}"
            results = (try? JSONSerialization.jsonObject(with: Data(title.utf8)) as? [String: String]) ?? [:]
            reported.fulfill()
            return ["ok": true]
        }
        try view.loadBundle(at: bundle)
        await fulfillment(of: [reported], timeout: 20)
        XCTAssertNil(failure)
        results["reached"] = reached ? "yes" : "no"
        return results
    }

    private func setup(_ directory: URL) -> EngineSetup {
        EngineSetup(
            platform: "ios", route: "", packageBuild: 1, appId: "grant-probe", instanceDirectory: directory,
            cacheRoot: directory)
    }

    func testEveryEngineGetsOnlyTheHostCalls() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let results = try await probe { try $0.apply(setup(directory)) }
        XCTAssertEqual(results["fetch"], "ERR_ACCESS_DENIED")
        XCTAssertEqual(results["clipboard"], "ERR_ACCESS_DENIED")
        XCTAssertEqual(results["openUrl"], "ERR_ACCESS_DENIED")
        XCTAssertEqual(results["host"], "ERR_ACCESS_DENIED")
        XCTAssertEqual(results["reached"], "no")
    }

    /// Why the grant must always be set: without one NSH lets a package do
    /// whatever it declares.
    func testWithoutAGrantThePackageGetsWhatItDeclares() async throws {
        let results = try await probe { try $0.grantCapabilities(nil) }
        XCTAssertEqual(results["clipboard"], "OK")
        XCTAssertEqual(results["host"], "OK")
        XCTAssertEqual(results["reached"], "yes")
    }

    func testTheSetupIsTheFixedGrantAndHeap() {
        let directory = URL(fileURLWithPath: "/tmp/instance")
        let setup = setup(directory)
        XCTAssertEqual(setup.grant, HostCalls.grant)
        XCTAssertEqual(setup.heapMegabytes, 96)
        XCTAssertEqual(setup.params["platform"], "ios")
        XCTAssertEqual(setup.params["packageBuild"], 1)
        XCTAssertEqual(setup.storageDirectory.path, "/tmp/instance/storage/grant-probe")
    }
}
