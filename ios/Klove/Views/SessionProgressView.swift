import SwiftUI

/// Live progress + results for one session. Polls the backend until terminal.
struct SessionProgressView: View {
    let sessionId: String

    @Environment(Router.self) private var router
    @State private var state: SessionState?
    @State private var errorMessage: String?
    /// True when polling stopped on an error that won't recover on its own (4xx / expired session).
    /// We keep showing the last good state, but with a banner + Retry so it's never silently stale.
    @State private var stalled = false
    /// Bumping this restarts the polling `.task`.
    @State private var retryAttempt = 0
    private let api = APIClient()

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(stalled ? "Live updates paused" : "Reconnecting…",
                              systemImage: stalled ? "wifi.exclamationmark" : "arrow.triangle.2.circlepath")
                            .font(.kloveSectionHeader)
                            .foregroundStyle(stalled ? Theme.needsYou : Theme.inkSecondary)
                        Text(errorMessage).font(.footnote).foregroundStyle(Theme.inkSecondary)
                        if stalled {
                            Button {
                                retryAttempt += 1
                            } label: {
                                Label("Retry", systemImage: "arrow.clockwise")
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.accent)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listRowBackground(Theme.surface)
            }
            if let state {
                Section {
                    Label(SessionStatusCopy.title(state.status), systemImage: SessionStatusCopy.icon(state.status))
                        .font(.kloveSectionHeader).foregroundStyle(Theme.ink)
                }
                .listRowBackground(Theme.surface)
                if state.needsChoice {
                    Section {
                        Button {
                            router.push(.choice(sessionId: sessionId))
                        } label: {
                            Label("Choose a time (\(state.aggregatedOptions.count) options)", systemImage: "calendar.badge.clock")
                                .font(.kloveSectionHeader)
                        }
                    } footer: {
                        Text("Your preferred times weren't available. Pick one and we'll call back to book it.")
                    }
                    .listRowBackground(Theme.surface)
                }
                if state.needsInfo {
                    Section {
                        Button {
                            router.push(.info(sessionId: sessionId))
                        } label: {
                            Label("Provide info", systemImage: "exclamationmark.bubble")
                                .font(.kloveSectionHeader)
                        }
                    } footer: {
                        Text("An office needs more details before it can book. Tap to provide them.")
                    }
                    .listRowBackground(Theme.surface)
                }
                if state.needsVerification {
                    Section {
                        Button {
                            router.push(.verify(sessionId: sessionId))
                        } label: {
                            Label("Enter verification code", systemImage: "lock.shield")
                                .font(.kloveSectionHeader)
                        }
                    } footer: {
                        Text("The office sent you a one-time code. Enter it so we can finish booking.")
                    }
                    .listRowBackground(Theme.surface)
                }
                Section("Offices") {
                    ForEach(state.targets) { target in
                        OfficeRow(target: target)
                    }
                }
                .listRowBackground(Theme.surface)
                if state.status == "completed", state.targets.contains(where: { $0.status == "booked" || $0.status == "transferred" }) {
                    Section {
                        Label("Saved to Today, Actions, and the member's timeline.", systemImage: "tray.full")
                            .foregroundStyle(Theme.inkSecondary)
                    }
                    .listRowBackground(Theme.surface)
                }
            } else if errorMessage == nil {
                ProgressView("Starting calls…").tint(Theme.accent)
            }
        }
        .scrollContentBackground(.hidden)
        .kloveBackground()
        .tint(Theme.accent)
        .navigationTitle("Progress")
        .task(id: retryAttempt) { await poll() }
    }

    private func poll() async {
        // Poll until the session reaches a terminal state. Transient/network errors back off and keep
        // retrying (banner shows "Reconnecting…"). A 4xx won't recover on its own, so we STOP and flip
        // `stalled` — the user sees the last good state with a Retry button instead of a silently frozen
        // screen (and a 401 tells them their session expired rather than spinning forever).
        var delay = 2
        stalled = false
        while !Task.isCancelled {
            do {
                let s = try await api.getSession(id: sessionId)
                state = s
                errorMessage = nil
                stalled = false
                delay = 2 // recovered — reset backoff
                if s.isTerminal { return }
            } catch {
                let appError = error as? AppError
                errorMessage = appError?.userMessage ?? error.localizedDescription
                if appError?.isPermanentClientError == true {
                    stalled = true // surface a Retry affordance; don't hammer the backend
                    return
                }
                delay = min(delay * 2, 30) // exponential backoff on transient/network errors
            }
            try? await Task.sleep(for: .seconds(delay))
        }
    }
}
