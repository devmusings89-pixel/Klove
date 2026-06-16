import Foundation

@MainActor
@Observable
final class RequestFormModel {
    var email: String = ""
    var patient = PatientInfo()
    var targets: [CallTargetInput] = [CallTargetInput()]
    var stopWhenBooked = true

    var isSubmitting = false
    var errorMessage: String?

    let maxTargets = 3
    private let api = APIClient()

    var canAddTarget: Bool { targets.count < maxTargets }

    func addTarget() {
        guard canAddTarget else { return }
        targets.append(CallTargetInput())
    }

    func removeTarget(at offsets: IndexSet) {
        targets.remove(atOffsets: offsets)
        if targets.isEmpty { targets.append(CallTargetInput()) }
    }

    /// Validate and create the session. Returns the create response on success.
    func submit() async -> CreateSessionResponse? {
        errorMessage = nil
        do {
            try validate()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }

        isSubmitting = true
        defer { isSubmitting = false }

        let request = CreateSessionRequest(
            email: email,
            patientInfo: patient,
            targets: targets.filter { !$0.officeName.trimmingCharacters(in: .whitespaces).isEmpty },
            stopWhenBooked: stopWhenBooked
        )
        do {
            return try await api.createSession(request)
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    private func validate() throws {
        guard email.contains("@") else { throw AppError.validationError(message: "Enter a valid email.") }
        guard !patient.name.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw AppError.validationError(message: "Patient name is required.")
        }
        guard !patient.reason.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw AppError.validationError(message: "Reason for visit is required.")
        }
        let named = targets.filter { !$0.officeName.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !named.isEmpty else { throw AppError.validationError(message: "Add at least one office.") }
    }
}
