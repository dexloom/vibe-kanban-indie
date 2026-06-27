import XCTest
@testable import VibeKanbanMac

/// Parsing of the per-agent executor JSON Schemas (the same ones bundled from
/// `shared/schemas/`) into ordered, typed form fields.
final class ExecutorSchemaTests: XCTestCase {
    // Mirrors the real schema shape/formatting (draft-07, nullable types).
    private let schemaJSON = """
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "properties": {
        "append_prompt": {
          "title": "Append Prompt",
          "description": "Extra text appended to the prompt",
          "type": ["string", "null"],
          "format": "textarea"
        },
        "model": {
          "type": ["string", "null"]
        },
        "effort": {
          "type": ["string", "null"],
          "enum": ["low", "medium", "high", null]
        },
        "plan": {
          "type": ["boolean", "null"]
        },
        "additional_params": {
          "title": "Additional Parameters",
          "type": ["array", "null"],
          "items": { "type": "string" }
        },
        "env": {
          "title": "Environment Variables",
          "type": ["object", "null"],
          "additionalProperties": { "type": "string" }
        }
      },
      "type": "object"
    }
    """

    private func schema() throws -> ExecutorSchema {
        try XCTUnwrap(ExecutorSchema.parse(Data(schemaJSON.utf8)))
    }

    func testFieldOrderMatchesSchema() throws {
        let names = try schema().fields.map(\.name)
        XCTAssertEqual(names, ["append_prompt", "model", "effort", "plan", "additional_params", "env"])
    }

    func testFieldKinds() throws {
        let byName = Dictionary(uniqueKeysWithValues: try schema().fields.map { ($0.name, $0.kind) })
        XCTAssertEqual(byName["append_prompt"], .textarea)
        XCTAssertEqual(byName["model"], .text)
        XCTAssertEqual(byName["effort"], .enumeration(["low", "medium", "high"]))  // null filtered
        XCTAssertEqual(byName["plan"], .boolean)
        XCTAssertEqual(byName["additional_params"], .stringArray)
        XCTAssertEqual(byName["env"], .stringMap)
    }

    func testTitleFallbackPrettifiesName() throws {
        let model = try XCTUnwrap(try schema().fields.first { $0.name == "model" })
        XCTAssertEqual(model.title, "Model")          // no explicit title → prettified
        let ap = try XCTUnwrap(try schema().fields.first { $0.name == "append_prompt" })
        XCTAssertEqual(ap.title, "Append Prompt")     // explicit title used
    }

    func testInvalidSchemaReturnsNil() {
        XCTAssertNil(ExecutorSchema.parse(Data("not json".utf8)))
        XCTAssertNil(ExecutorSchema.parse(Data("{}".utf8)))  // no properties
    }
}
