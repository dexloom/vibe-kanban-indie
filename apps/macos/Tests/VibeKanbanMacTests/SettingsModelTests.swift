import XCTest
@testable import VibeKanbanMac

/// Decoding of the full `Repo` wire shape and encoding of the Projects/Repos
/// settings request bodies (snake_case keys; nil fields omitted on partial
/// updates so the backend leaves them unchanged).
final class SettingsModelTests: XCTestCase {
    private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try APICoding.encoder.encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRepoDecodesFullShape() throws {
        let json = """
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "path": "/Users/me/code/app",
          "name": "app",
          "display_name": "My App",
          "setup_script": "pnpm i",
          "cleanup_script": null,
          "archive_script": null,
          "copy_files": null,
          "parallel_setup_script": false,
          "dev_server_script": "pnpm dev",
          "default_target_branch": "main",
          "default_working_dir": null,
          "created_at": "2026-06-19T15:10:17.722Z",
          "updated_at": "2026-06-27T04:55:04.925Z"
        }
        """
        let repo = try APICoding.decoder.decode(Repo.self, from: Data(json.utf8))
        XCTAssertEqual(repo.id, "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual(repo.path, "/Users/me/code/app")
        XCTAssertEqual(repo.displayName, "My App")
        XCTAssertEqual(repo.setupScript, "pnpm i")
        XCTAssertEqual(repo.devServerScript, "pnpm dev")
        XCTAssertEqual(repo.defaultTargetBranch, "main")
        XCTAssertNil(repo.cleanupScript)
        XCTAssertNotNil(repo.createdAt)
    }

    func testRepoListEnvelopeDecodes() throws {
        // `/v1/projects/{id}/repos` returns `{ "repos": [...] }`.
        let json = """
        { "repos": [ { "id": "r1", "path": "/p", "name": "p", "display_name": "P",
          "parallel_setup_script": false } ] }
        """
        let resp = try APICoding.decoder.decode(ReposResponse.self, from: Data(json.utf8))
        XCTAssertEqual(resp.repos.count, 1)
        XCTAssertEqual(resp.repos.first?.displayName, "P")
    }

    func testCreateProjectRequestEncoding() throws {
        let obj = try encodedObject(
            CreateProjectRequest(id: nil, organizationId: "org-1", name: "New", color: "#6366f1"))
        XCTAssertEqual(obj["organization_id"] as? String, "org-1")
        XCTAssertEqual(obj["name"] as? String, "New")
        XCTAssertEqual(obj["color"] as? String, "#6366f1")
        XCTAssertNil(obj["id"], "nil id must be omitted")
    }

    func testUpdateProjectRequestOmitsNils() throws {
        let obj = try encodedObject(UpdateProjectRequest(name: "Renamed"))
        XCTAssertEqual(obj["name"] as? String, "Renamed")
        XCTAssertNil(obj["color"])
        XCTAssertNil(obj["sort_order"])
    }

    func testRegisterRepoRequestEncoding() throws {
        let withName = try encodedObject(RegisterRepoRequest(path: "/code/app", displayName: "App"))
        XCTAssertEqual(withName["path"] as? String, "/code/app")
        XCTAssertEqual(withName["display_name"] as? String, "App")

        let withoutName = try encodedObject(RegisterRepoRequest(path: "/code/app"))
        XCTAssertNil(withoutName["display_name"], "nil display_name must be omitted")
    }

    func testUpdateRepoRequestSnakeCaseAndOmission() throws {
        let obj = try encodedObject(
            UpdateRepoRequest(displayName: "App", defaultTargetBranch: "develop"))
        XCTAssertEqual(obj["display_name"] as? String, "App")
        XCTAssertEqual(obj["default_target_branch"] as? String, "develop")
        XCTAssertNil(obj["setup_script"])
        XCTAssertNil(obj["cleanup_script"])
        XCTAssertNil(obj["dev_server_script"])
        XCTAssertNil(obj["default_working_dir"])
    }

    func testLinkRepoRequestEncoding() throws {
        let obj = try encodedObject(LinkRepoRequest(repoId: "repo-42"))
        XCTAssertEqual(obj["repo_id"] as? String, "repo-42")
    }

    // MARK: - Project repo defaults (scratch)

    func testProjectRepoDefaultsRecordDecodes() throws {
        // The shape of `GET /api/scratch/PROJECT_REPO_DEFAULTS/{id}` -> .data.
        let json = """
        { "payload": { "type": "PROJECT_REPO_DEFAULTS",
          "data": { "repos": [ { "repo_id": "r1", "target_branch": "main" } ] } } }
        """
        let rec = try APICoding.decoder.decode(ProjectRepoDefaultsRecord.self, from: Data(json.utf8))
        XCTAssertEqual(rec.payload.type, "PROJECT_REPO_DEFAULTS")
        XCTAssertEqual(rec.payload.data.repos.first?.repoId, "r1")
        XCTAssertEqual(rec.payload.data.repos.first?.targetBranch, "main")
    }

    func testScratchUpdateRequestEncoding() throws {
        let obj = try encodedObject(
            ScratchUpdateRequest(repos: [DraftWorkspaceRepo(repoId: "r1", targetBranch: "dev")]))
        let payload = try XCTUnwrap(obj["payload"] as? [String: Any])
        XCTAssertEqual(payload["type"] as? String, "PROJECT_REPO_DEFAULTS")
        let data = try XCTUnwrap(payload["data"] as? [String: Any])
        let repos = try XCTUnwrap(data["repos"] as? [[String: Any]])
        XCTAssertEqual(repos.first?["repo_id"] as? String, "r1")
        XCTAssertEqual(repos.first?["target_branch"] as? String, "dev")
    }
}
