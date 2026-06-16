import Foundation

/// One line in the assistant conversation.
struct ChatMessage: Identifiable, Hashable {
    enum Role { case assistant, user }
    let id = UUID()
    let role: Role
    let text: String
}

/// Drives the conversational booking front-door: free-text/voice → BookingDraft (slot-filling) →
/// editable confirmation → reuse the existing createSession flow.
@MainActor
@Observable
final class BookingAssistantModel {
    var messages: [ChatMessage] = []
    var draft: BookingDraft?
    var input: String = ""
    var isThinking = false
    var errorMessage: String?

    // Confirmation-card state (collected once profile auto-fill lands in WS3).
    var selectedCandidate: ProviderCandidate?
    var patientName = ""
    var patientDob = ""
    var patientPhone = ""
    var email = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var isBooking = false

    private let api = APIClient()

    /// Quick-start prompts shown on the empty state.
    let chips = ["Book a dentist visit", "Find a dermatologist near me", "See a primary care doctor", "Book an eye exam"]

    /// Past providers the user can rebook in one tap (from extracted appointments).
    var recentProviders: [Appointment] = []

    // Insurance pulled from the saved profile (auto-attached to the booking).
    private var insuranceSummary = ""
    private var insuranceDetail = ""

    /// Prefill identity + insurance from the saved profile so the user re-enters nothing.
    func loadProfile() async {
        guard let p = try? await api.getProfile() else { return }
        if patientName.isEmpty { patientName = p.fullName }
        if patientDob.isEmpty, let d = p.dob { patientDob = d }
        if patientPhone.isEmpty, let ph = p.phone { patientPhone = ph }
        if let e = p.email, !e.isEmpty, email.isEmpty { email = e }
        if let i = p.insurance {
            insuranceSummary = [i.carrier, i.planName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            var parts: [String] = []
            if let m = i.memberId, !m.isEmpty { parts.append("Member ID: \(m)") }
            if let g = i.groupId, !g.isEmpty { parts.append("Group: \(g)") }
            insuranceDetail = parts.joined(separator: ", ")
        }
    }

    /// Load distinct recent providers for "Book again" suggestions.
    func loadRecentProviders() async {
        guard recentProviders.isEmpty else { return }
        guard let appts = try? await api.getAppointments() else { return }
        var seen = Set<String>()
        recentProviders = appts
            .filter { ($0.provider?.isEmpty == false) }
            .filter { seen.insert($0.provider!.lowercased()).inserted }
            .prefix(4)
            .map { $0 }
    }

    func rebook(_ appt: Appointment) {
        let what = appt.title.isEmpty ? "a visit" : appt.title.lowercased()
        input = "Book \(what) with \(appt.provider ?? "my doctor") again"
        Task { await send() }
    }

    var showConfirmation: Bool { draft?.readyToBook == true }

    /// The office we'll actually book: a chosen past provider, else a hint/specialty+location search.
    var resolvedOfficeName: String {
        if let c = selectedCandidate { return c.officeName }
        if let hint = draft?.providerHint, !hint.isEmpty { return hint }
        let specialty = draft?.specialty ?? "doctor"
        if let loc = draft?.location, !loc.isEmpty { return "\(specialty) in \(loc)" }
        return specialty
    }

    func sendChip(_ text: String) {
        input = text
        Task { await send() }
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isThinking else { return }
        input = ""
        messages.append(ChatMessage(role: .user, text: text))
        isThinking = true
        errorMessage = nil
        defer { isThinking = false }
        do {
            let result = try await api.parseIntake(text: text, draft: draft)
            draft = result
            // Default-select the top past-provider candidate, if any.
            if selectedCandidate == nil { selectedCandidate = result.providerCandidates.first }
            if let name = result.patientName, patientName.isEmpty { patientName = name }
            var reply = result.assistantMessage
            if let q = result.nextQuestion, !result.readyToBook { reply += "\n\n\(q)" }
            messages.append(ChatMessage(role: .assistant, text: reply))
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    var canBook: Bool {
        !patientName.trimmingCharacters(in: .whitespaces).isEmpty &&
        !patientDob.trimmingCharacters(in: .whitespaces).isEmpty &&
        email.contains("@") &&
        !resolvedOfficeName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Build the CreateSessionRequest from the draft + confirmed details, create + pay.
    func book() async -> String? {
        guard let draft, canBook else { return nil }
        isBooking = true
        errorMessage = nil
        defer { isBooking = false }

        let target = CallTargetInput(
            officeName: resolvedOfficeName,
            phoneNumber: selectedCandidate?.phoneNumber ?? "",
            website: selectedCandidate?.website ?? "",
            email: ""
        )
        var patient = PatientInfo()
        patient.name = patientName
        patient.dob = patientDob
        patient.reason = draft.reason ?? draft.specialty ?? "appointment"
        patient.preferredTimes = draft.preferredTimes ?? ""
        patient.acceptableWindow = draft.acceptableWindow ?? draft.preferredTimes ?? ""
        patient.patientPhone = patientPhone
        patient.patientEmail = email
        patient.insurance = insuranceSummary
        patient.additionalInfo = insuranceDetail

        let request = CreateSessionRequest(email: email, patientInfo: patient, targets: [target], stopWhenBooked: true)
        do {
            let response = try await api.createSession(request)
            switch await PaymentService.pay(for: response) {
            case .completed: return response.sessionId
            case .canceled: errorMessage = "Payment canceled."; return nil
            case .failed(let m): errorMessage = m; return nil
            }
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }
}
