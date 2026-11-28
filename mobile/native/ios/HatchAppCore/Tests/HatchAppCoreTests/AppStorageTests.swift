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

    func testADeletionThatFailedLeavesNothingTheNextAccountOpens() throws {
        // Permissions are how the deletion is made to fail; root ignores them.
        try XCTSkipIf(getuid() == 0, "root ignores file permissions")
        let first = try save("account-a")
        let files = FileManager.default
        try files.setAttributes([.posixPermissions: 0o500], ofItemAtPath: first.path)
        try files.setAttributes([.posixPermissions: 0o500], ofItemAtPath: instance.path)
        defer {
            try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: instance.path)
            try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: first.path)
        }
        XCTAssertFalse(AppStorage.forget(instance))
        XCTAssertTrue(files.fileExists(atPath: first.appendingPathComponent("draft").path))
        // After a restart (AppStorage keeps nothing in memory) another account
        // signs in: its Apps open their own, empty storage.
        let next = AppStorage.accountDirectory(instance, accountKey: "account-b").appendingPathComponent("storage/app-1")
        XCTAssertFalse(files.fileExists(atPath: next.path))
        XCTAssertFalse(next.standardizedFileURL.path.hasPrefix(first.standardizedFileURL.path))
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
