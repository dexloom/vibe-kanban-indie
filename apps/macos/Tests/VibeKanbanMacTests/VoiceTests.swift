import XCTest
@testable import VibeKanbanMac

/// A `URLProtocol` that records every request and returns a path-appropriate
/// canned body, so `VoicyClient`'s session/poll flow runs offline to completion.
final class VoicyStubProtocol: URLProtocol {
    static var calls: [(method: String, path: String)] = []
    /// Body of the most recent `POST /dictate/session`.
    static var sessionBody: Data?
    static func reset() { calls = []; sessionBody = nil }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.calls.append((request.httpMethod ?? "GET", path))
        if path == "/dictate/session" { Self.sessionBody = Self.readBody(request) }

        let body: String
        if path == "/dictate/session" {
            body = #"{"sessionId":"sess-1"}"#
        } else if path == "/agents" {
            body = #"{"agents":[{"id":"reviewer","name":"Reviewer"},{"id":"asker","name":"Asker"}]}"#
        } else if path.hasSuffix("/cancel") {
            body = #"{"ok":true}"#
        } else if path.hasPrefix("/dictate/session/") {
            body = #"{"status":"sent","text":"done"}"#   // resolves the poll immediately
        } else {
            body = #"{"ok":true}"#                         // /health etc.
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// URLSession turns `httpBody` into `httpBodyStream`, so read whichever is set.
    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        let size = 4096
        var buffer = [UInt8](repeating: 0, count: size)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: size)
            if read > 0 { data.append(buffer, count: read) } else { break }
        }
        return data
    }
}

/// Covers the Voicy dictation client: port-file discovery, the conversation
/// context wire shape (camelCase, to match Voicy's `DictationContextDTO`), the
/// chat context builder, and the session/poll IPC route contract.
final class VoiceTests: XCTestCase {
    // MARK: - VoicyDiscovery

    func testDiscoveryParsesPortFile() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voicy.port.\(UUID().uuidString)")
        try "54321\n".write(to: tmp, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertEqual(VoicyDiscovery.resolveBaseURL(portFile: tmp)?.absoluteString,
                       "http://127.0.0.1:54321")
    }

    func testDiscoveryNilForMissingOrBadPort() throws {
        XCTAssertNil(VoicyDiscovery.resolveBaseURL(portFile: URL(fileURLWithPath: "/no/such/voicy.port")))
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voicy.bad.\(UUID().uuidString)")
        try "nope".write(to: tmp, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertNil(VoicyDiscovery.resolveBaseURL(portFile: tmp))
    }

    // MARK: - DictationContext / DictationMode

    func testContextEncodesCamelCase() throws {
        let ctx = DictationContext(surface: "chat", title: "T", project: "P",
                                   agent: "claude-code",
                                   conversationTail: ["hi", "there"], terms: ["Foo"])
        let data = try JSONEncoder().encode(ctx)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["surface"] as? String, "chat")
        XCTAssertEqual(obj["conversationTail"] as? [String], ["hi", "there"])
        XCTAssertEqual(obj["terms"] as? [String], ["Foo"])
        XCTAssertNil(obj["conversation_tail"], "wire keys must be camelCase to match Voicy")
    }

    func testContextChatBuilderFiltersAndTrims() {
        let entries: [NormalizedEntry] = [
            .init(timestamp: nil, entryType: .userMessage, content: "  build the thing  "),
            .init(timestamp: nil, entryType: .thinking, content: "hmm"),
            .init(timestamp: nil, entryType: .assistantMessage, content: "on it"),
            .init(timestamp: nil, entryType: .toolUse(toolName: "bash", status: .success), content: "ran"),
        ]
        let ctx = DictationContext.chat(title: "Card", entries: entries)
        XCTAssertEqual(ctx.surface, "chat")
        XCTAssertEqual(ctx.title, "Card")
        XCTAssertEqual(ctx.conversationTail, ["build the thing", "on it"])
    }

    func testDictationModeRawValues() {
        XCTAssertEqual(DictationMode.agent.rawValue, "agent")
        XCTAssertEqual(DictationMode.task.rawValue, "task")
    }

    func testSituationMapsToMode() {
        XCTAssertEqual(DictationSituation.instruction.mode, .agent)
        XCTAssertEqual(DictationSituation.questionnaire.mode, .agent)
        XCTAssertEqual(DictationSituation.review.mode, .agent)
        XCTAssertEqual(DictationSituation.task.mode, .task)   // Task composer, not an agent
    }

    func testVoiceAgentMapRoundTrips() {
        defer { UserDefaults.standard.removeObject(forKey: "voiceAgent.review") }
        VoiceAgentMap.setAgentId("reviewer", for: .review)
        XCTAssertEqual(VoiceAgentMap.agentId(for: .review), "reviewer")
        VoiceAgentMap.setAgentId(nil, for: .review)
        XCTAssertNil(VoiceAgentMap.agentId(for: .review))   // explicit empty → nil (active agent)
    }

    func testAgentSituationsDefaultToVibeKanbanAgent() {
        for situation in [DictationSituation.instruction, .questionnaire, .review] {
            UserDefaults.standard.removeObject(forKey: "voiceAgent.\(situation.rawValue)")
            XCTAssertEqual(situation.defaultAgentId, "vibe-kanban")
            XCTAssertEqual(VoiceAgentMap.agentId(for: situation), "vibe-kanban")
        }
        XCTAssertNil(DictationSituation.task.defaultAgentId)   // Task composer, no agent
    }

    // MARK: - VoicyClient session/poll routes

    private func makeClient() -> VoicyClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [VoicyStubProtocol.self]
        return VoicyClient(session: URLSession(configuration: config),
                           baseURLOverride: URL(string: "http://127.0.0.1:9998")!)
    }

    func testRequestDictationOpensSessionAndReturnsSentText() async throws {
        VoicyStubProtocol.reset()
        let text = try await makeClient().requestDictation(
            mode: .agent, context: DictationContext(surface: "chat"))
        XCTAssertEqual(text, "done")
        let calls = VoicyStubProtocol.calls.map { "\($0.method) \($0.path)" }
        XCTAssertTrue(calls.contains("POST /dictate/session"), "saw: \(calls)")
        XCTAssertTrue(calls.contains { $0.hasPrefix("GET /dictate/session/") }, "saw: \(calls)")
    }

    func testSessionBodyCarriesModeAndAgentId() async throws {
        VoicyStubProtocol.reset()
        _ = try await makeClient().requestDictation(
            mode: .agent, agentId: "reviewer", context: DictationContext(surface: "chat"))
        let body = try XCTUnwrap(VoicyStubProtocol.sessionBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["mode"] as? String, "agent")
        XCTAssertEqual(obj["agentId"] as? String, "reviewer")
    }

    func testListAgentsParsesResponse() async throws {
        VoicyStubProtocol.reset()
        let agents = try await makeClient().listAgents()
        XCTAssertEqual(agents.map(\.id), ["reviewer", "asker"])
        XCTAssertEqual(VoicyStubProtocol.calls.last?.path, "/agents")
    }

    func testCancelRoute() async {
        VoicyStubProtocol.reset()
        await makeClient().cancel(sessionId: "s1")
        XCTAssertEqual(VoicyStubProtocol.calls.last?.method, "POST")
        XCTAssertEqual(VoicyStubProtocol.calls.last?.path, "/dictate/session/s1/cancel")
    }
}
