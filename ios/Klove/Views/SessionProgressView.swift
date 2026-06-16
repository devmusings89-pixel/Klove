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
                    Label(statusTitle(state.status), systemImage: statusIcon(state.status))
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
                if state.isTerminal {
                    Section {
                        Label("A summary has been emailed to you.", systemImage: "envelope")
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
        // Simple polling loop; replaced by SSE in Phase 5.
        while !Task.isCancelled {
            do {
                let s = try await api.getSession(id: sessionId)
                state = s
                if s.isTerminal { return }
            } catch {
                errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private func statusTitle(_ s: String) -> String {
        switch s {
        case "paid", "scheduling": return "Scheduling calls…"
        case "in_progress": return "Calling offices…"
        case "awaiting_choice": return "Action needed: choose a time"
        case "awaiting_info": return "Action needed: more info"
        case "awaiting_verification": return "Action needed: enter code"
        case "completed": return "Done"
        case "failed": return "Could not complete"
        default: return s.capitalized
        }
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "completed": return "checkmark.circle.fill"
        case "failed": return "xmark.circle.fill"
        case "awaiting_choice": return "calendar.badge.clock"
        case "awaiting_info": return "exclamationmark.bubble"
        case "awaiting_verification": return "lock.shield"
        default: return "phone.arrow.up.right"
        }
    }
}

private struct OfficeRow: View {
    let target: CallTarget

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(target.officeName).font(.body.weight(.medium))
                if let channel = target.channel {
                    Image(systemName: channel == "web" ? "globe" : "phone.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(channel == "web" ? "booked online" : "booked by phone")
                }
                Spacer()
                StatusBadge(status: target.status)
            }
            if let booked = target.result?.structuredData, booked.appointmentBooked {
                Text("Booked: \(booked.appointmentDateTime)")
                    .font(.caption).foregroundStyle(.green)
                if !booked.confirmation.isEmpty {
                    Text("Confirmation: \(booked.confirmation)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if target.status == "transferred" {
                Label("We connected the office to you to finish booking.", systemImage: "phone.connection")
                    .font(.caption).foregroundStyle(.green)
            }
            if let summary = target.result?.summary {
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(label).font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch status {
        case "calling": return "Calling…"
        case "awaiting_choice": return "Options ready"
        case "awaiting_info": return "Info needed"
        case "awaiting_verification": return "Code needed"
        case "booked": return "Booked"
        case "transferred": return "Connected"
        case "requested": return "Requested"
        case "voicemail": return "Voicemail"
        case "no_answer": return "No answer"
        case "failed": return "Failed"
        default: return "Pending"
        }
    }

    private var color: Color {
        switch status {
        case "booked": return .green
        case "transferred": return .green
        case "calling": return .blue
        case "awaiting_choice": return .purple
        case "awaiting_info": return .orange
        case "awaiting_verification": return .indigo
        case "requested": return .teal
        case "failed", "no_answer": return .red
        case "voicemail": return .orange
        default: return .gray
        }
    }
}
