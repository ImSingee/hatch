import Foundation
import XCTest

@testable import HatchAppCore

final class AppStorageTests: XCTestCase {
    private var instance: URL!
    private var storage: URL!

    override func setUpWithError() throws {
        instance = FileManager.default.temporaryDirectory.appendingPathComponent("instance-\(UUID().uuidString)")
        storage = instance.appendingPathComponent("storage/app-1")
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        try Data("an unsent form".utf8).write(to: storage.appendingPathComponent("draft"))
    }

    func testSigningOutDeletesWhatAppsSaved() throws {
        XCTAssertTrue(AppStorage.forget(instance))
        XCTAssertFalse(FileManager.default.fileExists(atPath: instance.appendingPathComponent("storage").path))
        XCTAssertTrue(AppStorage.ready(instance))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: instance.path), [])
    }

    func testADeletionThatFailedKeepsTheStorageFromUseUntilItSucceeds() throws {
        // Permissions are how the deletion is made to fail; root ignores them.
        try XCTSkipIf(getuid() == 0, "root ignores file permissions")
        // The instance directory refuses changes: neither the marker nor
        // moving or removing the storage can happen.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: instance.path)
        XCTAssertFalse(AppStorage.forget(instance))
        // The next session for this instance (signing in again) may not use it.
        XCTAssertFalse(AppStorage.ready(instance))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: instance.path)
        // Once the deletion can finish, the next session finishes it first.
        XCTAssertTrue(AppStorage.ready(instance))
        XCTAssertFalse(FileManager.default.fileExists(atPath: instance.appendingPathComponent("storage").path))
        XCTAssertTrue(AppStorage.ready(instance))
    }
}
