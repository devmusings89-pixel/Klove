import Foundation

@MainActor
@Observable
final class UploadModel {
    enum Phase: Equatable {
        case idle
        case uploading
        case processing
        case done(DocumentStatus)
        case failed(String)
    }

    var phase: Phase = .idle

    private let api = APIClient()

    var isBusy: Bool { phase == .uploading || phase == .processing }

    /// Upload bytes and poll until the backend finishes extraction (or times out).
    func upload(data: Data, mimeType: String, filename: String) async {
        phase = .uploading
        do {
            let response = try await api.uploadDocument(data: data, mimeType: mimeType, filename: filename)
            phase = .processing
            await pollStatus(documentId: response.documentId)
        } catch {
            phase = .failed((error as? AppError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func reset() { phase = .idle }

    private func pollStatus(documentId: String) async {
        // Worker runs on a 15s tick; poll for ~45s before giving up gracefully.
        for _ in 0..<30 {
            do {
                let status = try await api.getDocumentStatus(id: documentId)
                if status.isTerminal { phase = .done(status); return }
            } catch {
                phase = .failed((error as? AppError)?.errorDescription ?? error.localizedDescription)
                return
            }
            try? await Task.sleep(for: .seconds(1.5))
        }
        // Still processing — let the user move on; records refresh will pick it up.
        if let status = try? await api.getDocumentStatus(id: documentId) {
            phase = .done(status)
        } else {
            phase = .failed("Still processing — check back shortly.")
        }
    }
}
