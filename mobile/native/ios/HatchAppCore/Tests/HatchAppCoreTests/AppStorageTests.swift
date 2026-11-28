import Foundation
import XCTest

@testable import HatchAppCore

final class AppStorageTests: XCTestCase {
    private var instance: URL!

    override func setUpWithError() throws {
        instance = FileManager.default.temporaryDirectory.appendingPathComponent("instance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: instance, withIntermediateDirectories: true)
    }

    @discardableResult
    private func save(_ account: String) throws -> URL {
        let storage = AppStorage.accountDirectory(instance, accountKey: account).appendingPathComponent("storage/app-1")
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        try Data("an unsent form".utf8).write(to: storage.appendingPathComponent("draft"))
        return storage
    }

    func testAnAccountNeverOpensWhatAnotherSaved() throws {
        let first = try save("account-a")
        // Whatever happens to the first account's data, the next account's
        // Apps look elsewhere.
        let next = AppStorage.accountDirectory(instance, accountKey: "account-b").appendingPathComponent("storage/app-1")
        XCTAssertNotEqual(first.standardizedFileURL.path, next.standardizedFileURL.path)
    }

    func testSigningOutDeletesWhatAppsSaved() throws {
        try save("account-a")
        try save("account-b")
        XCTAssertTrue(AppStorage.forget(instance))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: instance.path), [])
        // Nothing saved: nothing to delete.
        XCTAssertTrue(AppStorage.forget(instance))
    }
}
