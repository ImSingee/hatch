import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// One HTTP request the runtime makes to the Hatch instance.
public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var timeout: TimeInterval

    public init(
        method: String, url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval = 30
    ) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

/// How the runtime reaches the instance. The app supplies a URLSession-based
/// one ([`URLSessionTransport`]); tests a fake.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
    /// Sends `request` and hands each line of the response body to `line`
    /// until it returns false or the body ends. Returns the status and headers;
    /// for a status other than 2xx the body is not read line by line but
    /// returned whole.
    func lines(_ request: HTTPRequest, _ line: @Sendable (String) -> Bool) async throws -> HTTPResponse
}

public enum TransportError: Error, Equatable {
    case notHTTP
    /// A streamed line longer than `URLSessionTransport.maxLine`.
    case lineTooLong
}

/// The instance over URLSession: no cookies, no cache, no redirects that keep
/// credentials (the session's delegate refuses redirects).
public final class URLSessionTransport: NSObject, HTTPTransport, URLSessionTaskDelegate, @unchecked Sendable {
    /// The longest line a streamed body may send (64 KiB).
    public static let maxLine = 64 * 1024
    /// Made once, before the transport is handed out, so concurrent first
    /// calls never race to create it.
    private var session: URLSession!

    public override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    private func urlRequest(_ request: HTTPRequest) -> URLRequest {
        var out = URLRequest(url: request.url, timeoutInterval: request.timeout)
        out.httpMethod = request.method
        out.httpBody = request.body
        for (name, value) in request.headers { out.setValue(value, forHTTPHeaderField: name) }
        return out
    }

    private static func headers(_ response: HTTPURLResponse) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let key = key as? String, let value = value as? String { out[key.lowercased()] = value }
        }
        return out
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let (data, response) = try await session.data(for: urlRequest(request))
        guard let http = response as? HTTPURLResponse else { throw TransportError.notHTTP }
        return HTTPResponse(status: http.statusCode, headers: Self.headers(http), body: data)
    }

    public func lines(_ request: HTTPRequest, _ line: @Sendable (String) -> Bool) async throws -> HTTPResponse {
        #if canImport(FoundationNetworking)
            // Linux has no byte streams: read the body whole (tests use fakes).
            let response = try await send(request)
            if (200..<300).contains(response.status) {
                for text in String(decoding: response.body, as: UTF8.self).split(
                    separator: "\n", omittingEmptySubsequences: false)
                {
                    if !line(String(text)) { break }
                }
                return HTTPResponse(status: response.status, headers: response.headers)
            }
            return response
        #else
            let (bytes, response) = try await session.bytes(for: urlRequest(request))
            guard let http = response as? HTTPURLResponse else { throw TransportError.notHTTP }
            let headers = Self.headers(http)
            guard (200..<300).contains(http.statusCode) else {
                var body = Data()
                for try await byte in bytes { body.append(byte) }
                return HTTPResponse(status: http.statusCode, headers: headers, body: body)
            }
            // `AsyncLineSequence` skips empty lines, which end SSE blocks, so
            // split the bytes here.
            var current = Data()
            for try await byte in bytes {
                if byte == UInt8(ascii: "\n") {
                    var text = String(decoding: current, as: UTF8.self)
                    if text.hasSuffix("\r") { text.removeLast() }
                    current.removeAll(keepingCapacity: true)
                    if !line(text) { break }
                } else {
                    guard current.count < Self.maxLine else { throw TransportError.lineTooLong }
                    current.append(byte)
                }
            }
            return HTTPResponse(status: http.statusCode, headers: headers)
        #endif
    }

    /// Credentials never follow a redirect.
    public func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
