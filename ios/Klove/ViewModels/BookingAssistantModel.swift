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
    // Insurance is required to book — offices ask for it, and the agent must be able to provide it.
    var insuranceCarrier = ""
    var insuranceMemberId = ""
    var insurancePlan = ""
    var isBooking = false

    private let api = APIClient()

    /// Quick-start prompts shown on the empty state.
    let chips = ["Book a dentist visit", "Find a dermatologist near me", "See a primary care doctor", "Book an eye exam"]

    /// Past providers the user can rebook in one tap (from extracted appointments).
    var recentProviders: [Appointment] = []

    // Insurance group, prefilled from the profile; member ID + carrier are surfaced as required fields.
    private var insuranceGroup = ""

    /// Prefill identity + insurance from the saved profile so the user re-enters nothing.
    func loadProfile() async {
        guard let p = try? await api.getProfile() else { return }
        if patientName.isEmpty { patientName = p.fullName }
        if patientDob.isEmpty, let d = p.dob { patientDob = d }
        if patientPhone.isEmpty, let ph = p.phone { patientPhone = ph }
        if let e = p.email, !e.isEmpty, email.isEmpty { email = e }
        if let i = p.insurance {
            if insuranceCarrier.isEmpty, let c = i.carrier { insuranceCarrier = c }
            if insurancePlan.isEmpty, let pl = i.planName { insurancePlan = pl }
            if insuranceMemberId.isEmpty, let m = i.memberId { insuranceMemberId = m }
            if let g = i.groupId { insuranceGroup = g }
        }
    }

    /// Load distinct recent providers for "Book again" suggestions. Dedupe on a CANONICAL provider
    /// key (see `providerKey`) so "Dr. Lin" and "Dr Lin" collapse to one entry instead of fragmenting.
    func loadRecentProviders() async {
        guard recentProviders.isEmpty else { return }
        guard let appts = try? await api.getAppointments() else { return }
        var seen = Set<String>()
        recentProviders = appts
            .filter { ($0.provider?.isEmpty == false) }
            .filter { seen.insert(providerKey($0.provider!)).inserted }
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
        !resolvedOfficeName.trimmingCharacters(in: .whitespaces).isEmpty &&
        // Insurance is required — the office needs it and the agent must be able to provide it.
        !insuranceCarrier.trimmingCharacters(in: .whitespaces).isEmpty &&
        !insuranceMemberId.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Build the CreateSessionRequest from the draft + confirmed details and start the booking.
    /// Booking is free — there's no payment step; the session begins calling immediately.
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
        patient.name = patientName.trimmingCharacters(in: .whitespaces)
        patient.dob = patientDob
        patient.reason = draft.reason ?? draft.specialty ?? "appointment"
        patient.preferredTimes = draft.preferredTimes ?? ""
        patient.acceptableWindow = draft.acceptableWindow ?? draft.preferredTimes ?? ""
        patient.patientPhone = patientPhone
        patient.patientEmail = email
        patient.insurance = [insuranceCarrier, insurancePlan].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
        var insBits = ["Insurance member ID: \(insuranceMemberId.trimmingCharacters(in: .whitespaces))"]
        if !insuranceGroup.isEmpty { insBits.append("Group: \(insuranceGroup)") }
        patient.additionalInfo = insBits.joined(separator: ", ")

        // Persist insurance to the profile so it's prefilled next time.
        var ins = InsuranceInfo()
        ins.carrier = insuranceCarrier.trimmingCharacters(in: .whitespaces)
        ins.planName = insurancePlan.trimmingCharacters(in: .whitespaces)
        ins.memberId = insuranceMemberId.trimmingCharacters(in: .whitespaces)
        if !insuranceGroup.isEmpty { ins.groupId = insuranceGroup }
        _ = try? await api.putInsurance(ins)

        let request = CreateSessionRequest(email: email, patientInfo: patient, targets: [target], stopWhenBooked: true)
        do {
            let response = try await api.createSession(request)
            return response.sessionId
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }
}

/// Canonical key for a provider/office name so trivial spelling/punctuation differences collapse to
/// one identity ("Dr. Lin" == "Dr Lin" == "DR. LIN"). Lowercased, common honorific prefixes dropped,
/// punctuation stripped, and whitespace squashed. Used to dedupe the "Book again" provider list.
func providerKey(_ raw: String) -> String {
    var s = raw.lowercased()
    // Strip punctuation (periods, commas) so "dr." == "dr".
    s = s.replacingOccurrences(of: "[.,]", with: " ", options: .regularExpression)
    // Collapse runs of whitespace.
    s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    // Drop a leading honorific so "dr lin" == "lin".
    for prefix in ["dr ", "doctor ", "mr ", "mrs ", "ms "] where s.hasPrefix(prefix) {
        s = String(s.dropFirst(prefix.count))
        break
    }
    return s
}
