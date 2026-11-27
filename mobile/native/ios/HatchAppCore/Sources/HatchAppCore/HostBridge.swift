import Foundation

/// What one running App may reach: its own id, its live deployment, the
/// unary methods its backend serves and whether it has Data Tables. Every
/// request the bridge makes is built from this scope alone, never from the
/// App's arguments, so an App reaches only `/api/app/<its id>/...`.
public struct AppScope: Sendable, Equatable {
    public let appId: String
    public var deploymentId: String
    /// Unary methods by fully-qualified service name.
    public var rpcMethods: [String: Set<String>]
    public var hasData: Bool

    /// Nil for an id that is not a plain App id (it becomes a URL segment).
    public init?(appId: String, deploymentId: String, rpcMethods: [String: Set<String>], hasData: Bool) {
        guard AppScope.isAppId(appId) else { return nil }
        self.appId = appId
        self.deploymentId = deploymentId
        self.rpcMethods = rpcMethods
        self.hasData = hasData
    }

    public static func isAppId(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 191
            && value.unicodeScalars.allSatisfy {
                CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_"
            }
    }
}

/// The shell side of the bridge: what the App's calls change outside it.
public protocol BridgeShell: AnyObject, Sendable {
    /// The NSH theme (JSON text) `hatch.theme.get` answers with; nil keeps
    /// the App's built-in theme.
    func themeJSON() async -> String?
    func setTitle(_ title: String?) async
    func setRoute(_ route: String) async
    /// Opens another App by slug; false when the shell cannot.
    func openApp(slug: String, route: String) async -> Bool
    /// The instance refused the credential (401).
    func unauthorized() async
    /// The Data API says this deployment is no longer live (409).
    func deploymentStale() async
}

/// Answers an App's `hatch.*` host calls as the web player does: every
/// argument is checked, every request stays inside the App's scope, and
/// every answer is an envelope (`{ ok: true, ... }` or `{ ok: false, code,
/// message }`), never a rejection, which would lose its code.
public final class HostBridge: @unchecked Sendable {
    public static let maxTitleLength = 256
    public static let maxRouteLength = 4096
    /// How long one `hatch.data.events` call waits before answering "none".
    public static let eventsWait: TimeInterval = 25

    public let origin: URL
    private let credential: @Sendable () -> String?
    private let transport: HTTPTransport
    private weak var shell: BridgeShell?
    private let lock = NSLock()
    private var _scope: AppScope
    private let eventsWait: TimeInterval

    public var scope: AppScope {
        get { lock.withLock { _scope } }
        set { lock.withLock { _scope = newValue } }
    }

    public init(
        origin: URL, scope: AppScope, credential: @escaping @Sendable () -> String?, transport: HTTPTransport,
        shell: BridgeShell?, eventsWait: TimeInterval = HostBridge.eventsWait
    ) {
        self.origin = origin
        self._scope = scope
        self.credential = credential
        self.transport = transport
        self.shell = shell
        self.eventsWait = eventsWait
    }

    // MARK: - Envelopes

    public static func refuse(_ code: String, _ message: String) -> [String: Any] {
        ["ok": false, "code": code, "message": message]
    }

    /// The Connect code for an HTTP status the instance answered with.
    public static func code(forStatus status: Int) -> String {
        switch status {
        case 400: return "invalid_argument"
        case 401: return "unauthenticated"
        case 403: return "permission_denied"
        case 404: return "not_found"
        case 409: return "already_exists"
        case 429: return "resource_exhausted"
        case 503: return "unavailable"
        case 504: return "deadline_exceeded"
        default: return status >= 500 ? "internal" : "unknown"
        }
    }

    static func isServiceName(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return !parts.isEmpty && parts.allSatisfy(isIdentifier)
    }

    static func isIdentifier<S: StringProtocol>(_ value: S) -> Bool {
        guard let first = value.unicodeScalars.first,
            first == "_" || (first.isASCII && CharacterSet.letters.contains(first))
        else { return false }
        return value.unicodeScalars.allSatisfy {
            $0 == "_" || ($0.isASCII && CharacterSet.alphanumerics.contains($0))
        }
    }

    static func isSlug(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard (1...64).contains(scalars.count) else { return false }
        func ok(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("0"..."9").contains(c) }
        return ok(scalars[0]) && scalars.dropFirst().allSatisfy { ok($0) || $0 == "-" }
    }

    // MARK: - Calls

    /// Answers the host call `name` with `args` (NSH's decoded JSON).
    public func call(_ name: String, _ args: Any?) async -> [String: Any] {
        let input: [String: Any]
        if args == nil || args is NSNull {
            input = [:]
        } else if let object = args as? [String: Any] {
            input = object
        } else {
            return Self.refuse("invalid_argument", "\(name) takes an object.")
        }
        switch name {
        case "hatch.rpc": return await rpc(input)
        case "hatch.data.query": return await data("query", input)
        case "hatch.data.mutate": return await data("mutate", input)
        case "hatch.data.events": return await events(input)
        case "hatch.theme.get":
            guard let text = await shell?.themeJSON(),
                let theme = try? JSONSerialization.jsonObject(with: Data(text.utf8))
            else { return ["ok": true, "theme": NSNull()] }
            return ["ok": true, "theme": theme]
        case "hatch.nav.setTitle":
            let title = input["title"]
            if let title = title as? String, title.count <= Self.maxTitleLength {
                await shell?.setTitle(title.isEmpty ? nil : title)
                return ["ok": true]
            }
            if title == nil || title is NSNull {
                await shell?.setTitle(nil)
                return ["ok": true]
            }
            return Self.refuse(
                "invalid_argument",
                "hatch.nav.setTitle needs { title } (a string of at most \(Self.maxTitleLength) characters, or null).")
        case "hatch.nav.setRoute":
            guard let route = input["route"] as? String, route.count <= Self.maxRouteLength, !route.hasPrefix("#")
            else {
                return Self.refuse("invalid_argument", "hatch.nav.setRoute needs { route }: a fragment without \"#\".")
            }
            await shell?.setRoute(route)
            return ["ok": true]
        case "hatch.nav.open":
            let route = input["route"] ?? ""
            guard let slug = input["slug"] as? String, Self.isSlug(slug), let route = route as? String,
                route.count <= Self.maxRouteLength
            else { return Self.refuse("invalid_argument", "hatch.nav.open needs { slug, route? }.") }
            return await shell?.openApp(slug: slug, route: route) == true
                ? ["ok": true] : Self.refuse("unavailable", "No shell is showing this App.")
        case "hatch.native.supports":
            return ["ok": true, "capabilities": [String]()]
        default:
            return Self.refuse("unimplemented", "\(name) is not a host function.")
        }
    }

    // MARK: - Requests

    /// `/api/app/<scope's App id>/<rest>` on the instance.
    func appURL(_ rest: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = "/api/app/\(scope.appId)/\(rest)"
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    private func authorized(_ headers: [String: String]) -> [String: String]? {
        guard let token = credential() else { return nil }
        var out = headers
        out["authorization"] = "Bearer \(token)"
        return out
    }

    private func perform(_ request: HTTPRequest) async -> Result<HTTPResponse, Error> {
        do {
            let response = try await transport.send(request)
            if response.status == 401 { await shell?.unauthorized() }
            return .success(response)
        } catch {
            return .failure(error)
        }
    }

    private func rpc(_ input: [String: Any]) async -> [String: Any] {
        let scope = self.scope
        guard !scope.rpcMethods.isEmpty else { return Self.refuse("unimplemented", "This App has no backend.") }
        guard let service = input["service"] as? String, Self.isServiceName(service),
            let method = input["method"] as? String, Self.isIdentifier(method),
            let message = input["message"]
        else { return Self.refuse("invalid_argument", "hatch.rpc needs { service, method, message }.") }
        guard scope.rpcMethods[service]?.contains(method) == true else {
            return Self.refuse("unimplemented", "\(service)/\(method) is not a unary method of this App.")
        }
        guard let body = try? JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed]) else {
            return Self.refuse("invalid_argument", "hatch.rpc needs { service, method, message }.")
        }
        guard
            let headers = authorized([
                "content-type": "application/json", "connect-protocol-version": "1", "accept": "application/json",
            ])
        else { return Self.refuse("unauthenticated", "Sign in to this instance again.") }
        let request = HTTPRequest(
            method: "POST", url: appURL("rpc/\(service)/\(method)"), headers: headers, body: body)
        switch await perform(request) {
        case .failure(let error):
            return Self.refuse("unavailable", "\(error)")
        case .success(let response):
            let parsed: Any? =
                response.body.isEmpty
                ? [String: Any]()
                : try? JSONSerialization.jsonObject(with: response.body, options: [.fragmentsAllowed])
            guard (200..<300).contains(response.status) else {
                let failure = parsed as? [String: Any] ?? [:]
                return Self.refuse(
                    failure["code"] as? String ?? Self.code(forStatus: response.status),
                    failure["message"] as? String ?? "HTTP \(response.status)")
            }
            guard let parsed else { return Self.refuse("internal", "The backend answered with no JSON message.") }
            return ["ok": true, "message": parsed, "header": response.headers]
        }
    }

    private func data(_ action: String, _ input: [String: Any]) async -> [String: Any] {
        let scope = self.scope
        guard scope.hasData else { return Self.refuse("unimplemented", "This App has no Data Tables.") }
        guard let body = input["body"] as? [String: Any],
            let encoded = try? JSONSerialization.data(withJSONObject: body)
        else { return Self.refuse("invalid_argument", "hatch.data.\(action) needs { body }.") }
        guard
            let headers = authorized([
                "content-type": "application/json", "x-hatch-data-deployment": scope.deploymentId,
            ])
        else { return Self.refuse("unauthenticated", "Sign in to this instance again.") }
        let request = HTTPRequest(method: "POST", url: appURL("data/\(action)"), headers: headers, body: encoded)
        switch await perform(request) {
        case .failure(let error):
            return Self.refuse("unavailable", "\(error)")
        case .success(let response):
            guard (200..<300).contains(response.status) else {
                if response.status == 409 { await shell?.deploymentStale() }
                let text = String(decoding: response.body, as: UTF8.self)
                return Self.refuse(
                    Self.code(forStatus: response.status), text.isEmpty ? "HTTP \(response.status)" : text)
            }
            guard let result = try? JSONSerialization.jsonObject(with: response.body, options: [.fragmentsAllowed])
            else { return Self.refuse("internal", "The Data API answered with no JSON.") }
            return ["ok": true, "result": result]
        }
    }

    private final class Found: @unchecked Sendable {
        let lock = NSLock()
        var events: [[String: Any]] = []
        var block: [String] = []
    }

    private func events(_ input: [String: Any]) async -> [String: Any] {
        let scope = self.scope
        guard scope.hasData else { return Self.refuse("unimplemented", "This App has no Data Tables.") }
        guard let table = input["table"] as? String, !table.isEmpty,
            let sinceNumber = input["since"] as? NSNumber, !JSON.isBool(sinceNumber),
            let since = Int64(exactly: sinceNumber.doubleValue), since >= 0, since <= 9_007_199_254_740_991
        else { return Self.refuse("invalid_argument", "hatch.data.events needs { table, since }.") }
        guard let headers = authorized(["x-hatch-data-deployment": scope.deploymentId, "accept": "text/event-stream"])
        else { return Self.refuse("unauthenticated", "Sign in to this instance again.") }
        let request = HTTPRequest(
            method: "GET",
            url: appURL(
                "data/events",
                query: [URLQueryItem(name: "since", value: String(since)), URLQueryItem(name: "table", value: table)]),
            headers: headers, timeout: eventsWait + 5)
        let found = Found()
        let transport = self.transport
        let wait = eventsWait
        do {
            let response: HTTPResponse? = try await withThrowingTaskGroup(of: HTTPResponse?.self) { group in
                group.addTask {
                    try await transport.lines(request) { line in
                        found.lock.withLock {
                            if !line.isEmpty {
                                found.block.append(line)
                                return true
                            }
                            let block = found.block
                            found.block = []
                            guard
                                let type = block.first(where: { $0.hasPrefix("event:") })?.dropFirst(6)
                                    .trimmingCharacters(in: .whitespaces)
                            else { return true }
                            var event: [String: Any] = ["reset": type == "reset"]
                            if let id = block.first(where: { $0.hasPrefix("id:") })?.dropFirst(3)
                                .trimmingCharacters(in: .whitespaces), let revision = Int64(id), revision >= 0
                            {
                                event["revision"] = revision
                            }
                            found.events.append(event)
                            return false
                        }
                    }
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    return nil
                }
                let first = try await group.next() ?? nil
                group.cancelAll()
                return first
            }
            if let response, !(200..<300).contains(response.status) {
                if response.status == 401 { await shell?.unauthorized() }
                let text = String(decoding: response.body, as: UTF8.self)
                return Self.refuse(
                    Self.code(forStatus: response.status), text.isEmpty ? "HTTP \(response.status)" : text)
            }
        } catch is CancellationError {
            // Waited long enough: answer with what arrived (usually nothing).
        } catch {
            if found.lock.withLock({ found.events.isEmpty }) { return Self.refuse("unavailable", "\(error)") }
        }
        return ["ok": true, "events": found.lock.withLock { found.events }]
    }
}
