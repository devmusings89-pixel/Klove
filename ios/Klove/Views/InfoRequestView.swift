import SwiftUI

/// Shown when a session is `awaiting_info`: an office required details we didn't have.
/// The patient types the answers per office; submitting re-calls that office with them.
struct InfoRequestView: View {
    let sessionId: String

    @Environment(Router.self) private var router
    @State private var requests: [InfoRequest] = []
    @State private var answers: [String: String] = [:]   // targetId -> typed answer
    @State private var submitting = false
    @State private var errorMessage: String?
    private let api = APIClient()

    var body: some View {
        List {
            Section {
                Text("To finish booking, these offices asked for details we didn't have. Provide them and we'll call back to complete the booking.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach(requests) { req in
                Section(req.officeName) {
                    ForEach(req.missingInfo, id: \.self) { item in
                        Text("• \(item)").font(.subheadline)
                    }
                    TextField("Type the requested details", text: binding(for: req.targetId), axis: .vertical)
                        .lineLimit(2...4)
                    Button {
                        Task { await submit(req) }
                    } label: {
                        HStack {
                            Spacer()
                            if submitting { ProgressView() } else { Text("Send & call back").bold() }
                            Spacer()
                        }
                    }
                    .disabled(submitting || (answers[req.targetId] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("More info needed")
        .task { await load() }
    }

    private func binding(for targetId: String) -> Binding<String> {
        Binding(get: { answers[targetId] ?? "" }, set: { answers[targetId] = $0 })
    }

    private func load() async {
        do {
            requests = try await api.getSession(id: sessionId).infoRequests
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func submit(_ req: InfoRequest) async {
        let text = (answers[req.targetId] ?? "").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        submitting = true
        defer { submitting = false }
        do {
            try await api.provideInfo(sessionId: sessionId, targetId: req.targetId, answers: text)
            router.path.removeLast() // back to progress to watch the re-call
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
