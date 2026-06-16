import Foundation

@MainActor
@Observable
final class AlertsModel {
    var alerts: [HealthAlert] = []
    var isLoading = false
    var errorMessage: String?

    private let api = APIClient()

    var active: [HealthAlert] { alerts.filter { !$0.isAcknowledged } }

    func load() async {
        isLoading = alerts.isEmpty
        defer { isLoading = false }
        do {
            alerts = try await api.getAlerts()
            errorMessage = nil
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    func acknowledge(_ alert: HealthAlert) async {
        do {
            try await api.ackAlert(id: alert.id)
            await load()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }
}
