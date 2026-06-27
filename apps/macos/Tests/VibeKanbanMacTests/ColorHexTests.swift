import XCTest
import SwiftUI
import AppKit
@testable import VibeKanbanMac

/// Covers the `Color(hex:)` parser.
final class ColorHexTests: XCTestCase {

    private func components(_ color: Color) throws -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) {
        let ns = try XCTUnwrap(NSColor(color).usingColorSpace(.sRGB))
        return (ns.redComponent, ns.greenComponent, ns.blueComponent, ns.alphaComponent)
    }

    func testHashPrefixedSixDigit() throws {
        let c = try components(Color(hex: "#FF0000"))
        XCTAssertEqual(c.r, 1.0, accuracy: 0.02)
        XCTAssertEqual(c.g, 0.0, accuracy: 0.02)
        XCTAssertEqual(c.b, 0.0, accuracy: 0.02)
        XCTAssertEqual(c.a, 1.0, accuracy: 0.02)
    }

    func testNoHashSixDigit() throws {
        let c = try components(Color(hex: "00FF00"))
        XCTAssertEqual(c.r, 0.0, accuracy: 0.02)
        XCTAssertEqual(c.g, 1.0, accuracy: 0.02)
        XCTAssertEqual(c.b, 0.0, accuracy: 0.02)
    }

    func testEightDigitAlpha() throws {
        let c = try components(Color(hex: "0000FF80"))
        XCTAssertEqual(c.b, 1.0, accuracy: 0.02)
        XCTAssertEqual(c.a, 0.5, accuracy: 0.03)
    }

    func testKnownBrandColor() throws {
        let c = try components(Color(hex: "#5B73F2"))
        XCTAssertEqual(c.r, 0x5B / 255.0, accuracy: 0.02)
        XCTAssertEqual(c.g, 0x73 / 255.0, accuracy: 0.02)
        XCTAssertEqual(c.b, 0xF2 / 255.0, accuracy: 0.02)
    }

    func testInvalidFallsBackWithoutCrashing() throws {
        // Should not crash and should produce a usable color.
        _ = try components(Color(hex: "nonsense"))
        _ = try components(Color(hex: ""))
    }
}
