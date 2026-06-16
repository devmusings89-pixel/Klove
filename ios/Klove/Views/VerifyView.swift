import SwiftUI

/// Shown when a session is `awaiting_verification`: an online scheduler texted/emailed the patient a
/// one-time code. The patient enters it per office; submitting resumes the held browser session and
/// confirms the booking.
struct VerifyView: View {
    let sessionId: String

    @Environment(Router.self) private var router
    @State private var requests: [VerificationRequest] = []
    @State private var codes: [String: String] = [:]   // targetId -> entered code
    @State private var submitting = false
    @State private var errorMessage: String?
    private let api = APIClient()

    var body: some View {
        List {
            Section {
                Text("The office sent you a one-time code to confirm your booking. Check your email or text messages, then enter the code below.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach(requests) { req in
                Section(req.officeName) {
                    if let slot = req.slot {
                        Text("Booking: \(slot)").font(.subheadline)
                    }
                    Text("Code sent to \(req.contact ?? "your email or phone").")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Enter code", text: binding(for: req.targetId))
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title3.monospacedDigit())
                    Button {
                        Task { await submit(req) }
                    } label: {
                        HStack {
                            Spacer()
                            if submitting { ProgressView() } else { Text("Confirm booking").bold() }
                            Spacer()
                        }
                    }
                    .disabled(submitting || (codes[req.targetId] ?? "").trimmingCharacters(in: .whitespaces).count < 3)
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Enter your code")
        .task { await load() }
    }

    private func binding(for targetId: String) -> Binding<String> {
        Binding(get: { codes[targetId] ?? "" }, set: { codes[targetId] = $0 })
    }

    private func load() async {
        do {
            requests = try await api.getSession(id: sessionId).verificationRequests
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func submit(_ req: VerificationRequest) async {
        let code = (codes[req.targetId] ?? "").trimmingCharacters(in: .whitespaces)
        guard code.count >= 3 else { return }
        submitting = true
        defer { submitting = false }
        do {
            try await api.verify(sessionId: sessionId, targetId: req.targetId, code: code)
            router.path.removeLast() // back to progress to watch the confirmation
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
