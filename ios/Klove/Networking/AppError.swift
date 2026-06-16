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
}
