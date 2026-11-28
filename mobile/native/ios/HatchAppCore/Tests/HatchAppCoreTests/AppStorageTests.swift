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

    func testSigningOutDeletesWhatAppsSaved() {
        XCTAssertTrue(AppStorage.forget(instance))
        XCTAssertFalse(FileManager.default.fileExists(atPath: instance.appendingPathComponent("storage").path))
        XCTAssertTrue(AppStorage.ready(instance))
    }

    func testADeletionThatFailedKeepsTheStorageFromUseUntilItSucceeds() throws {
        // Permissions are how the deletion is made to fail; root ignores them.
        try XCTSkipIf(getuid() == 0, "root ignores file permissions")
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: storage.path)
        XCTAssertFalse(AppStorage.forget(instance))
        // The next session for this instance may not use it yet.
        XCTAssertFalse(AppStorage.ready(instance))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: storage.path)
        // Once the deletion can finish, the next session finishes it first.
        XCTAssertTrue(AppStorage.ready(instance))
        XCTAssertFalse(FileManager.default.fileExists(atPath: instance.appendingPathComponent("storage").path))
        XCTAssertTrue(AppStorage.ready(instance))
    }
}
