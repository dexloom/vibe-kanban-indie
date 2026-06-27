import Foundation

/// Agent availability (`/agents/check-availability`). Mirrors `shared/types.ts`
/// `AvailabilityInfo`.
enum AvailabilityInfo: Decodable, Hashable {
    case loginDetected(lastAuth: Int64?)
    case installationFound
    case notFound
    case unknown

    private enum CodingKeys: String, CodingKey { case type, last_auth_timestamp }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch (try? c.decode(String.self, forKey: .type)) ?? "" {
        case "LOGIN_DETECTED":
            self = .loginDetected(lastAuth: try? c.decode(Int64.self, forKey: .last_auth_timestamp))
        case "INSTALLATION_FOUND":
            self = .installationFound
        case "NOT_FOUND":
            self = .notFound
        default:
            self = .unknown
        }
    }

    var available: Bool {
        switch self {
        case .loginDetected, .installationFound: return true
        case .notFound, .unknown: return false
        }
    }

    var label: String {
        switch self {
        case .loginDetected: return "Logged in"
        case .installationFound: return "Installed"
        case .notFound: return "Not found"
        case .unknown: return "Unknown"
        }
    }
}

/// `/editors/check-availability` response.
struct EditorAvailability: Decodable { let available: Bool }
