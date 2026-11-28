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
        // An end frame that is not a JSON object did not finish it either.
        var malformed = unfinished
        var end = PlatformClient.envelope(Data("{".utf8))
        end[0] = 0x02
        malformed.append(end)
        XCTAssertThrowsError(try PlatformClient.readPackage(malformed, hasher: SumHasher()))
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
    let start = ContinuousClock.now

    func testTheLeastRecentlyShownAppStopsAtTheLimit() {
        let ledger = RunLedger(limit: 3)
        for (index, app) in ["a", "b", "c"].enumerated() {
            ledger.setVisible([app], now: start + .seconds(index))
            ledger.start(app, route: "r-\(app)", now: start + .seconds(index))
        }
        ledger.setVisible(["c"], now: start + .seconds(3))
        ledger.setRoute("a-later", of: "a")
        // "a" was shown first and is off screen: it makes room for "d".
        let victims = ledger.start("d", route: "", now: start + .seconds(4))
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
        ledger.start("b", route: "", now: start + .seconds(1))
        ledger.setVisible(["a"], now: start + .seconds(2))
        XCTAssertEqual(ledger.start("c", route: "", now: start + .seconds(3)), ["b"])
    }

    func testHiddenAppsStopAfterTheBackgroundTime() {
        let ledger = RunLedger(limit: 3, backgroundMinutes: 5)
        ledger.setVisible(["a"], now: start)
        ledger.start("a", route: "orders/7", now: start)
        ledger.start("b", route: "", now: start)
        ledger.setVisible(["b"], now: start + .seconds(60))
        var result = ledger.stopWaiting(now: start + .seconds(299))
        XCTAssertEqual(result.stopped, [])
        XCTAssertEqual(result.nextDue, start + .seconds(360))
        result = ledger.stopWaiting(now: start + .seconds(360))
        XCTAssertEqual(result.stopped, ["a"])
        XCTAssertEqual(ledger.route(of: "a"), "orders/7")
        XCTAssertNil(result.nextDue)
        // The whole app in the background: every App starts waiting.
        ledger.setVisible([], now: start + .seconds(400))
        XCTAssertEqual(ledger.stopWaiting(now: start + .seconds(699)).stopped, [])
        XCTAssertEqual(ledger.stopWaiting(now: start + .seconds(700)).stopped, ["b"])
    }

    func testShowingAnAppAgainResetsItsWait() {
        let ledger = RunLedger(limit: 3, backgroundMinutes: 1)
        ledger.start("a", route: "", now: start)
        ledger.setVisible([], now: start)
        ledger.setVisible(["a"], now: start + .seconds(50))
        ledger.setVisible([], now: start + .seconds(55))
        XCTAssertEqual(ledger.stopWaiting(now: start + .seconds(100)).stopped, [])
        XCTAssertEqual(ledger.stopWaiting(now: start + .seconds(115)).stopped, ["a"])
    }
}


/// Takes only a newer, validly signed list, as NSH does: in memory first,
/// then saved to `state` (unless `failSave`).
final class FakeTrustStore: TrustStore {
    struct Refused: Error {}
    var sequence: Int
    var roots: [String] = []
    let state: URL?
    var failSave: Bool

    init(sequence: Int = 0, state: URL? = nil, failSave: Bool = false) {
        self.sequence = sequence
        self.state = state
        self.failSave = failSave
    }

    /// A store opened from what `state` holds.
    static func opened(_ state: URL, failSave: Bool = false) -> FakeTrustStore {
        let saved = (try? Data(contentsOf: state))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["revocations"]
        let sequence = saved.flatMap { Int($0.split(separator: ":")[1]) } ?? 0
        return FakeTrustStore(sequence: sequence, state: state, failSave: failSave)
    }

    /// Like NSH, a root it already trusts is not added twice.
    func addRoot(_ publicKey: String) throws { if !roots.contains(publicKey) { roots.append(publicKey) } }

    func updateRevocations(_ json: String) throws {
        let parts = json.split(separator: ":")
        guard parts[0] == "signed", let number = Int(parts[1]), number > sequence else { throw Refused() }
        sequence = number
        guard let state else { return }
        if failSave { throw Refused() }
        try JSONSerialization.data(withJSONObject: ["revocations": json]).write(to: state)
    }
}

final class TrustRefreshTests: XCTestCase {
    private func material(_ sequence: Int, _ list: String? = nil) -> RuntimeTrust {
        RuntimeTrust(
            initialized: true, roots: ["root"], revocations: list ?? "signed:\(sequence)", revocationSequence: sequence)
    }

    private struct Dir {
        let marker: URL
        let state: URL
        init() throws {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("trust-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            marker = dir.appendingPathComponent("sequence")
            state = dir.appendingPathComponent("nsh-trust.json")
        }
        func refresh() -> TrustRefresh { TrustRefresh(marker: marker, state: state) }
        func recorded() -> String? { try? String(contentsOf: marker, encoding: .utf8) }
    }

    private struct NotNeeded: Error {}

    func testAListTheStoreAlreadySavedIsNotAFailure() throws {
        let d = try Dir()
        let store = FakeTrustStore(state: d.state)
        try d.refresh().refresh(store, material: material(8), reopen: { FakeTrustStore.opened(d.state) }) {
            FakeTrustStore()
        }
        // The store saved list 8 but the marker still says 7 (its write was lost).
        try "7".write(to: d.marker, atomically: true, encoding: .utf8)
        try d.refresh().refresh(store, material: material(8), reopen: { throw NotNeeded() }) { throw NotNeeded() }
        XCTAssertEqual(d.recorded(), "8")
        // Newer lists still apply.
        try d.refresh().refresh(store, material: material(9), reopen: { FakeTrustStore.opened(d.state) }) {
            FakeTrustStore()
        }
        XCTAssertEqual(store.sequence, 9)
    }

    func testAListTakenButNotSavedIsSavedBeforeTheMarkerMoves() throws {
        let d = try Dir()
        let store = FakeTrustStore(state: d.state, failSave: true)
        // NSH kept list 8 in memory but could not save it: nothing is recorded.
        XCTAssertThrowsError(
            try d.refresh().refresh(
                store, material: material(8), reopen: { FakeTrustStore.opened(d.state, failSave: true) }
            ) { FakeTrustStore() })
        XCTAssertNil(d.recorded())
        // The next open saves it through a store opened from disk, then records it.
        try d.refresh().refresh(store, material: material(8), reopen: { FakeTrustStore.opened(d.state) }) {
            FakeTrustStore()
        }
        XCTAssertEqual(d.recorded(), "8")
        XCTAssertEqual(FakeTrustStore.opened(d.state).sequence, 8)
    }

    func testAnInvalidNewerListStopsEverything() throws {
        let d = try Dir()
        try "7".write(to: d.marker, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(
            try d.refresh().refresh(
                FakeTrustStore(sequence: 7), material: material(8, "forged:8"), reopen: { FakeTrustStore(sequence: 7) }
            ) { FakeTrustStore() })
        XCTAssertEqual(d.recorded(), "7")
    }

    func testEveryStoreItChecksWithTrustsTheRoots() throws {
        let d = try Dir()
        var probes: [FakeTrustStore] = []
        let store = FakeTrustStore(state: d.state, failSave: true)
        var reopened: [FakeTrustStore] = []
        XCTAssertThrowsError(
            try d.refresh().refresh(
                store, material: material(3),
                reopen: { FakeTrustStore.opened(d.state, failSave: true).also { reopened.append($0) } }
            ) { FakeTrustStore().also { probes.append($0) } })
        XCTAssertEqual(store.roots, ["root"])
        XCTAssertEqual(probes.single?.roots, ["root"])
        XCTAssertEqual(reopened.single?.roots, ["root"])
    }
}

extension FakeTrustStore {
    func also(_ body: (FakeTrustStore) -> Void) -> FakeTrustStore {
        body(self)
        return self
    }
}

extension Array {
    var single: Element? { count == 1 ? first : nil }
}

@MainActor
final class TrustDirectoryTests: XCTestCase {
    private var dir: URL!
    private var state: URL!
    private var opened: [FakeTrustStore] = []
    private var failSave = false

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("trust-dir-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        state = dir.appendingPathComponent("nsh-trust.json")
        opened = []
        failSave = false
    }

    private func directory() -> TrustDirectory<FakeTrustStore> {
        TrustDirectory(
            refresh: TrustRefresh(marker: dir.appendingPathComponent("sequence"), state: state),
            open: { [unowned self] in
                let store = FakeTrustStore.opened(state, failSave: failSave)
                opened.append(store)
                return store
            },
            fresh: { FakeTrustStore() })
    }

    private func material(_ sequence: Int) -> RuntimeTrust {
        RuntimeTrust(initialized: true, roots: ["root"], revocations: "signed:\(sequence)", revocationSequence: sequence)
    }

    func testSessionsShareOneStoreThatTrustsTheRoots() async throws {
        let trust = directory()
        let first = try await trust.use(material: material(1), active: { true }) { $0 }
        // Another session for the same instance (signed in again): the same store.
        let second = try await trust.use(material: material(1), active: { true }) { $0 }
        XCTAssertTrue(first === second)
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(first.roots, ["root"])
    }

    func testAStoreOpenedAgainToSaveAListTrustsTheRoots() async throws {
        let trust = directory()
        failSave = true
        do {
            _ = try await trust.use(material: material(4), active: { true }) { $0 }
            XCTFail("a list that was not saved must not open")
        } catch {}
        failSave = false
        let used = try await trust.use(material: material(4), active: { true }) { $0 }
        XCTAssertTrue(used === opened.last)
        XCTAssertEqual(used.roots, ["root"])
        XCTAssertEqual(FakeTrustStore.opened(state).sequence, 4)
    }

    func testASessionThatEndedNeitherRefreshesNorUsesTheStore() async throws {
        let trust = directory()
        var used = false
        do {
            try await trust.use(material: material(1), active: { false }) { _ in used = true }
            XCTFail("an ended session must not use the store")
        } catch let error as PlatformError {
            XCTAssertEqual(error.code, "unauthenticated")
        }
        XCTAssertFalse(used)
        XCTAssertTrue(opened.isEmpty)
    }

    func testWorkOnTheStoreNeverOverlaps() async throws {
        let trust = directory()
        var order: [String] = []
        let gate = Gate()
        // However the test ends, nothing stays parked.
        defer { gate.open() }
        var firstFailed: Error?
        // A retired session still verifying a package…
        let first = Task {
            do {
                try await trust.use(material: material(1), active: { true }) { _ in
                    await gate.wait()
                    order.append("first done")
                }
            } catch { firstFailed = error }
        }
        try await checkpoint("the first caller verifies", { firstFailed }) { gate.waiting }
        // …and the new session for the same instance, with a newer list.
        let second = Task { try await trust.use(material: material(2), active: { true }) { _ in order.append("second") } }
        try await checkpoint("the second caller waits", { firstFailed }) { trust.waitingCount == 1 }
        XCTAssertEqual(order, [])
        gate.open()
        await first.value
        try await second.value
        XCTAssertNil(firstFailed)
        XCTAssertEqual(order, ["first done", "second"])
        XCTAssertEqual(FakeTrustStore.opened(state).sequence, 2)
    }

    func testASessionRetiredWhileVerifyingFinishesBeforeTheNextOneStarts() async throws {
        let trust = directory()
        var oldActive = true
        var order: [String] = []
        let gate = Gate()
        // However the test ends, nothing stays parked.
        defer { gate.open() }
        var oldFailed: Error?
        let old = Task {
            do {
                try await trust.use(material: material(1), active: { oldActive }) { _ in
                    await gate.wait()
                    order.append("old verified")
                }
            } catch { oldFailed = error }
        }
        try await checkpoint("the old session verifies", { oldFailed }) { gate.waiting }
        // Signed out and in again while the old session was verifying.
        oldActive = false
        let next = Task { try await trust.use(material: material(2), active: { true }) { _ in order.append("next") } }
        try await checkpoint("the next session waits", { oldFailed }) { trust.waitingCount == 1 }
        XCTAssertEqual(order, [])
        gate.open()
        await old.value
        try await next.value
        XCTAssertNil(oldFailed)
        XCTAssertEqual(order, ["old verified", "next"])
        // The retired session can no longer start any trust work.
        do {
            try await trust.use(material: material(2), active: { oldActive }) { _ in order.append("old again") }
            XCTFail("a retired session must not use the store")
        } catch {}
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(FakeTrustStore.opened(state).sequence, 2)
    }

    private struct Missed: Error, CustomStringConvertible { let description: String }

    /// Parks a task until opened; opening twice, or before it waits, is fine.
    @MainActor
    private final class Gate {
        private var continuation: CheckedContinuation<Void, Never>?
        private var opened = false
        var waiting: Bool { continuation != nil }

        func wait() async {
            guard !opened else { return }
            await withCheckedContinuation { continuation = $0 }
        }

        func open() {
            opened = true
            continuation?.resume()
            continuation = nil
        }
    }

    /// Waits (bounded) until `condition` holds, and fails at once if the
    /// parked task already failed (it threw before reaching its checkpoint).
    private func checkpoint(
        _ what: String, _ failure: () -> Error?, _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            if let error = failure() { throw error }
            guard Date() < deadline else { throw Missed(description: "\(what): not reached in 5 s") }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}
