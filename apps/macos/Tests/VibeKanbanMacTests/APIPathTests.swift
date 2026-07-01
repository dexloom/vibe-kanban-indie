import XCTest
@testable import VibeKanbanMac

/// A `URLProtocol` that records the path of every request and returns a canned
/// 200 body, so we can assert exactly which paths `APIClient` calls without a
/// live backend.
final class RecordingURLProtocol: URLProtocol {
    static var lastPath: String?
    static var lastMethod: String?
    static var body = Data("{}".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastPath = request.url?.path
        Self.lastMethod = request.httpMethod
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Guards the route-prefix contract with the backend router
/// (`crates/server/src/routes/mod.rs`): execution/config/approval/spec routes are
/// nested under `/api`, while the board "fallback" routes are served at root
/// `/v1/*`. A request to the wrong prefix is swallowed by the SPA fallback and
/// returns `index.html` — which is exactly the "Unexpected character '<'" decode
/// failure this prevents.
final class APIPathTests: XCTestCase {
    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: config)
        return APIClient(baseURL: URL(string: "http://127.0.0.1:9999")!, session: session)
    }

    /// Path is recorded before the body is decoded, so `try?` is enough — we only
    /// assert the URL, not the (intentionally mismatched) canned payload.
    private func path(_ work: () async throws -> Void) async -> String? {
        RecordingURLProtocol.lastPath = nil
        _ = try? await work()
        return RecordingURLProtocol.lastPath
    }

    func testExecutionRoutesUseApiPrefix() async {
        let c = makeClient()
        var p = await path { _ = try await c.listWorkspaces() }
        XCTAssertEqual(p, "/api/workspaces")
        p = await path { _ = try await c.getWorkspace(id: "w1") }
        XCTAssertEqual(p, "/api/workspaces/w1")
        p = await path { _ = try await c.listSessions(workspaceId: "w1") }
        XCTAssertEqual(p, "/api/sessions")
        p = await path { _ = try await c.listExecutions(sessionId: "s1") }
        XCTAssertEqual(p, "/api/sessions/s1/executions")
        p = await path { _ = try await c.agentProgress(executionId: "e1") }
        XCTAssertEqual(p, "/api/execution-processes/e1/agent-progress")
        p = await path { _ = try await c.pendingApprovals(executionId: "e1") }
        XCTAssertEqual(p, "/api/approvals/pending/e1")
        p = await path { _ = try await c.systemInfo() }
        XCTAssertEqual(p, "/api/info")
        p = await path { _ = try await c.agentAvailability(.claudeCode) }
        XCTAssertEqual(p, "/api/agents/check-availability")
    }

    func testHealthUsesApiPrefix() async {
        let c = makeClient()
        let p = await path { _ = await c.ping() }
        XCTAssertEqual(p, "/api/health")
    }

    func testSettingsRoutesUseCorrectPrefix() async {
        let c = makeClient()
        // Projects + links are root /v1 board mutations.
        var p = await path {
            _ = try await c.createProject(
                CreateProjectRequest(id: nil, organizationId: "o", name: "n", color: "#fff"))
        }
        XCTAssertEqual(p, "/v1/projects")
        p = await path { _ = try await c.updateProject(id: "p1", UpdateProjectRequest(name: "x")) }
        XCTAssertEqual(p, "/v1/projects/p1")
        p = await path { try await c.deleteProject(id: "p1") }
        XCTAssertEqual(p, "/v1/projects/p1")
        p = await path { try await c.linkRepo(projectId: "p1", repoId: "r1") }
        XCTAssertEqual(p, "/v1/projects/p1/repos")
        p = await path { try await c.unlinkRepo(projectId: "p1", repoId: "r1") }
        XCTAssertEqual(p, "/v1/projects/p1/repos/r1")

        // The repo catalog is under /api.
        p = await path { _ = try await c.listAllRepos() }
        XCTAssertEqual(p, "/api/repos")
        p = await path { _ = try await c.registerRepo(RegisterRepoRequest(path: "/x")) }
        XCTAssertEqual(p, "/api/repos")
        p = await path { _ = try await c.updateRepo(id: "r1", UpdateRepoRequest(displayName: "d")) }
        XCTAssertEqual(p, "/api/repos/r1")
        p = await path { try await c.deleteRepo(id: "r1") }
        XCTAssertEqual(p, "/api/repos/r1")
    }

    func testConfigScratchAndProfilesRoutes() async {
        let c = makeClient()
        // Project repo defaults live in scratch under /api.
        var p = await path { _ = try await c.projectRepoDefaults(projectId: "p1") }
        XCTAssertEqual(p, "/api/scratch/PROJECT_REPO_DEFAULTS/p1")
        p = await path { try await c.setProjectRepoDefaults(projectId: "p1", repos: []) }
        XCTAssertEqual(p, "/api/scratch/PROJECT_REPO_DEFAULTS/p1")
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "PUT")
        // Default agent + raw profiles are backend config under /api.
        p = await path { try await c.updateConfig(.object([:])) }
        XCTAssertEqual(p, "/api/config")
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "PUT")
        p = await path { _ = try await c.profilesContent() }
        XCTAssertEqual(p, "/api/profiles")
        p = await path { try await c.updateProfiles("{}") }
        XCTAssertEqual(p, "/api/profiles")
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "PUT")
    }

    func testRepoMutationMethods() async {
        let c = makeClient()
        _ = await path { _ = try await c.registerRepo(RegisterRepoRequest(path: "/x")) }
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "POST")
        _ = await path { _ = try await c.updateRepo(id: "r1", UpdateRepoRequest(displayName: "d")) }
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "PUT")
        _ = await path { try await c.deleteProject(id: "p1") }
        XCTAssertEqual(RecordingURLProtocol.lastMethod, "DELETE")
    }

    func testBoardRoutesUseRootV1Prefix() async {
        let c = makeClient()
        var p = await path { _ = try await c.listProjects() }
        XCTAssertEqual(p, "/v1/fallback/projects")
        p = await path { _ = try await c.listIssues(projectId: "p1") }
        XCTAssertEqual(p, "/v1/fallback/issues")
        p = await path { _ = try await c.listStatuses(projectId: "p1") }
        XCTAssertEqual(p, "/v1/fallback/project_statuses")
        p = await path { _ = try await c.bulkUpdateIssues([]) }
        XCTAssertEqual(p, "/v1/issues/bulk")
        p = await path { try await c.deleteIssue(id: "i1") }
        XCTAssertEqual(p, "/v1/issues/i1")
    }
}
