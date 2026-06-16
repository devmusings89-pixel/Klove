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
        }
    }

    private var form: some View {
        Form {
            if allowMemberChange && !store.actionableMembers.isEmpty {
                Section("Who is this for?") {
                    Picker("Member", selection: $memberId) {
                        ForEach(store.actionableMembers) { m in Text(m.name).tag(m.userId) }
                    }
                    .onChange(of: memberId) { _, new in
                        memberName = store.actionableMembers.first { $0.userId == new }?.name ?? memberName
                    }
                }
            }
            Section("What's the visit for?") {
                TextField("e.g. Annual physical, dermatology", text: $reason)
            }
            Section("Provider or office (optional)") {
                TextField("e.g. Dr. Lin, City Endocrinology", text: $provider)
                    .textInputAutocapitalization(.words)
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

    private func confirmation(_ o: BookingOutcome) -> some View {
        VStack(spacing: 14) {
            Image(systemName: o.isConfirmed ? "checkmark.seal.fill" : "phone.arrow.up.right.fill")
                .font(.system(size: 52)).foregroundStyle(o.isConfirmed ? Theme.handled : Theme.accent)
            Text(o.isConfirmed ? "Done — it's booked" : "Klove is on it")
                .font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
            Text("\(o.title)\(o.provider.map { " with \($0)" } ?? "")")
                .font(.subheadline).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
            if o.isConfirmed {
                Text("\(o.whenDisplay)\(o.confirmation.map { " · Confirmation \($0)" } ?? "")")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
                Text("You'll find it in Today and on \(memberName)'s timeline.")
                    .font(.caption).foregroundStyle(Theme.inkSecondary).padding(.top, 4)
            } else {
                Text("Klove is contacting the office now. You'll get a confirmation in Today & Actions when it's booked.")
                    .font(.caption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center).padding(.top, 4)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }

    private func book() async {
        booking = true
        defer { booking = false }
        outcome = try? await api.bookForMember(
            memberId,
            reason: reason.trimmingCharacters(in: .whitespaces),
            provider: provider.isEmpty ? nil : provider,
            preferredTimes: preferredTimes.isEmpty ? nil : preferredTimes,
            phone: phone.isEmpty ? nil : phone,
            website: website.isEmpty ? nil : website
        )
        if outcome != nil {
            store.bumpData()   // refresh Today/Actions so the booking shows up
            onBooked()
        }
    }
}
