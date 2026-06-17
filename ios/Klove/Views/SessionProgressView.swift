import SwiftUI

/// Live progress + results for one session. Polls the backend until terminal.
struct SessionProgressView: View {
    let sessionId: String

    @Environment(Router.self) private var router
    @State private var state: SessionState?
    @State private var errorMessage: String?
    private let api = APIClient()

    var body: some View {
        List {
            if let state {
                Section {
                    Label(SessionStatusCopy.title(state.status), systemImage: SessionStatusCopy.icon(state.status))
                        .font(.headline)
                }
                if state.needsChoice {
                    Section {
                        Button {
                            router.push(.choice(sessionId: sessionId))
                        } label: {
                            Label("Choose a time (\(state.aggregatedOptions.count) options)", systemImage: "calendar.badge.clock")
                                .font(.headline)
                        }
                    } footer: {
                        Text("Your preferred times weren't available. Pick one and we'll call back to book it.")
                    }
                }
                if state.needsInfo {
                    Section {
                        Button {
                            router.push(.info(sessionId: sessionId))
                        } label: {
                            Label("Provide info", systemImage: "exclamationmark.bubble")
                                .font(.headline)
                        }
                    } footer: {
                        Text("An office needs more details before it can book. Tap to provide them.")
                    }
                }
                if state.needsVerification {
                    Section {
                        Button {
                            router.push(.verify(sessionId: sessionId))
                        } label: {
                            Label("Enter verification code", systemImage: "lock.shield")
                                .font(.headline)
                        }
                    } footer: {
                        Text("The office sent you a one-time code. Enter it so we can finish booking.")
                    }
                }
                Section("Offices") {
                    ForEach(state.targets) { target in
                        OfficeRow(target: target)
                    }
                }
                if state.status == "completed", state.targets.contains(where: { $0.status == "booked" || $0.status == "transferred" }) {
                    Section {
                        Label("Saved to Today, Actions, and the member's timeline.", systemImage: "tray.full")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.red)
            } else {
                ProgressView("Starting calls…")
            }
        }
        .navigationTitle("Progress")
        .task { await poll() }
    }

    private func poll() async {
        // Poll until the session reaches a terminal state. Back off on transient errors and STOP on
        // an HTTP 4xx (e.g. 403/404 after the auth changes) — those won't recover by retrying, so
        // looping forever would just hammer the backend.
        var delay = 3
        while !Task.isCancelled {
            do {
                let s = try await api.getSession(id: sessionId)
                state = s
                errorMessage = nil
                delay = 3 // recovered — reset backoff
                if s.isTerminal { return }
            } catch {
                errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
                if case .server(let status, _)? = error as? AppError, (400..<500).contains(status) { return }
                delay = min(delay * 2, 30) // exponential backoff on transient/network errors
            }
            try? await Task.sleep(for: .seconds(delay))
        }
    }
}
