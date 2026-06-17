import SwiftUI

/// Ask Klove to book an appointment on a member's behalf. Collects the essentials, then the
/// concierge confirms it — the booked visit appears in Today, the timeline, and Actions.
/// When `allowMemberChange` is true, the operator can pick which family member it's for.
struct BookAppointmentView: View {
    var allowMemberChange = false
    var onBooked: () -> Void = {}

    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var memberId: String
    @State private var memberName: String
    @State private var reason = ""
    @State private var provider = ""
    @State private var phone = ""
    @State private var website = ""
    @State private var preferredTimes = ""
    @State private var booking = false
    @State private var outcome: BookingOutcome?
    @State private var errorMessage: String?
    @State private var cards: [InsuranceCard] = []
    @State private var selectedCardId: String?
    @State private var officeMatch: OfficeMatch?
    @State private var lookingUp = false
    @State private var lookupTask: Task<Void, Never>?
    @State private var showAddInsurance = false
    private let api = APIClient()

    init(memberId: String, memberName: String, allowMemberChange: Bool = false, onBooked: @escaping () -> Void = {}) {
        _memberId = State(initialValue: memberId)
        _memberName = State(initialValue: memberName)
        self.allowMemberChange = allowMemberChange
        self.onBooked = onBooked
    }

    var body: some View {
        NavigationStack {
            Group {
                if let o = outcome { confirmation(o) } else { form }
            }
            .navigationTitle("Book a visit")
            .navigationBarTitleDisplayMode(.inline)
            .alert("Couldn't book", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMessage ?? "") }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(outcome == nil ? "Cancel" : "Done") { dismiss() } }
                if outcome == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Book") { Task { await book() } }
                            .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty || booking)
                    }
                }
            }
            .tint(Theme.accent)
            .task { await loadCards() }
            .sheet(isPresented: $showAddInsurance) {
                AddInsuranceView(memberId: memberId, memberName: memberName, isFirstCard: cards.isEmpty) {
                    Task { await loadCards() }
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                if allowMemberChange && !store.actionableMembers.isEmpty {
                    Picker("Patient", selection: $memberId) {
                        ForEach(store.actionableMembers) { m in Text(m.displayLabel).tag(m.userId) }
                    }
                    .onChange(of: memberId) { _, new in
                        memberName = store.actionableMembers.first { $0.userId == new }?.name ?? memberName
                        selectedCardId = nil
                        Task { await loadCards() }
                    }
                } else {
                    LabeledContent("Patient", value: memberName)
                }
            } header: {
                Text("Booking for")
            } footer: {
                Text("This visit is booked in \(memberName)'s name.")
            }

            Section {
                if cards.isEmpty {
                    Text("No insurance on file for \(memberName). Offices ask for it to book.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button {
                        showAddInsurance = true
                    } label: {
                        Label("Add an insurance card", systemImage: "creditcard.fill")
                    }
                    .tint(Theme.accent)
                } else {
                    Picker("Insurance card", selection: $selectedCardId) {
                        ForEach(cards) { c in
                            Text(c.label + (c.isPrimary ? " (primary)" : (c.isSecondary ? " (backup)" : ""))).tag(Optional(c.id))
                        }
                    }
                }
            } header: {
                Text("Insurance")
            } footer: {
                Text("Klove gives the office \(memberName)'s coverage — pick the right card (e.g. Medicare for a parent, the family plan for a child).")
            }

            Section("What's the visit for?") {
                TextField("e.g. Annual physical, dermatology", text: $reason)
            }
            Section {
                TextField("e.g. Dr. Lin, City Endocrinology", text: $provider)
                    .textInputAutocapitalization(.words)
                    .onChange(of: provider) { _, new in scheduleLookup(new) }
                if lookingUp {
                    Label("Looking up the office…", systemImage: "magnifyingglass")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                } else if let m = officeMatch {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Found \(m.displayName)", systemImage: "checkmark.circle.fill")
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.handled)
                        if let phone = m.phone { Text(phone).font(.caption2).foregroundStyle(Theme.inkSecondary) }
                        if let address = m.address { Text(address).font(.caption2).foregroundStyle(Theme.inkSecondary) }
                    }
                } else if provider.trimmingCharacters(in: .whitespaces).count >= 3 {
                    Label("Couldn't find that office — add a phone or website below so Klove can reach it.",
                          systemImage: "questionmark.circle")
                        .font(.caption).foregroundStyle(Theme.needsYou)
                }
            } header: {
                Text("Provider or office (optional)")
            }
            Section {
                TextField("Office phone", text: $phone).keyboardType(.phonePad)
                TextField("Booking website", text: $website).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            } header: {
                Text("How should Klove reach the office?")
            } footer: {
                Text("Optional — Klove can find the office from its name. Add a phone or website to be exact.")
            }
            Section {
                TextField("e.g. weekday mornings, after 3pm, ASAP", text: $preferredTimes, axis: .vertical)
                    .lineLimit(1...3)
            } header: {
                Text("Preferred times")
            } footer: {
                Text("In your own words. Klove will reach the office on \(memberName)'s behalf and find a time that fits.")
            }
        }
    }

    @ViewBuilder
    private func confirmation(_ o: BookingOutcome) -> some View {
        ScrollView {
            VStack(spacing: 14) {
                Image(systemName: confIcon(o)).font(.system(size: 52)).foregroundStyle(confTint(o))
                Text(confTitle(o)).font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                Text("\(o.title)\(o.provider.map { " with \($0)" } ?? "")")
                    .font(.subheadline).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
                // Confirm WHO it's for and WHICH coverage Klove will give the office.
                Label("For \(o.patientName ?? memberName)", systemImage: "person.fill")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
                if let ins = o.insurance, !ins.isEmpty {
                    Label("Insurance: \(ins)", systemImage: "creditcard")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                }

                if o.isProvisional {
                    Text("Klove placed a provisional hold\(o.startsAt != nil ? " for \(o.whenDisplay)" : ""). It isn't confirmed with the office yet — Klove will confirm and update you in Today.")
                        .font(.caption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, 4)
                } else if o.isConfirmed {
                    Text("\(o.whenDisplay)\(o.confirmation.map { " · Confirmation \($0)" } ?? "")")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                    Text("You'll find it in Today and on \(memberName)'s timeline.")
                        .font(.caption).foregroundStyle(Theme.inkSecondary).padding(.top, 4)
                } else {
                    Text("Watch Klove reach the office below — you'll also find this in Today & Actions.")
                        .font(.caption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, 4)
                    if let sid = o.sessionId {
                        SessionLiveCard(sessionId: sid).padding(.top, 8)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private func confTitle(_ o: BookingOutcome) -> String {
        if o.isProvisional { return "Provisional hold placed" }
        return o.isConfirmed ? "Done — it's booked" : "Klove is on it"
    }
    private func confIcon(_ o: BookingOutcome) -> String {
        if o.isProvisional { return "calendar.badge.clock" }
        return o.isConfirmed ? "checkmark.seal.fill" : "phone.arrow.up.right.fill"
    }
    private func confTint(_ o: BookingOutcome) -> Color {
        if o.isProvisional { return Theme.needsYou }
        return o.isConfirmed ? Theme.handled : Theme.accent
    }

    private func book() async {
        booking = true
        defer { booking = false }
        do {
            outcome = try await api.bookForMember(
                memberId,
                reason: reason.trimmingCharacters(in: .whitespaces),
                provider: provider.isEmpty ? nil : provider,
                preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
                phone: phone.isEmpty ? nil : phone,
                website: website.isEmpty ? nil : website,
                insurancePlanId: selectedCardId
            )
            store.bumpData()   // refresh Today/Actions so the booking shows up
            onBooked()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Debounce office lookups as the user types so we don't fire a request per keystroke.
    private func scheduleLookup(_ raw: String) {
        lookupTask?.cancel()
        let query = raw.trimmingCharacters(in: .whitespaces)
        officeMatch = nil
        guard query.count >= 3 else { lookingUp = false; return }
        lookingUp = true
        lookupTask = Task {
            try? await Task.sleep(for: .milliseconds(450))
            if Task.isCancelled { return }
            let match = try? await api.lookupOffice(query)
            if Task.isCancelled { return }
            officeMatch = match
            lookingUp = false
        }
    }

    /// Load the patient's insurance wallet and default to their primary card.
    private func loadCards() async {
        cards = (try? await api.memberInsurance(memberId)) ?? []
        if selectedCardId == nil || !cards.contains(where: { $0.id == selectedCardId }) {
            selectedCardId = cards.first(where: { $0.isPrimary })?.id ?? cards.first?.id
        }
    }
}
