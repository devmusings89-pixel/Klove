import Foundation

/// Typed errors per project conventions.
enum AppError: LocalizedError {
    case networkError(underlying: Error)
    case server(status: Int, message: String)
    case decoding(underlying: Error)
    case validationError(message: String)

    var errorDescription: String? {
        switch self {
        case .networkError(let error): return error.localizedDescription
        case .server(let status, let message): return "Server error (\(status)): \(message)"
        case .decoding(let error): return "Could not read server response: \(error.localizedDescription)"
        case .validationError(let message): return message
        }
    }

    /// Safe, user-facing copy (never leaks raw server strings or status codes).
    var userMessage: String {
        switch self {
        case .networkError: return "Couldn't reach Klove. Check your connection and try again."
        case .server(let status, _) where status == 401: return "Your session expired. Sign in again, then retry."
        case .server(let status, _) where (400..<500).contains(status): return "Klove couldn't load this — it may no longer be available."
        case .server: return "Klove hit a problem on its end. Trying again…"
        case .decoding: return "Couldn't read Klove's response."
        case .validationError(let message): return message
        }
    }

    /// 401 specifically — the session is gone and the user must re-authenticate.
    var isUnauthorized: Bool {
        if case .server(let status, _) = self { return status == 401 }
        return false
    }

    /// A 4xx that won't recover by simply waiting and retrying the same request.
    var isPermanentClientError: Bool {
        if case .server(let status, _) = self { return (400..<500).contains(status) }
        return false
    }
}
