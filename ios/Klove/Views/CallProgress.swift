import SwiftUI

/// A live, self-contained view of a concierge booking session: status, per-office progress, the
/// call transcript/recording, and — on failure — an honest recovery path (call the office yourself).
/// Polls until terminal and surfaces load errors (no silent failures). Reused by TaskDetailView and
/// the booking confirmation screen so the user is never left guessing what Klove actually did.
struct SessionLiveCard: View {
    let sessionId: String

    @State private var session: SessionState?
    @State private var loadError: String?
    private let api = APIClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let s = session {
                Label(statusTitle(s), systemImage: SessionStatusCopy.icon(s.status))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(s.status == "failed" ? Theme.needsYou : Theme.ink)

                // Unmistakable confirmation once an office actually booked it.
                if let booked = bookedDetails(s) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Appointment confirmed", systemImage: "checkmark.seal.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.handled)
                        if !booked.when.isEmpty {
                            Text(booked.when).font(.caption).foregroundStyle(Theme.ink)
                        }
                        if !booked.confirmation.isEmpty {
                            Text("Confirmation \(booked.confirmation)").font(.caption).foregroundStyle(Theme.inkSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.handled.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                }

                if didFail(s) {
                    Text("Klove couldn't get this booked automatically — the call details are below. You can hand it to a Klove specialist, or call the office yourself:")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                    officeFallback(s)
                }

                if !s.targets.isEmpty {
                    Divider()
                    CallProgressList(targets: s.targets)
                }
            } else if let loadError {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Couldn't load call status", systemImage: "wifi.exclamationmark")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.needsYou)
                    Text(loadError).font(.caption).foregroundStyle(Theme.inkSecondary)
                    Button("Retry") { Task { await loadOnce() } }.font(.caption.weight(.semibold)).tint(Theme.accent)
                }
            } else {
                ProgressView("Checking on Klove…").font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
        .sensoryFeedback(.success, trigger: bookedConfirmed)
        .task { await poll() }
    }

    /// True once an office has actually booked — drives the success haptic.
    private var bookedConfirmed: Bool {
        guard let s = session else { return false }
        return bookedDetails(s) != nil
    }

    /// Phone/website for any office on the session, so an anxious caregiver has an immediate fallback.
    @ViewBuilder
    private func officeFallback(_ s: SessionState) -> some View {
        ForEach(s.targets) { t in
            if let phone = t.phoneNumber, !phone.isEmpty, let url = URL(string: "tel://\(phone.filter { $0.isNumber })") {
                Link(destination: url) {
                    Label("\(t.officeName): \(phone)", systemImage: "phone.fill").font(.caption.weight(.semibold))
                }.tint(Theme.accent)
            } else if let web = t.website, !web.isEmpty, let url = URL(string: web.hasPrefix("http") ? web : "https://\(web)") {
                Link(destination: url) {
                    Label("\(t.officeName) — book online", systemImage: "globe").font(.caption.weight(.semibold))
                }.tint(Theme.accent)
            }
        }
    }

    /// The confirmed appointment details from a booked office, if any.
    private func bookedDetails(_ s: SessionState) -> (when: String, confirmation: String)? {
        guard let t = s.targets.first(where: { $0.status == "booked" }),
              let sd = t.result?.structuredData, sd.appointmentBooked else { return nil }
        return (when: sd.appointmentDateTime, confirmation: sd.confirmation)
    }

    private func didFail(_ s: SessionState) -> Bool {
        s.status == "failed" || (s.status == "completed" && !s.targets.contains { $0.status == "booked" || $0.status == "transferred" })
    }

    /// Honest status: a session with no offices to contact yet isn't "starting the calls" — say so
    /// plainly rather than implying outreach that isn't happening. (The backend self-heals genuinely
    /// stuck jobs, but this keeps the card truthful in the brief gap before targets are attached.)
    private func statusTitle(_ s: SessionState) -> String {
        if s.targets.isEmpty && !s.isTerminal { return "Klove is getting this set up…" }
        return SessionStatusCopy.title(s.status)
    }

    private func loadOnce() async {
        do { session = try await api.getSession(id: sessionId); loadError = nil }
        catch { loadError = (error as? AppError)?.errorDescription ?? error.localizedDescription }
    }

    private func poll() async {
        while !Task.isCancelled {
            await loadOnce()
            if let s = session, s.isTerminal { return }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}

/// Shared status copy so every surface (live card + progress screen) reads identically.
enum SessionStatusCopy {
    static func title(_ s: String) -> String {
        switch s {
        case "draft", "paid", "scheduling": return "Klove is starting the calls…"
        case "in_progress": return "Klove is contacting the office…"
        case "awaiting_choice": return "The office offered alternate times"
        case "awaiting_info": return "The office needs more info"
        case "awaiting_verification": return "A verification code is needed"
        case "completed": return "Booking complete"
        case "failed": return "Couldn't complete automatically"
        default: return "What Klove is doing"
        }
    }

    static func icon(_ s: String) -> String {
        switch s {
        case "completed": return "checkmark.seal.fill"
        case "failed": return "exclamationmark.triangle.fill"
        case "awaiting_choice": return "calendar.badge.clock"
        case "awaiting_info": return "exclamationmark.bubble"
        case "awaiting_verification": return "lock.shield"
        default: return "phone.arrow.up.right.fill"
        }
    }
}

/// Read-only list of each office Klove contacted.
struct CallProgressList: View {
    let targets: [CallTarget]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(targets) { OfficeRow(target: $0) }
        }
    }
}

/// One office: name + channel + status, the booked/provisional outcome, the AI's plain-language
/// summary, when/how long the call was, an expandable transcript, and the recording if available.
struct OfficeRow: View {
    let target: CallTarget

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(target.officeName).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                if let channel = target.channel {
                    Image(systemName: channel == "web" ? "globe" : "phone.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.inkSecondary)
                        .accessibilityLabel(channel == "web" ? "booked online" : "booked by phone")
                }
                Spacer()
                StatusBadge(status: isProvisional ? "provisional" : target.status)
            }

            if isProvisional {
                Label("Provisional hold — no live call was placed, so this isn't confirmed with the office yet.", systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(Theme.needsYou)
            } else if let booked = target.result?.structuredData, booked.appointmentBooked {
                Label("Booked: \(booked.appointmentDateTime)", systemImage: "checkmark.circle.fill")
                    .font(.caption).foregroundStyle(Theme.handled)
                if !booked.confirmation.isEmpty {
                    Text("Confirmation: \(booked.confirmation)").font(.caption2).foregroundStyle(Theme.inkSecondary)
                }
            }

            if target.status == "transferred" {
                Label("We connected the office to you to finish booking.", systemImage: "phone.connection")
                    .font(.caption).foregroundStyle(Theme.handled)
            }

            if target.status == "retry_wait" {
                VStack(alignment: .leading, spacing: 2) {
                    Label(target.retryLabel, systemImage: "arrow.clockwise")
                        .font(.caption).foregroundStyle(Theme.needsYou)
                    if let hours = target.callbackHoursDisplay {
                        Text(hours).font(.caption2).foregroundStyle(Theme.inkSecondary)
                    }
                }
            }

            if let summary = target.result?.summary, !summary.isEmpty {
                Text(summary).font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            if let wd = target.result?.whenDuration {
                Text(wd).font(.caption2).foregroundStyle(Theme.inkSecondary)
            }

            if hasDetails {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(target.results.enumerated()), id: \.offset) { _, r in
                            if let t = r.transcript, !t.isEmpty {
                                VStack(alignment: .leading, spacing: 2) {
                                    if let wd = r.whenDuration {
                                        Text(wd).font(.caption2.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
                                    }
                                    Text(t).font(.caption).foregroundStyle(Theme.ink).textSelection(.enabled)
                                }
                            }
                            if let rec = r.recordingUrl, let url = URL(string: rec) {
                                Link(destination: url) {
                                    Label("Play call recording", systemImage: "play.circle").font(.caption.weight(.semibold))
                                }.tint(Theme.accent)
                            }
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    Label("Call details", systemImage: "text.bubble")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
                .tint(Theme.accent)
            }
        }
        .padding(.vertical, 2)
    }

    private var isProvisional: Bool {
        target.result?.structuredData?.outcome == "simulated" || target.status == "requested"
    }

    /// Show the disclosure when there's a real transcript or a recording to surface.
    private var hasDetails: Bool {
        target.results.contains { ($0.transcript?.isEmpty == false) || ($0.recordingUrl?.isEmpty == false) }
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(label).font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch status {
        case "calling": return "Dialing…"
        case "ringing": return "Ringing…"
        case "in_call": return "On the call…"
        case "awaiting_choice": return "Options ready"
        case "awaiting_info": return "Info needed"
        case "awaiting_verification": return "Code needed"
        case "booked": return "Booked"
        case "transferred": return "Connected"
        case "requested": return "Requested"
        case "provisional": return "Provisional"
        case "voicemail": return "Voicemail"
        case "no_answer": return "No answer"
        case "retry_wait": return "Retrying"
        case "failed": return "Failed"
        default: return "Pending"
        }
    }

    private var color: Color {
        switch status {
        case "booked", "transferred": return Theme.handled
        case "calling", "ringing": return .blue
        case "in_call": return .green
        case "awaiting_choice": return .purple
        case "awaiting_info", "provisional", "voicemail", "retry_wait": return Theme.needsYou
        case "awaiting_verification": return .indigo
        case "requested": return .teal
        case "failed", "no_answer": return .red
        default: return Theme.waiting
        }
    }
}
