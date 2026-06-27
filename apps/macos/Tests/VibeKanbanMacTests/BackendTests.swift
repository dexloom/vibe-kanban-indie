import XCTest
@testable import VibeKanbanMac

/// Covers backend mode/state helpers, executable resolution, and port/override
/// discovery. UserDefaults keys are snapshotted and restored to keep tests
/// isolated.
final class BackendTests: XCTestCase {
    private let keys = [
        BackendManager.modeKey, BackendManager.exePathKey,
        BackendManager.repoPathKey, BackendManager.buildFromSourceKey,
        BackendDiscovery.overrideKey,
    ]
    private var saved: [String: Any?] = [:]

    override func setUp() {
        super.setUp()
        for k in keys { saved[k] = UserDefaults.standard.object(forKey: k) }
        for k in keys { UserDefaults.standard.removeObject(forKey: k) }
    }

    override func tearDown() {
        for k in keys {
            if let value = saved[k], let value { UserDefaults.standard.set(value, forKey: k) }
            else { UserDefaults.standard.removeObject(forKey: k) }
        }
        super.tearDown()
    }

    // MARK: - Mode

    func testBackendModeLabels() {
        XCTAssertEqual(BackendMode.managed.rawValue, "managed")
        XCTAssertEqual(BackendMode.external.rawValue, "external")
        XCTAssertTrue(BackendMode.managed.label.contains("Managed"))
        XCTAssertEqual(BackendMode.allCases.count, 2)
    }

    @MainActor
    func testManagerModeDefaultsToManaged() {
        let manager = BackendManager()
        XCTAssertEqual(manager.mode, .managed)
        UserDefaults.standard.set("external", forKey: BackendManager.modeKey)
        XCTAssertEqual(manager.mode, .external)
    }

    func testStateLabels() {
        XCTAssertEqual(BackendManager.State.stopped.label, "Stopped")
        XCTAssertTrue(BackendManager.State.failed("boom").label.contains("boom"))
        if case .running = BackendManager.State.running(URL(string: "http://127.0.0.1:9")!) {} else {
            XCTFail("running case")
        }
    }

    // MARK: - Executable resolution

    @MainActor
    func testResolveExecutableUsesExplicitPath() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vk-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let exe = dir.appendingPathComponent("server")
        try "#!/bin/sh\n".write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        defer { try? FileManager.default.removeItem(at: dir) }

        UserDefaults.standard.set(exe.path, forKey: BackendManager.exePathKey)
        let manager = BackendManager()
        XCTAssertEqual(manager.resolveExecutable()?.path, exe.path)
    }

    @MainActor
    func testResolveExecutableNilWhenNothingConfigured() {
        // No bundled binary in the test host, no path, no repo.
        let manager = BackendManager()
        XCTAssertNil(manager.resolveExecutable())
    }

    // MARK: - Discovery

    func testManualOverrideParsing() {
        UserDefaults.standard.set("8080", forKey: BackendDiscovery.overrideKey)
        XCTAssertEqual(BackendDiscovery.manualOverride()?.absoluteString, "http://127.0.0.1:8080")

        UserDefaults.standard.set("http://example.com:9000/x", forKey: BackendDiscovery.overrideKey)
        XCTAssertEqual(BackendDiscovery.manualOverride()?.absoluteString, "http://example.com:9000/x")

        UserDefaults.standard.set("   ", forKey: BackendDiscovery.overrideKey)
        XCTAssertNil(BackendDiscovery.manualOverride())

        UserDefaults.standard.removeObject(forKey: BackendDiscovery.overrideKey)
        XCTAssertNil(BackendDiscovery.manualOverride())
    }

    func testPortFileRoundTrip() throws {
        BackendDiscovery.removeStalePortFile()
        let target = try XCTUnwrap(BackendDiscovery.portFileCandidates().first)
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try #"{"main_port":54321}"#.write(to: target, atomically: true, encoding: .utf8)
        defer { BackendDiscovery.removeStalePortFile() }

        XCTAssertEqual(BackendDiscovery.readPortFromTemp(), 54321)
        XCTAssertEqual(BackendDiscovery.resolveBaseURL()?.absoluteString, "http://127.0.0.1:54321")

        BackendDiscovery.removeStalePortFile()
        XCTAssertNil(BackendDiscovery.readPortFromTemp())
    }
}
