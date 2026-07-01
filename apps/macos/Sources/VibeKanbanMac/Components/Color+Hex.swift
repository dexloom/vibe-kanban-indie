import SwiftUI

extension Color {
    /// Parse a backend-supplied color string. The backend (and the web app) store
    /// project / status / tag colors as **HSL triples** — `"H S% L%"`
    /// (e.g. `"217 91% 60%"`, validated by `crates/remote/src/db/types.rs`) and
    /// render them with CSS `hsl(...)`. This also accepts an `hsl(...)` wrapper,
    /// comma separators, and falls back to hex (`#RRGGBB[AA]`) for anything else.
    init(css raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.lowercased().hasPrefix("hsl"),
           let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")") {
            s = String(s[s.index(after: open)..<close])
        }
        if let (h, sat, l) = Color.hslComponents(s) {
            let (r, g, b) = Color.hslToRGB(h: h, s: sat / 100, l: l / 100)
            self = Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
            return
        }
        self = Color(hex: s)
    }

    /// Parse `"H S% L%"` (commas/`%` optional). Returns nil unless exactly three
    /// numbers are present (so hex strings fall through to the hex parser).
    static func hslComponents(_ s: String) -> (h: Double, s: Double, l: Double)? {
        let cleaned = s.replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "%", with: "")
        let parts = cleaned.split(whereSeparator: { $0 == " " }).compactMap { Double($0) }
        guard parts.count == 3 else { return nil }
        return (parts[0], parts[1], parts[2])
    }

    /// HSL → RGB (all outputs 0…1). SwiftUI's `Color(hue:saturation:brightness:)`
    /// is HSB, not HSL, so we convert explicitly.
    static func hslToRGB(h: Double, s: Double, l: Double) -> (Double, Double, Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r1, g1, b1): (Double, Double, Double)
        switch hp {
        case 0..<1: (r1, g1, b1) = (c, x, 0)
        case 1..<2: (r1, g1, b1) = (x, c, 0)
        case 2..<3: (r1, g1, b1) = (0, c, x)
        case 3..<4: (r1, g1, b1) = (0, x, c)
        case 4..<5: (r1, g1, b1) = (x, 0, c)
        default:    (r1, g1, b1) = (c, 0, x)
        }
        let m = l - c / 2
        return (r1 + m, g1 + m, b1 + m)
    }

    /// Parse a backend color string like `#5B73F2`, `5B73F2`, or `#RRGGBBAA`.
    /// Falls back to gray for anything unrecognized.
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
        var value: UInt64 = 0
        guard Scanner(string: cleaned).scanHexInt64(&value) else {
            self = .gray
            return
        }
        let r, g, b, a: Double
        switch cleaned.count {
        case 6:
            r = Double((value & 0xFF0000) >> 16) / 255
            g = Double((value & 0x00FF00) >> 8) / 255
            b = Double(value & 0x0000FF) / 255
            a = 1
        case 8:
            r = Double((value & 0xFF000000) >> 24) / 255
            g = Double((value & 0x00FF0000) >> 16) / 255
            b = Double((value & 0x0000FF00) >> 8) / 255
            a = Double(value & 0x000000FF) / 255
        default:
            self = .gray
            return
        }
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}
