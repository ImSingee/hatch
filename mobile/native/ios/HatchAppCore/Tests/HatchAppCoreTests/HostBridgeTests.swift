import Foundation
import XCTest

@testable import HatchAppCore

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Records every request and answers from a script.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    let lock = NSLock()
    var requests: [HTTPRequest] = []
    var answer: (HTTPRequest) -> HTTPResponse = { _ in HTTPResponse(status: 200, body: Data("{}".utf8)) }
    var lines: [String] = []

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { requests.append(request) }
        return answer(request)
    }

    func lines(_ request: HTTPRequest, _ line: @Sendable (String) -> Bool) async throws -> HTTPResponse {
        lock.withLock { requests.append(request) }
        let response = answer(request)
        guard (200..<300).contains(response.status) else { return response }
        for text in lines where !line(text) { break }
        return HTTPResponse(status: response.status)
    }
}

final class RecordingShell: BridgeShell, @unchecked Sendable {
    var titles: [String?] = []
    var routes: [String] = []
    var opened: [(String, String)] = []
    var unauthorizedCount = 0
    var staleCount = 0
    var theme: String?

    func themeJSON() async -> String? { theme }
    func setTitle(_ title: String?) async { titles.append(title) }
    func setRoute(_ route: String) async { routes.append(route) }
    func openApp(slug: String, route: String) async -> Bool {
        opened.append((slug, route))
        return true
    }
    func unauthorized() async { unauthorizedCount += 1 }
    func deploymentStale() async { staleCount += 1 }
}

/// A shell that only the bridge holds, passing its calls on.
final class ForwardingShell: BridgeShell, @unchecked Sendable {
    let target: RecordingShell
    init(to target: RecordingShell) { self.target = target }
    func themeJSON() async -> String? { await target.themeJSON() }
    func setTitle(_ title: String?) async { await target.setTitle(title) }
    func setRoute(_ route: String) async { await target.setRoute(route) }
    func openApp(slug: String, route: String) async -> Bool { await target.openApp(slug: slug, route: route) }
    func unauthorized() async { await target.unauthorized() }
    func deploymentStale() async { await target.deploymentStale() }
}

final class HostBridgeTests: XCTestCase {
    let origin = URL(string: "https://hatch.example.test")!
    var transport: FakeTransport!
    var shell: RecordingShell!
    var bridge: HostBridge!

    override func setUp() {
        transport = FakeTransport()
        shell = RecordingShell()
        let scope = AppScope(
            appId: "app1", deploymentId: "dep1", rpcMethods: ["app.v1.Counter": ["Get", "Add"]], hasData: true)!
        bridge = HostBridge(
            origin: origin, scope: scope, credential: { "session-token" }, transport: transport, shell: shell,
            eventsWait: 0.5)
    }

    func testTheBridgeKeepsTheShellItWasGiven() async {
        // The engine manager hands the bridge a shell no one else holds.
        let routes = RecordingShell()
        let bridge = HostBridge(
            origin: origin, scope: bridge.scope, credential: { nil }, transport: transport,
            shell: ForwardingShell(to: routes))
        _ = await bridge.call("hatch.nav.setRoute", ["route": "orders/7"])
        _ = await bridge.call("hatch.nav.setTitle", ["title": "Orders"])
        XCTAssertEqual(routes.routes, ["orders/7"])
        XCTAssertEqual(routes.titles, ["Orders"])
    }

    private func refused(_ answer: [String: Any], _ code: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(answer["ok"] as? Bool, false, file: file, line: line)
        XCTAssertEqual(answer["code"] as? String, code, "\(answer)", file: file, line: line)
    }

    func testGrantIsExactlyTheHostCalls() throws {
        let grant = try JSONSerialization.jsonObject(with: Data(HostCalls.grant.utf8)) as? [String: Any]
        XCTAssertEqual(Array(grant!.keys), ["host"])
        XCTAssertEqual(grant!["host"] as? [String], HostCalls.names)
    }

    func testUnknownHostNamesAreRefusedWithoutARequest() async {
        for name in ["evil.steal", "hatch.secret.read", "hatch.rpc.", "fetch", ""] {
            refused(await bridge.call(name, [:]), "unimplemented")
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testArgumentsMustBeAnObject() async {
        refused(await bridge.call("hatch.rpc", ["a"]), "invalid_argument")
        refused(await bridge.call("hatch.nav.setRoute", "x"), "invalid_argument")
        refused(await bridge.call("hatch.data.query", 3), "invalid_argument")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testRpcStaysOnTheAppsOwnBackend() async throws {
        transport.answer = { _ in HTTPResponse(status: 200, body: Data(#"{"count":2}"#.utf8)) }
        let answer = await bridge.call(
            "hatch.rpc", ["service": "app.v1.Counter", "method": "Add", "message": ["amount": 1], "appId": "other"])
        XCTAssertEqual(answer["ok"] as? Bool, true)
        XCTAssertEqual((answer["message"] as? [String: Any])?["count"] as? Int, 2)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://hatch.example.test/api/app/app1/rpc/app.v1.Counter/Add")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["authorization"], "Bearer session-token")
        XCTAssertEqual(request.headers["connect-protocol-version"], "1")
        XCTAssertEqual(String(decoding: request.body!, as: UTF8.self), #"{"amount":1}"#)
    }

    func testRpcRejectsNamesThatCouldLeaveTheApp() async {
        let bad: [[String: Any]] = [
            ["service": "../../other/rpc/app.v1.Counter", "method": "Add", "message": [:]],
            ["service": "app.v1.Counter", "method": "Add/../../x", "message": [:]],
            ["service": "app.v1.Counter/", "method": "Add", "message": [:]],
            ["service": "app.v1.Counter", "method": "Add?x=1", "message": [:]],
            ["service": "app.v1.Counter", "method": "Add"],
            ["service": 3, "method": "Add", "message": [:]],
        ]
        for args in bad { refused(await bridge.call("hatch.rpc", args), "invalid_argument") }
        refused(
            await bridge.call("hatch.rpc", ["service": "app.v1.Counter", "method": "Drop", "message": [:]]),
            "unimplemented")
        refused(
            await bridge.call("hatch.rpc", ["service": "app.v1.Other", "method": "Add", "message": [:]]),
            "unimplemented")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testRpcErrorsKeepTheConnectCode() async {
        transport.answer = { _ in
            HTTPResponse(status: 400, body: Data(#"{"code":"invalid_argument","message":"amount must be positive"}"#.utf8))
        }
        let answer = await bridge.call("hatch.rpc", ["service": "app.v1.Counter", "method": "Add", "message": [:]])
        refused(answer, "invalid_argument")
        XCTAssertEqual(answer["message"] as? String, "amount must be positive")
        transport.answer = { _ in HTTPResponse(status: 401) }
        refused(
            await bridge.call("hatch.rpc", ["service": "app.v1.Counter", "method": "Add", "message": [:]]),
            "unauthenticated")
        XCTAssertEqual(shell.unauthorizedCount, 1)
    }

    func testDataCallsCarryTheLiveDeployment() async throws {
        transport.answer = { _ in HTTPResponse(status: 200, body: Data(#"{"items":[]}"#.utf8)) }
        let answer = await bridge.call("hatch.data.query", ["body": ["table": "counters"]])
        XCTAssertEqual(answer["ok"] as? Bool, true)
        let request = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(request.url.absoluteString, "https://hatch.example.test/api/app/app1/data/query")
        XCTAssertEqual(request.headers["x-hatch-data-deployment"], "dep1")
        bridge.scope.deploymentId = "dep2"
        _ = await bridge.call("hatch.data.mutate", ["body": ["op": "insert"]])
        XCTAssertEqual(transport.requests.last?.url.path, "/api/app/app1/data/mutate")
        XCTAssertEqual(transport.requests.last?.headers["x-hatch-data-deployment"], "dep2")
        refused(await bridge.call("hatch.data.query", ["body": "x"]), "invalid_argument")
    }

    func testStaleDeploymentIsReported() async {
        transport.answer = { _ in HTTPResponse(status: 409, body: Data("inactive deployment".utf8)) }
        refused(await bridge.call("hatch.data.query", ["body": [:]]), "already_exists")
        XCTAssertEqual(shell.staleCount, 1)
        // An App that only watches for changes learns of it too.
        refused(await bridge.call("hatch.data.events", ["table": "counters", "since": 0]), "already_exists")
        XCTAssertEqual(shell.staleCount, 2)
    }

    func testEventsReadTheFirstChangeBlock() async throws {
        transport.lines = [": connected", "", "id: 7", "event: change", "data: {}", "", "id: 9", "event: change", ""]
        let answer = await bridge.call("hatch.data.events", ["table": "counters", "since": 3])
        XCTAssertEqual(answer["ok"] as? Bool, true)
        let events = try XCTUnwrap(answer["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0]["revision"] as? Int64, 7)
        XCTAssertEqual(events[0]["reset"] as? Bool, false)
        let request = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(
            request.url.absoluteString, "https://hatch.example.test/api/app/app1/data/events?since=3&table=counters")
        XCTAssertEqual(request.headers["x-hatch-data-deployment"], "dep1")
    }

    func testEventsArgumentsAreChecked() async {
        for args: [String: Any] in [
            ["table": "", "since": 0], ["table": "t", "since": -1], ["table": "t", "since": 1.5],
            ["table": "t", "since": "1"], ["table": "t"], ["since": 1], ["table": "t", "since": true],
        ] {
            refused(await bridge.call("hatch.data.events", args), "invalid_argument")
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAppsWithoutABackendOrDataAreRefused() async {
        bridge.scope = AppScope(appId: "app1", deploymentId: "d", rpcMethods: [:], hasData: false)!
        refused(
            await bridge.call("hatch.rpc", ["service": "app.v1.Counter", "method": "Add", "message": [:]]),
            "unimplemented")
        refused(await bridge.call("hatch.data.query", ["body": [:]]), "unimplemented")
        refused(await bridge.call("hatch.data.events", ["table": "t", "since": 0]), "unimplemented")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testNavigationArgumentsAreChecked() async {
        do { let answer = await bridge.call("hatch.nav.setTitle", ["title": "Orders"]); XCTAssertEqual(answer["ok"] as? Bool, true) }
        do { let answer = await bridge.call("hatch.nav.setTitle", ["title": NSNull()]); XCTAssertEqual(answer["ok"] as? Bool, true) }
        refused(
            await bridge.call("hatch.nav.setTitle", ["title": String(repeating: "x", count: 257)]), "invalid_argument")
        refused(await bridge.call("hatch.nav.setTitle", ["title": 3]), "invalid_argument")
        XCTAssertEqual(shell.titles, ["Orders", nil])

        do { let answer = await bridge.call("hatch.nav.setRoute", ["route": "orders/7"]); XCTAssertEqual(answer["ok"] as? Bool, true) }
        refused(await bridge.call("hatch.nav.setRoute", ["route": "#orders"]), "invalid_argument")
        refused(
            await bridge.call("hatch.nav.setRoute", ["route": String(repeating: "x", count: 4097)]), "invalid_argument")
        XCTAssertEqual(shell.routes, ["orders/7"])

        do { let answer = await bridge.call("hatch.nav.open", ["slug": "notes", "route": "a"]); XCTAssertEqual(answer["ok"] as? Bool, true) }
        for slug: Any in ["Notes", "-x", "../x", "a/b", String(repeating: "a", count: 65), 3] {
            refused(await bridge.call("hatch.nav.open", ["slug": slug]), "invalid_argument")
        }
        XCTAssertEqual(shell.opened.map(\.0), ["notes"])
    }

    func testThemeAndSupports() async {
        let none = await bridge.call("hatch.theme.get", nil)
        XCTAssertTrue(none["theme"] is NSNull)
        shell.theme = ##"{"cssVars":{"light":{"primary":"#123456"}}}"##
        let theme = await bridge.call("hatch.theme.get", [:])
        XCTAssertNotNil((theme["theme"] as? [String: Any])?["cssVars"])
        do { let answer = await bridge.call("hatch.native.supports", [:]); XCTAssertEqual(answer["capabilities"] as? [String], []) }
    }

    func testScopeRefusesIdsThatAreNotSegments() {
        for id in ["", "a/b", "..", "a?b", "a#b", "a b", String(repeating: "a", count: 192)] {
            XCTAssertNil(AppScope(appId: id, deploymentId: "d", rpcMethods: [:], hasData: false), id)
        }
        XCTAssertNotNil(AppScope(appId: "01m8ffbv5zpxnpavahvq9aq51x", deploymentId: "d", rpcMethods: [:], hasData: true))
    }

    func testNoCredentialMeansNoRequest() async {
        let anonymous = HostBridge(
            origin: origin, scope: bridge.scope, credential: { nil }, transport: transport, shell: shell)
        refused(
            await anonymous.call("hatch.rpc", ["service": "app.v1.Counter", "method": "Add", "message": [:]]),
            "unauthenticated")
        XCTAssertTrue(transport.requests.isEmpty)
    }
}
