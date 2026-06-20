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
    @State private var preferredTimes = ""
    @State private var preparing = false
    @State private var plan: BookingPlan?
    @State private var showProviderPicker = false
    @State private var booking = false
    @State private var outcome: BookingOutcome?
    @State private var errorMessage: String?
    @State private var cards: [InsuranceCard] = []
    @State private var selectedCardId: String?
    // The provider/office chosen via the picker (directory, specialist finder, or manual add). Carries
    // the exact phone/website so booking reaches THIS office — never a re-resolved random place.
    @State private var selectedProvider: PickedProvider?
    @State private var showAddInsurance = false
    private let api = APIClient()

    init(memberId: String, memberName: String, allowMemberChange: Bool = false, initialReason: String = "",
         initialProvider: String = "", initialPhone: String = "", initialWebsite: String = "",
         onBooked: @escaping () -> Void = {}) {
        _memberId = State(initialValue: memberId)
        _memberName = State(initialValue: memberName)
        _reason = State(initialValue: initialReason)
        // A provider prefilled from physician search becomes the confirmed selection up front.
        if !initialProvider.isEmpty {
            _selectedProvider = State(initialValue: PickedProvider(
                name: initialProvider,
                phone: initialPhone.isEmpty ? nil : initialPhone,
                website: initialWebsite.isEmpty ? nil : initialWebsite,
                specialty: initialReason.isEmpty ? nil : initialReason))
        }
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
                ProviderPickerView(memberId: memberId, memberName: memberName) { picked in
                    selectedProvider = picked
                    plan = nil // back to the form with the chosen provider filled in
                }
                .environment(store)
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
                if let p = selectedProvider {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Label(p.name, systemImage: "stethoscope")
                            .font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                        if let ph = p.phone, !ph.isEmpty { Label(ph, systemImage: "phone").font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                        if let web = p.website, !web.isEmpty { Label(web, systemImage: "globe").font(.kloveCaption).foregroundStyle(Theme.inkSecondary).lineLimit(1) }
                        if let addr = p.address, !addr.isEmpty { Label(addr, systemImage: "mappin.and.ellipse").font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                    }
                    HStack {
                        Button("Change") { showProviderPicker = true }.tint(Theme.accent)
                        Spacer()
                        Button("Remove", role: .destructive) { selectedProvider = nil }
                    }
                    .font(.kloveCaption)
                } else {
                    Button { showProviderPicker = true } label: {
                        Label("Choose a provider", systemImage: "magnifyingglass")
                    }
                    .tint(Theme.accent)
                }
            } header: {
                Text("Provider or office")
            } footer: {
                Text(selectedProvider == nil
                     ? "Pick a saved provider, search by name, or find a specialist for \(reason.isEmpty ? "the visit" : reason). Klove reaches this exact office — no guessing."
                     : "Klove will contact this office to book on \(memberName)'s behalf.")
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
        .scrollContentBackground(.hidden)
        .kloveBackground()
    }

    // The confirm step: a recap of exactly what Klove will do before any calls are placed. When no
    // provider could be resolved (status needs_provider), the operator picks one from the directory
    // candidates or searches/adds a new one.
    @ViewBuilder
    private func recap(_ p: BookingPlan) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(p.isReady ? "Confirm the details" : "Pick a provider")
                        .font(.kloveSerifHeading).foregroundStyle(Theme.ink)
                    Text(p.recap).font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                }

                recapDetails(p)

                if !p.missing.isEmpty {
                    Text("Klove will proceed without \(p.missing.joined(separator: ", ")). Add it for a smoother call.")
                        .font(.kloveCaption).foregroundStyle(Theme.needsYou)
                }

                if p.isReady {
                    Button { Task { await book(p) } } label: {
                        Label("Confirm & book", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(KlovePrimaryButtonStyle()).disabled(booking)
                } else {
                    recapCandidates(p)
                }

                Button("Edit details") { plan = nil }.font(.kloveCaption).tint(Theme.accent)
            }
            .padding(Theme.Spacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .kloveBackground()
    }

    @ViewBuilder
    private func recapDetails(_ p: BookingPlan) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel(title: "The visit")
            if let prov = p.provider {
                Label(prov.name, systemImage: "stethoscope").font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                if let ph = prov.phone, !ph.isEmpty { detailRow(ph, "phone") }
                if let web = prov.website, !web.isEmpty { detailRow(web, "globe") }
            }
            detailRow("For \(p.patientName)", "person.fill")
            if !p.insuranceLabel.isEmpty { detailRow("Insurance: \(p.insuranceLabel)", "creditcard") }
            if !p.preferredTimes.isEmpty { detailRow(p.preferredTimes, "clock") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func detailRow(_ text: String, _ icon: String) -> some View {
        Label(text, systemImage: icon).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
    }

    @ViewBuilder
    private func recapCandidates(_ p: BookingPlan) -> some View {
        Text("Klove doesn't have a way to reach an office yet. Pick a known provider or add one:")
            .font(.kloveBody).foregroundStyle(Theme.ink)
        ForEach(p.candidates) { c in
            Button { Task { await book(p, chosen: c) } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                        if let ph = c.phone, !ph.isEmpty { Text(ph).font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
                }
                .padding(.vertical, Theme.Spacing.md).padding(.horizontal, Theme.Spacing.lg)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
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
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: confIcon(o)).font(.system(size: 52)).foregroundStyle(confTint(o))
                Text(confTitle(o)).font(.kloveSerifHeading).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
                Text("\(o.title)\(o.provider.map { " with \($0)" } ?? "")")
                    .font(.kloveBody).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
                // Confirm WHO it's for and WHICH coverage Klove will give the office.
                Label("For \(o.patientName ?? memberName)", systemImage: "person.fill")
                    .font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                if let ins = o.insurance, !ins.isEmpty {
                    Label("Insurance: \(ins)", systemImage: "creditcard")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                }

                if o.isNeedsInfo {
                    // Klove reached no office — be honest: nothing is booked. No "Klove is on it" here.
                    Text("Klove couldn't reach an office to book this yet, so nothing is scheduled. It's saved to Actions — add a phone or website, or pick a provider, to finish.")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, Theme.Spacing.xs)
                } else if let sid = o.sessionId {
                    // A live booking job is in flight — watch it reach the office. The confirmation (or a
                    // demo label, for a simulated run) appears in the live card and in Today once it lands.
                    Text("Watch Klove reach the office below — you'll also find this in Today & Actions.")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, Theme.Spacing.xs)
                    SessionLiveCard(sessionId: sid).padding(.top, Theme.Spacing.sm)
                } else {
                    Text("Klove is working on this — you'll find updates in Today & Actions.")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, Theme.Spacing.xs)
                }
            }
            .padding(Theme.Spacing.xl)
            .frame(maxWidth: .infinity)
        }
        .kloveBackground()
    }

    private func confTitle(_ o: BookingOutcome) -> String {
        o.isNeedsInfo ? "Couldn't reach the office yet" : "Klove is on it"
    }
    private func confIcon(_ o: BookingOutcome) -> String {
        o.isNeedsInfo ? "exclamationmark.circle" : "phone.arrow.up.right.fill"
    }
    private func confTint(_ o: BookingOutcome) -> Color {
        o.isNeedsInfo ? Theme.needsYou : Theme.accent
    }

    /// Step 1: resolve the provider + details and show a recap to confirm. No calls are placed.
    private func prepare() async {
        preparing = true
        defer { preparing = false }
        do {
            plan = try await api.prepareBooking(
                memberId,
                reason: reason.trimmingCharacters(in: .whitespaces),
                provider: selectedProvider?.name,
                specialty: selectedProvider?.specialty,
                preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
                phone: selectedProvider?.phone,
                website: selectedProvider?.website,
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
                provider: prov?.name ?? selectedProvider?.name,
                specialty: prov?.specialty ?? selectedProvider?.specialty,
                preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
                phone: prov?.phone ?? selectedProvider?.phone,
                website: prov?.website ?? selectedProvider?.website,
                insurancePlanId: selectedCardId
            )
            store.bumpData()   // refresh Today/Actions so the booking shows up
            onBooked()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
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
