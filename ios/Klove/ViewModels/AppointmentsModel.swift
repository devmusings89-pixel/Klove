import Foundation

/// A Klove booking that still needs the patient to answer something before it can finish.
struct PendingAction: Identifiable, Hashable {
    enum Kind { case choice, info, verification }
    let id: String // sessionId
    let title: String
    let detail: String
    let kind: Kind
}

/// A confirmed Klove booking (booked target) shown alongside extracted appointments.
struct KloveBooking: Identifiable, Hashable {
    let id: String
    let reason: String
    let office: String
    let whenText: String?
    let verified: Bool   // true = office-confirmed (target "booked"); false = provisional hold
}

@MainActor
@Observable
final class AppointmentsModel {
    var appointments: [Appointment] = []
    var sessions: [SessionState] = []
    var isLoading = false
    var errorMessage: String?

    private let api = APIClient()

    var upcoming: [Appointment] { appointments.filter(\.isUpcoming) }
    var past: [Appointment] { appointments.filter { !$0.isUpcoming } }

    func load() async {
        isLoading = appointments.isEmpty && sessions.isEmpty
        defer { isLoading = false }
        do {
            async let appts = api.getAppointments()
            async let sess = api.getSessions()
            appointments = try await appts
            sessions = try await sess
            errorMessage = nil
            await AppointmentReminders.sync(upcoming)
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Bookings waiting on the patient — the "pending questions" to finish booking.
    var pendingActions: [PendingAction] {
        sessions.compactMap { s in
            let what = label(s)
            if s.needsChoice {
                return PendingAction(id: s.id, title: what, detail: "\(s.aggregatedOptions.count) times to choose from", kind: .choice)
            }
            if s.needsInfo {
                let n = s.infoRequests.reduce(0) { $0 + $1.missingInfo.count }
                return PendingAction(id: s.id, title: what, detail: "\(n) detail\(n == 1 ? "" : "s") the office needs", kind: .info)
            }
            if s.needsVerification {
                let contact = s.verificationRequests.first?.contact ?? "your email or phone"
                return PendingAction(id: s.id, title: what, detail: "Enter the code sent to \(contact)", kind: .verification)
            }
            return nil
        }
    }

    /// Sessions actively working (calls / online booking in flight).
    var inProgress: [SessionState] {
        sessions.filter { ["paid", "scheduling", "in_progress"].contains($0.status) }
    }

    /// Confirmed Klove bookings (booked targets), to show among upcoming appointments.
    var kloveBookings: [KloveBooking] {
        sessions.flatMap { s in
            s.targets.filter { $0.status == "booked" }.map { t in
                let when = t.result?.structuredData?.appointmentDateTime
                return KloveBooking(
                    id: t.id,
                    reason: s.patientInfo?.reason ?? "Appointment",
                    office: t.officeName,
                    whenText: (when?.isEmpty == false) ? when : nil,
                    verified: t.status == "booked"
                )
            }
        }
    }

    private func label(_ s: SessionState) -> String {
        let office = s.targets.first?.officeName
        let reason = s.patientInfo?.reason
        return [reason, office].compactMap { ($0?.isEmpty == false) ? $0 : nil }.first ?? "Your booking"
    }
}
