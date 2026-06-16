import Foundation

@MainActor
@Observable
final class HealthRecordsModel {
    var records = HealthRecords()
    var isLoading = false
    var errorMessage: String?

    private let api = APIClient()

    func load() async {
        isLoading = records.isEmpty
        defer { isLoading = false }
        do {
            records = try await api.getHealthRecords()
            errorMessage = nil
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
