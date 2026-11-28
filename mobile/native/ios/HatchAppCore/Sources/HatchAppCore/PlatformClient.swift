import Foundation

/// A failed platform request: a Connect error code (`not_found`) and the
/// platform's stable code when it sent one (`APP_NOT_NATIVE`).
public struct PlatformError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let publicCode: String?
    public let message: String

    public init(code: String, publicCode: String? = nil, message: String) {
        self.code = code
        self.publicCode = publicCode
        self.message = message
    }

    public var description: String { message }
}

/// The live deployment of an App, as `GetApp` describes it.
public struct AppDescription: Sendable, Equatable {
    public let appId: String
    public let slug: String
    public let name: String
    /// `native` or `web`; nil without a live frontend.
    public let runtime: String?
    /// The signed package's build number (activation counter).
    public let packageBuild: Int?
    public let deploymentId: String?
    public let rpcMethods: [String: Set<String>]
    public let hasData: Bool
    /// Archived Apps keep their deployment but no longer open.
    public var archived = false
}

/// `AppPackage`, the first message of `GetAppPackage`.
public struct AppPackageInfo: Sendable, Equatable {
    public let appId: String
    public let deploymentId: String
    public let version: Int
    public let build: Int
    public let nshAppId: String
    public let sha256: String
    public let size: Int
    public let keyId: String
}

/// What packages are verified with: the instance's root keys and its signed
/// revocation list.
public struct RuntimeTrust: Sendable, Equatable {
    public let initialized: Bool
    public let roots: [String]
    /// The signed revocation list, and its sequence: a trust store accepts
    /// only a list newer than the one it has.
    public let revocations: String?
    public let revocationSequence: Int
}

/// Incremental SHA-256 (CryptoKit on iOS, MessageDigest on Android).
public protocol PackageHasher {
    mutating func update(_ data: Data)
    func hexDigest() -> String
}

/// The platform's public Connect API (`/api/rpc`) with the session's bearer:
/// unary calls in the JSON codec and `GetAppPackage`'s stream.
public final class PlatformClient: @unchecked Sendable {
    public let origin: URL
    private let credential: @Sendable () -> String?
    private let transport: HTTPTransport

    public init(origin: URL, credential: @escaping @Sendable () -> String?, transport: HTTPTransport) {
        self.origin = origin
        self.credential = credential
        self.transport = transport
    }

    private func url(_ service: String, _ method: String) -> URL {
        origin.appendingPathComponent("api/rpc/\(service)/\(method)")
    }

    private func headers(_ contentType: String) throws -> [String: String] {
        guard let token = credential() else {
            throw PlatformError(code: "unauthenticated", message: "Sign in to this instance again.")
        }
        return [
            "content-type": contentType, "connect-protocol-version": "1", "authorization": "Bearer \(token)",
        ]
    }

    static func error(from object: Any?, status: Int) -> PlatformError {
        let error = (object as? [String: Any]).flatMap { $0["error"] as? [String: Any] ?? $0 } ?? [:]
        let details = error["details"] as? [[String: Any]] ?? []
        let publicCode = details.compactMap { ($0["debug"] as? [String: Any])?["code"] as? String }.first
        return PlatformError(
            code: error["code"] as? String ?? HostBridge.code(forStatus: status), publicCode: publicCode,
            message: error["message"] as? String ?? "HTTP \(status)")
    }

    /// A unary call; throws [`PlatformError`].
    public func unary(_ service: String, _ method: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
        let request = HTTPRequest(
            method: "POST", url: url(service, method), headers: try headers("application/json"),
            body: try JSONSerialization.data(withJSONObject: body))
        let response = try await transport.send(request)
        let object = try? JSONSerialization.jsonObject(with: response.body)
        guard (200..<300).contains(response.status), let result = object as? [String: Any] else {
            throw Self.error(from: object, status: response.status)
        }
        return result
    }

    public func describeApp(_ id: String) async throws -> AppDescription {
        let resource = try await unary("hatch.platform.v1.AppService", "GetApp", ["id": id])["resource"]
        guard let resource = resource as? [String: Any], let view = resource["view"] as? [String: Any],
            let appId = view["id"] as? String
        else { throw PlatformError(code: "internal", message: "The instance described the App wrongly.") }
        let frontend = view["frontend"] as? [String: Any]
        let manifest = view["manifest"] as? [String: Any]
        var methods: [String: Set<String>] = [:]
        for service in (manifest?["api"] as? [String: Any])?["services"] as? [[String: Any]] ?? [] {
            guard let name = service["name"] as? String else { continue }
            methods[name] = Set(
                (service["methods"] as? [[String: Any]] ?? []).compactMap { method in
                    method["clientStreaming"] as? Bool == true || method["serverStreaming"] as? Bool == true
                        ? nil : method["name"] as? String
                })
        }
        return AppDescription(
            appId: appId, slug: view["slug"] as? String ?? "", name: view["name"] as? String ?? "",
            runtime: frontend?["runtime"] as? String,
            packageBuild: (frontend?["packageBuild"] as? NSNumber)?.intValue,
            deploymentId: view["currentDeploymentId"] as? String, rpcMethods: methods,
            hasData: (view["capabilities"] as? [String] ?? []).contains("dataTable"),
            archived: view["status"] as? String == "archived")
    }

    public func runtimeTrust() async throws -> RuntimeTrust {
        let trust = try await unary("hatch.platform.v1.AppService", "GetAppRuntimeTrust")["trust"] as? [String: Any]
        let roots = (trust?["roots"] as? [[String: Any]] ?? []).compactMap { $0["publicKey"] as? String }
        let list = trust?["revocations"] as? [String: Any]
        return RuntimeTrust(
            initialized: trust?["initialized"] as? Bool ?? false, roots: roots, revocations: list?["signed"] as? String,
            revocationSequence: (list?["sequence"] as? NSNumber)?.intValue ?? 0)
    }

    /// Minutes a hidden App keeps running (`GetDeskPreferences`).
    public func backgroundAppMinutes() async throws -> Int? {
        let preferences =
            try await unary("hatch.platform.v1.PreferenceService", "GetDeskPreferences")["preferences"]
            as? [String: Any]
        return (preferences?["backgroundAppMinutes"] as? NSNumber)?.intValue
    }

    // MARK: - Streams

    public struct Frame: Equatable {
        public let flags: UInt8
        public let payload: Data
        public var isEnd: Bool { flags & 0x02 != 0 }
    }

    /// Splits a Connect streaming body into its enveloped messages: a flags
    /// byte, a big-endian 32-bit length, then the payload.
    public static func frames(_ body: Data) throws -> [Frame] {
        var out: [Frame] = []
        let bytes = [UInt8](body)
        var index = 0
        while index < bytes.count {
            guard index + 5 <= bytes.count else {
                throw PlatformError(code: "internal", message: "The package stream ended inside a frame.")
            }
            let length =
                Int(bytes[index + 1]) << 24 | Int(bytes[index + 2]) << 16 | Int(bytes[index + 3]) << 8
                | Int(bytes[index + 4])
            let start = index + 5
            guard start + length <= bytes.count else {
                throw PlatformError(code: "internal", message: "The package stream ended inside a frame.")
            }
            out.append(Frame(flags: bytes[index], payload: Data(bytes[start..<start + length])))
            index = start + length
        }
        return out
    }

    static func envelope(_ payload: Data) -> Data {
        var out = Data([0])
        let length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: length) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    static func packageInfo(_ object: [String: Any]) -> AppPackageInfo? {
        func int(_ key: String) -> Int? { (object[key] as? NSNumber)?.intValue }
        guard let appId = object["appId"] as? String, let deploymentId = object["deploymentId"] as? String,
            let build = int("build"), let nshAppId = object["nshAppId"] as? String,
            let sha256 = object["sha256"] as? String, let size = int("size")
        else { return nil }
        return AppPackageInfo(
            appId: appId, deploymentId: deploymentId, version: int("version") ?? 0, build: build,
            nshAppId: nshAppId, sha256: sha256.lowercased(), size: size, keyId: object["keyId"] as? String ?? "")
    }

    /// Reads a whole `GetAppPackage` stream: the description, then the bytes,
    /// checked against its size and SHA-256 before anything is returned.
    public static func readPackage<H: PackageHasher>(_ body: Data, hasher: H) throws -> (AppPackageInfo, Data) {
        var hasher = hasher
        var info: AppPackageInfo?
        var bytes = Data()
        var ended = false
        for frame in try frames(body) {
            let object = try? JSONSerialization.jsonObject(with: frame.payload) as? [String: Any]
            if frame.isEnd {
                if let failure = object?["error"] { throw Self.error(from: ["error": failure], status: 200) }
                ended = true
                break
            }
            if let description = object?["package"] as? [String: Any] {
                guard info == nil, let parsed = packageInfo(description) else {
                    throw PlatformError(code: "internal", message: "The package stream described it wrongly.")
                }
                info = parsed
            } else if let chunk = object?["chunk"] as? String, let data = Data(base64Encoded: chunk) {
                guard info != nil else {
                    throw PlatformError(code: "internal", message: "The package stream sent bytes first.")
                }
                hasher.update(data)
                bytes.append(data)
            } else {
                throw PlatformError(code: "internal", message: "The package stream sent an unknown message.")
            }
        }
        guard ended, let info else {
            throw PlatformError(code: "internal", message: "The package stream ended early.")
        }
        guard bytes.count == info.size, hasher.hexDigest() == info.sha256 else {
            throw PlatformError(code: "data_loss", message: "The package does not match its size and SHA-256.")
        }
        return (info, bytes)
    }

    /// Downloads the App's live signed package and writes it, whole and
    /// verified, to `file` (atomically). Throws [`PlatformError`]
    /// (`APP_NOT_NATIVE`, `APP_PACKAGE_UNAVAILABLE`, ...).
    public func downloadPackage<H: PackageHasher>(appId: String, to file: URL, hasher: H) async throws
        -> AppPackageInfo
    {
        let body = try JSONSerialization.data(withJSONObject: ["id": appId])
        let request = HTTPRequest(
            method: "POST", url: url("hatch.platform.v1.AppService", "GetAppPackage"),
            headers: try headers("application/connect+json"), body: Self.envelope(body), timeout: 120)
        let response = try await transport.send(request)
        guard (200..<300).contains(response.status) else {
            throw Self.error(from: try? JSONSerialization.jsonObject(with: response.body), status: response.status)
        }
        let (info, bytes) = try Self.readPackage(response.body, hasher: hasher)
        guard info.appId == appId else {
            throw PlatformError(code: "internal", message: "The instance sent another App's package.")
        }
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: file, options: .atomic)
        return info
    }
}
