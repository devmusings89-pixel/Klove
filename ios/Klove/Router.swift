import SwiftUI

/// Type-safe navigation routes.
enum Route: Hashable {
    case progress(sessionId: String)
    case choice(sessionId: String)
    case info(sessionId: String)
    case verify(sessionId: String)
    case form   // manual booking form (fallback from the assistant)
}

@Observable
final class Router {
    var path = NavigationPath()

    func push(_ route: Route) { path.append(route) }
    func reset() { path = NavigationPath() }
}
