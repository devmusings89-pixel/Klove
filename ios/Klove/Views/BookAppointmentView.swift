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
    @State private var reason: String
    @State private var provider = ""
    @State private var phone = ""
    @State private var website = ""
    @State private var preferredTimes = ""
    @State private var preparing = false
    @State private var plan: BookingPlan?
    @State private var showProviderPicker = false
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

    init(memberId: String, memberName: String, allowMemberChange: Bool = false, initialReason: String = "", onBooked: @escaping () -> Void = {}) {
        _memberId = State(initialValue: memberId)
        _memberName = State(initialValue: memberName)
        _reason = State(initialValue: initialReason)
        self.allowMemberChange = allowMemberChange
        self.onBooked = onBooked
    }

    var body: some View {
        NavigationStack {
            Group {
                if let o = outcome { confirmation(o) }
                else if let p = plan { recap(p) }
                else { form }
            }
            .navigationTitle("Book a visit")
            .navigationBarTitleDisplayMode(.inline)
            .alert("Couldn't book", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMessage ?? "") }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(outcome == nil ? "Cancel" : "Done") { dismiss() } }
                // Form → Review (prepare, no calls); the recap screen owns the final Confirm button.
                if outcome == nil && plan == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Review") { Task { await prepare() } }
                            .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty || preparing)
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
            .sheet(isPresented: $showProviderPicker) {
                ProviderPickerView(memberId: memberId) { picked in
                    provider = picked.name
                    phone = picked.phone ?? ""
                    website = picked.website ?? ""
                    plan = nil // back to the form with the chosen provider filled in
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

    // The confirm step: a recap of exactly what Klove will do before any calls are placed. When no
    // provider could be resolved (status needs_provider), the operator picks one from the directory
    // candidates or searches/adds a new one.
    @ViewBuilder
    private func recap(_ p: BookingPlan) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(p.isReady ? "Confirm the details" : "Pick a provider")
                    .font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(p.recap).font(.subheadline).foregroundStyle(Theme.inkSecondary)

                recapDetails(p)

                if !p.missing.isEmpty {
                    Text("Klove will proceed without \(p.missing.joined(separator: ", ")). Add it for a smoother call.")
                        .font(.caption).foregroundStyle(Theme.needsYou)
                }

                if p.isReady {
                    Button { Task { await book(p) } } label: {
                        Label("Confirm & book", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(KlovePrimaryButtonStyle()).disabled(booking)
                } else {
                    recapCandidates(p)
                }

                Button("Edit details") { plan = nil }.font(.caption).tint(Theme.accent)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    @ViewBuilder
    private func recapDetails(_ p: BookingPlan) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let prov = p.provider {
                Label(prov.name, systemImage: "stethoscope").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                if let ph = prov.phone, !ph.isEmpty { Label(ph, systemImage: "phone").font(.caption).foregroundStyle(Theme.inkSecondary) }
                if let web = prov.website, !web.isEmpty { Label(web, systemImage: "globe").font(.caption).foregroundStyle(Theme.inkSecondary) }
            }
            Label("For \(p.patientName)", systemImage: "person.fill").font(.caption).foregroundStyle(Theme.inkSecondary)
            if !p.insuranceLabel.isEmpty { Label("Insurance: \(p.insuranceLabel)", systemImage: "creditcard").font(.caption).foregroundStyle(Theme.inkSecondary) }
            if !p.preferredTimes.isEmpty { Label(p.preferredTimes, systemImage: "clock").font(.caption).foregroundStyle(Theme.inkSecondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    @ViewBuilder
    private func recapCandidates(_ p: BookingPlan) -> some View {
        Text("Klove doesn't have a way to reach an office yet. Pick a known provider or add one:")
            .font(.subheadline).foregroundStyle(Theme.ink)
        ForEach(p.candidates) { c in
            Button { Task { await book(p, chosen: c) } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name).foregroundStyle(Theme.ink)
                        if let ph = c.phone, !ph.isEmpty { Text(ph).font(.caption2).foregroundStyle(Theme.inkSecondary) }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
                }
                .padding(.vertical, 10).padding(.horizontal, 12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            .disabled(booking)
        }
        Button { showProviderPicker = true } label: {
            Label("Search or add a provider", systemImage: "magnifyingglass")
        }
        .tint(Theme.accent)
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

    /// Step 1: resolve the provider + details and show a recap to confirm. No calls are placed.
    private func prepare() async {
        preparing = true
        defer { preparing = false }
        do {
            plan = try await api.prepareBooking(
                memberId,
                reason: reason.trimmingCharacters(in: .whitespaces),
                provider: provider.isEmpty ? nil : provider,
                preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
                phone: phone.isEmpty ? nil : phone,
                website: website.isEmpty ? nil : website,
                insurancePlanId: selectedCardId
            )
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Step 2: place the confirmed booking. `chosen` overrides the provider when the operator picked
    /// one from the needs-provider candidates; otherwise the prepared plan's provider/form values are used.
    private func book(_ p: BookingPlan, chosen: PlanProvider? = nil) async {
        booking = true
        defer { booking = false }
        let prov = chosen ?? p.provider
        do {
            outcome = try await api.bookForMember(
                memberId,
                reason: reason.trimmingCharacters(in: .whitespaces),
                provider: prov?.name ?? (provider.isEmpty ? nil : provider),
                specialty: prov?.specialty,
                preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
                phone: prov?.phone ?? (phone.isEmpty ? nil : phone),
                website: prov?.website ?? (website.isEmpty ? nil : website),
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
