import Foundation
import XCTest

@testable import HatchAppCore

/// Byte sum, standing in for SHA-256 (the runtimes use CryptoKit and
/// MessageDigest); enough to check that every chunk is hashed in order.
struct SumHasher: PackageHasher {
    var sum = 0
    mutating func update(_ data: Data) { for byte in data { sum = (sum &* 31 &+ Int(byte)) & 0xffff_ffff } }
    func hexDigest() -> String { String(sum, radix: 16) }
}

final class PlatformClientTests: XCTestCase {
    func frame(_ object: Any, end: Bool = false) -> Data {
        let payload = try! JSONSerialization.data(withJSONObject: object)
        var out = PlatformClient.envelope(payload)
        if end { out[0] = 0x02 }
        return out
    }

    func stream(_ bytes: Data, size: Int? = nil, sha: String? = nil, end: Any = [String: Any]()) -> Data {
        var hasher = SumHasher()
        hasher.update(bytes)
        var body = frame([
            "package": [
                "appId": "app1", "deploymentId": "dep1", "version": 2, "build": 7, "nshAppId": "dev.hatch.app.app1",
                "sha256": sha ?? hasher.hexDigest(), "size": size ?? bytes.count, "keyId": "k1",
            ]
        ])
        let half = bytes.count / 2
        body.append(frame(["chunk": bytes.prefix(half).base64EncodedString()]))
        body.append(frame(["chunk": bytes.suffix(from: half).base64EncodedString()]))
        body.append(frame(end, end: true))
        return body
    }

    func testReadsAVerifiedPackage() throws {
        let bytes = Data((0..<1000).map { UInt8($0 % 251) })
        let (info, data) = try PlatformClient.readPackage(stream(bytes), hasher: SumHasher())
        XCTAssertEqual(info.build, 7)
        XCTAssertEqual(info.deploymentId, "dep1")
        XCTAssertEqual(data, bytes)
    }

    func testRefusesAPackageThatDoesNotMatch() {
        let bytes = Data([1, 2, 3, 4])
        XCTAssertThrowsError(try PlatformClient.readPackage(stream(bytes, size: 5), hasher: SumHasher()))
        XCTAssertThrowsError(try PlatformClient.readPackage(stream(bytes, sha: "0"), hasher: SumHasher()))
        var truncated = stream(bytes)
        truncated.removeLast(3)
        XCTAssertThrowsError(try PlatformClient.readPackage(truncated, hasher: SumHasher()))
        // No end frame: the stream did not finish.
        var unfinished = stream(bytes)
        unfinished.removeLast(PlatformClient.envelope(Data("{}".utf8)).count)
        XCTAssertThrowsError(try PlatformClient.readPackage(unfinished, hasher: SumHasher()))
    }

    func testAnErrorInTheEndFrameCarriesItsCodes() {
        let body = frame(
            [
                "error": [
                    "code": "failed_precondition", "message": "This App has a web frontend.",
                    "details": [["type": "hatch.platform.v1.PublicError", "debug": ["code": "APP_NOT_NATIVE"]]],
                ]
            ], end: true)
        XCTAssertThrowsError(try PlatformClient.readPackage(body, hasher: SumHasher())) { error in
            XCTAssertEqual(error as? PlatformError, PlatformError(
                code: "failed_precondition", publicCode: "APP_NOT_NATIVE", message: "This App has a web frontend."))
        }
    }

    func testDescribesAnAppFromItsView() async throws {
        let transport = FakeTransport()
        transport.answer = { _ in
            let view: [String: Any] = [
                "id": "app1", "slug": "notes", "name": "Notes", "currentDeploymentId": "dep9",
                "capabilities": ["frontend", "backend", "dataTable"],
                "frontend": ["runtime": "native", "packageBuild": 4],
                "manifest": [
                    "api": [
                        "services": [
                            [
                                "name": "app.v1.Notes",
                                "methods": [
                                    ["name": "List", "clientStreaming": false, "serverStreaming": false],
                                    ["name": "Watch", "clientStreaming": false, "serverStreaming": true],
                                ],
                            ]
                        ]
                    ]
                ],
            ]
            return HTTPResponse(
                status: 200, body: try! JSONSerialization.data(withJSONObject: ["resource": ["view": view]]))
        }
        let client = PlatformClient(
            origin: URL(string: "https://hatch.example.test")!, credential: { "t" }, transport: transport)
        let app = try await client.describeApp("notes")
        XCTAssertEqual(app.runtime, "native")
        XCTAssertEqual(app.packageBuild, 4)
        XCTAssertEqual(app.deploymentId, "dep9")
        XCTAssertEqual(app.rpcMethods, ["app.v1.Notes": ["List"]])
        XCTAssertTrue(app.hasData)
        XCTAssertEqual(
            transport.requests.first?.url.absoluteString,
            "https://hatch.example.test/api/rpc/hatch.platform.v1.AppService/GetApp")
        XCTAssertEqual(transport.requests.first?.headers["authorization"], "Bearer t")
    }
}

final class RunLedgerTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_000_000)

    func testTheLeastRecentlyShownAppStopsAtTheLimit() {
        let ledger = RunLedger(limit: 3)
        for (index, app) in ["a", "b", "c"].enumerated() {
            ledger.setVisible([app], now: start + Double(index))
            ledger.start(app, route: "r-\(app)", now: start + Double(index))
        }
        ledger.setVisible(["c"], now: start + 3)
        ledger.setRoute("a-later", of: "a")
        // "a" was shown first and is off screen: it makes room for "d".
        let victims = ledger.start("d", route: "", now: start + 4)
        XCTAssertEqual(victims, ["a"])
        XCTAssertEqual(ledger.running, ["b", "c", "d"])
        XCTAssertEqual(ledger.route(of: "a"), "a-later")
        // Opening a running App starts nothing.
        XCTAssertEqual(ledger.start("c", route: "x"), [])
    }

    func testAnAppOnScreenIsNeverTheOneStopped() {
        let ledger = RunLedger(limit: 2)
        ledger.setVisible(["a"], now: start)
        ledger.start("a", route: "", now: start)
        ledger.start("b", route: "", now: start + 1)
        ledger.setVisible(["a"], now: start + 2)
        XCTAssertEqual(ledger.start("c", route: "", now: start + 3), ["b"])
    }

    func testHiddenAppsStopAfterTheBackgroundTime() {
        let ledger = RunLedger(limit: 3, backgroundMinutes: 5)
        ledger.setVisible(["a"], now: start)
        ledger.start("a", route: "orders/7", now: start)
        ledger.start("b", route: "", now: start)
        ledger.setVisible(["b"], now: start + 60)
        var result = ledger.stopWaiting(now: start + 299)
        XCTAssertEqual(result.stopped, [])
        XCTAssertEqual(result.nextDue, start + 360)
        result = ledger.stopWaiting(now: start + 360)
        XCTAssertEqual(result.stopped, ["a"])
        XCTAssertEqual(ledger.route(of: "a"), "orders/7")
        XCTAssertNil(result.nextDue)
        // The whole app in the background: every App starts waiting.
        ledger.setVisible([], now: start + 400)
        XCTAssertEqual(ledger.stopWaiting(now: start + 699).stopped, [])
        XCTAssertEqual(ledger.stopWaiting(now: start + 700).stopped, ["b"])
    }

    func testShowingAnAppAgainResetsItsWait() {
        let ledger = RunLedger(limit: 3, backgroundMinutes: 1)
        ledger.start("a", route: "", now: start)
        ledger.setVisible([], now: start)
        ledger.setVisible(["a"], now: start + 50)
        ledger.setVisible([], now: start + 55)
        XCTAssertEqual(ledger.stopWaiting(now: start + 100).stopped, [])
        XCTAssertEqual(ledger.stopWaiting(now: start + 115).stopped, ["a"])
    }
}
