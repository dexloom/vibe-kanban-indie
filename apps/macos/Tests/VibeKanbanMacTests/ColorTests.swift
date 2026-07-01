import SwiftUI
import XCTest

@testable import VibeKanbanMac

/// Covers the HSL color parsing that fixes project/status/tag colors (the backend
/// stores them as HSL triples like "217 91% 60%", not hex).
final class ColorTests: XCTestCase {
    func testHSLComponentsParsesTriple() {
        let c = Color.hslComponents("217 91% 60%")
        XCTAssertEqual(c?.h, 217)
        XCTAssertEqual(c?.s, 91)
        XCTAssertEqual(c?.l, 60)
    }

    func testHSLComponentsToleratesCommas() {
        let c = Color.hslComponents("355, 65%, 53%")
        XCTAssertEqual(c?.h, 355)
        XCTAssertEqual(c?.s, 65)
        XCTAssertEqual(c?.l, 53)
    }

    func testHSLComponentsRejectsHex() {
        // A hex string must not parse as HSL (so it falls through to the hex parser).
        XCTAssertNil(Color.hslComponents("5B73F2"))
        XCTAssertNil(Color.hslComponents("#6172F3"))
    }

    func testHSLToRGBPrimaries() {
        assertRGB(Color.hslToRGB(h: 0, s: 1, l: 0.5), 1, 0, 0)      // red
        assertRGB(Color.hslToRGB(h: 120, s: 1, l: 0.5), 0, 1, 0)   // green
        assertRGB(Color.hslToRGB(h: 240, s: 1, l: 0.5), 0, 0, 1)   // blue
        assertRGB(Color.hslToRGB(h: 0, s: 0, l: 0), 0, 0, 0)       // black
        assertRGB(Color.hslToRGB(h: 0, s: 0, l: 1), 1, 1, 1)       // white
    }

    private func assertRGB(_ rgb: (Double, Double, Double), _ r: Double, _ g: Double, _ b: Double,
                           file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(rgb.0, r, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(rgb.1, g, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(rgb.2, b, accuracy: 0.001, file: file, line: line)
    }
}
