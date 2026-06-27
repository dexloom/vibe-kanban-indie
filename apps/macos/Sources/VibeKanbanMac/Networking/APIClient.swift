import Foundation

enum APIError: LocalizedError {
    case noBackend
    case badURL
    case http(status: Int, body: String)
    case decoding(String)
    case transport(String)
    case emptyEnvelope(String?)

    var errorDescription: String? {
        switch self {
        case .noBackend: return "Backend not found. Is the vibe-kanban server running?"
        case .badURL: return "Bad URL."
        case .http(let status, let body): return "HTTP \(status): \(body)"
        case .decoding(let m): return "Decoding failed: \(m)"
        case .transport(let m): return "Network error: \(m)"
        case .emptyEnvelope(let m): return m ?? "Empty response from server."
        }
    }
}

/// REST client for the local backend. Board reads use the `{ "<table>": [...] }`
/// fallback envelope, mutations use `{ data, txid }`, and execution endpoints
/// use `ApiResponse<T>`.
final class APIClient {
    private(set) var baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 15
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    // MARK: - Low level

    private func send(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil
    ) async throws -> Data {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        comps.path = path
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = method
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("No HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                throw APIError.http(status: http.statusCode, body: String(body.prefix(500)))
            }
            return data
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try APICoding.decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding("\(T.self): \(error)") }
    }

    /// Decode an `ApiResponse<T>` and unwrap `.data`.
    private func envelope<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let env = try decode(ApiResponse<T>.self, data)
        guard let value = env.data else { throw APIError.emptyEnvelope(env.message) }
        return value
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        do { return try APICoding.encoder.encode(value) }
        catch { throw APIError.decoding("encode \(T.self): \(error)") }
    }

    // MARK: - Connectivity

    func ping() async -> Bool {
        // `/api/health` returns `ApiResponse<String>`; the bare `/health` path is
        // swallowed by the SPA fallback (returns index.html), so it must be /api.
        (try? await send("GET", "/api/health")) != nil
    }

    // MARK: - Board reads (fallback envelope)

    func listProjects() async throws -> [Project] {
        try decode(ProjectsResponse.self, await send("GET", "/v1/fallback/projects")).projects
    }

    func listStatuses(projectId: String) async throws -> [ProjectStatus] {
        try decode(ProjectStatusesResponse.self,
                   await send("GET", "/v1/fallback/project_statuses", query: [.init(name: "project_id", value: projectId)])
        ).project_statuses
    }

    func listIssues(projectId: String) async throws -> [Issue] {
        try decode(IssuesResponse.self,
                   await send("GET", "/v1/fallback/issues", query: [.init(name: "project_id", value: projectId)])
        ).issues
    }

    func listTags(projectId: String) async throws -> [Tag] {
        try decode(TagsResponse.self,
                   await send("GET", "/v1/fallback/tags", query: [.init(name: "project_id", value: projectId)])
        ).tags
    }

    func listIssueTags(projectId: String) async throws -> [IssueTag] {
        try decode(IssueTagsResponse.self,
                   await send("GET", "/v1/fallback/issue_tags", query: [.init(name: "project_id", value: projectId)])
        ).issue_tags
    }

    func listIssueAssignees(projectId: String) async throws -> [IssueAssignee] {
        try decode(IssueAssigneesResponse.self,
                   await send("GET", "/v1/fallback/issue_assignees", query: [.init(name: "project_id", value: projectId)])
        ).issue_assignees
    }

    func listWorkspaceSummaries(projectId: String) async throws -> [WorkspaceSummary] {
        try decode(WorkspaceSummariesResponse.self,
                   await send("GET", "/v1/fallback/project_workspaces", query: [.init(name: "project_id", value: projectId)])
        ).workspaces
    }

    // MARK: - Board mutations (data/txid envelope)

    @discardableResult
    func createIssue(_ req: CreateIssueRequest) async throws -> Issue {
        try decode(MutationResponse<Issue>.self, await send("POST", "/v1/issues", body: try encode(req))).data
    }

    @discardableResult
    func updateIssue(id: String, _ req: UpdateIssueRequest) async throws -> Issue {
        try decode(MutationResponse<Issue>.self, await send("PATCH", "/v1/issues/\(id)", body: try encode(req))).data
    }

    @discardableResult
    func bulkUpdateIssues(_ items: [BulkIssueItem]) async throws -> [Issue] {
        let body = try encode(BulkIssuesRequest(updates: items))
        return try decode(MutationResponse<[Issue]>.self, await send("POST", "/v1/issues/bulk", body: body)).data
    }

    func deleteIssue(id: String) async throws {
        _ = try await send("DELETE", "/v1/issues/\(id)")
    }

    func listRepos(projectId: String) async throws -> [Repo] {
        try decode(ReposResponse.self, await send("GET", "/v1/projects/\(projectId)/repos")).repos
    }

    // MARK: - Spec / intake

    func generateSpec(_ req: GenerateSpecRequest) async throws -> GenerateSpecResponse {
        try envelope(GenerateSpecResponse.self, await send("POST", "/api/spec/generate", body: try encode(req)))
    }

    // MARK: - Execution (ApiResponse envelope)
    //
    // These live under the `/api` prefix in the backend router (see
    // `crates/server/src/routes/mod.rs` — `.nest("/api", api_routes)`). Only the
    // board `/v1/*` routes are served at the root, so everything here needs `/api`.

    func listWorkspaces() async throws -> [Workspace] {
        try envelope([Workspace].self, await send("GET", "/api/workspaces"))
    }

    func getWorkspace(id: String) async throws -> Workspace {
        try envelope(Workspace.self, await send("GET", "/api/workspaces/\(id)"))
    }

    @discardableResult
    func startWorkspace(_ req: CreateAndStartWorkspaceRequest) async throws -> CreateAndStartWorkspaceResponse {
        try envelope(CreateAndStartWorkspaceResponse.self, await send("POST", "/api/workspaces/start", body: try encode(req)))
    }

    func listSessions(workspaceId: String) async throws -> [Session] {
        try envelope([Session].self,
                     await send("GET", "/api/sessions", query: [.init(name: "workspace_id", value: workspaceId)]))
    }

    func listExecutions(sessionId: String) async throws -> [ExecutionProcess] {
        try envelope([ExecutionProcess].self, await send("GET", "/api/sessions/\(sessionId)/executions"))
    }

    func followUp(sessionId: String, _ req: CreateFollowUpAttempt) async throws {
        _ = try await send("POST", "/api/sessions/\(sessionId)/follow-up", body: try encode(req))
    }

    func agentProgress(executionId: String) async throws -> JSONValue {
        try envelope(JSONValue.self, await send("GET", "/api/execution-processes/\(executionId)/agent-progress"))
    }

    // MARK: - Approvals

    func pendingApprovals(executionId: String) async throws -> [ApprovalInfo] {
        try envelope([ApprovalInfo].self, await send("GET", "/api/approvals/pending/\(executionId)"))
    }

    func respondToApproval(approvalId: String, _ response: ApprovalResponse) async throws {
        _ = try await send("POST", "/api/approvals/\(approvalId)/respond", body: try encode(response))
    }

    // MARK: - Config / system

    func systemInfo() async throws -> JSONValue {
        // `/api/info` returns `ApiResponse<UserSystemInfo>`; decode loosely.
        try envelope(JSONValue.self, await send("GET", "/api/info"))
    }

    func agentAvailability(_ executor: BaseCodingAgent) async throws -> AvailabilityInfo {
        try envelope(AvailabilityInfo.self,
                     await send("GET", "/api/agents/check-availability",
                                query: [.init(name: "executor", value: executor.rawValue)]))
    }
}
