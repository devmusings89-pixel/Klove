import SwiftUI

/// "My Info": reusable demographics + insurance, captured once and auto-used for every booking.
/// Insurance can be filled by scanning the card on-device (camera) or typed manually.
struct ProfileView: View {
    @State private var model = ProfileModel()
    @State private var showScanner = false

    var body: some View {
        Form {
            Section {
                TextField("Full name", text: $model.fullName).textContentType(.name)
                TextField("Date of birth (YYYY-MM-DD)", text: $model.dob)
                TextField("Phone", text: $model.phone).textContentType(.telephoneNumber).keyboardType(.phonePad)
                TextField("Email", text: $model.email).textContentType(.emailAddress)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Address", text: $model.address, axis: .vertical).textContentType(.fullStreetAddress).lineLimit(1...3)
            } header: {
                Text("About you")
            } footer: {
                Text("Saved once and used to fill every booking, so you never re-enter it.")
            }

            Section {
                Button {
                    showScanner = true
                } label: {
                    Label(model.isScanning ? "Reading card…" : "Scan insurance card", systemImage: "doc.viewfinder")
                }
                .disabled(model.isScanning || !DocumentScanner.isSupported)
                if !DocumentScanner.isSupported {
                    Text("Card scanning needs a device camera — enter your details below.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                TextField("Carrier (e.g. Blue Cross)", text: $model.carrier)
                TextField("Plan name", text: $model.planName)
                TextField("Member ID", text: $model.memberId).autocorrectionDisabled().textInputAutocapitalization(.characters)
                TextField("Group number", text: $model.groupId).autocorrectionDisabled()
                TextField("Rx BIN", text: $model.rxBin).keyboardType(.numberPad)
                TextField("Rx PCN", text: $model.rxPcn)
                TextField("Policyholder (if not you)", text: $model.holderName).textContentType(.name)
            } header: {
                Text("Insurance")
            } footer: {
                Text("Scanning runs entirely on your device — the card photo is never uploaded or saved. Only these fields are stored, encrypted.")
            }

            if let error = model.errorMessage {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                Button {
                    Task { await model.save() }
                } label: {
                    HStack {
                        Spacer()
                        if model.isSaving { ProgressView() } else { Text("Save").bold() }
                        Spacer()
                    }
                }
                .disabled(model.isSaving)
            }
        }
        .navigationTitle("My Info")
        .task { await model.load() }
        .sheet(isPresented: $showScanner) {
            DocumentScanner(
                onScan: { images in showScanner = false; model.applyScan(images) },
                onCancel: { showScanner = false }
            )
            .ignoresSafeArea()
        }
        .alert("Saved", isPresented: $model.savedConfirmation) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Your info will auto-fill future bookings.")
        }
    }
}

// MARK: - Insurance wallet (collection, per member)

/// A member's insurance wallet — the operator can hold many cards per person (a child on the family
/// plan, an aging parent on Medicare + a supplement). Reachable for any member (incl. the operator
/// themself) from their profile. Booking links a specific card from here.
struct InsuranceWalletView: View {
    let memberId: String
    let memberName: String

    @State private var cards: [InsuranceCard] = []
    @State private var loading = true
    @State private var showAdd = false
    @State private var errorMessage: String?
    private let api = APIClient()

    var body: some View {
        List {
            if let e = errorMessage { Section { Text(e).foregroundStyle(.red) }.listRowBackground(Theme.surface) }

            Section {
                if cards.isEmpty && !loading {
                    Text("No insurance cards yet. Add every plan you hold for \(memberName) — Klove links the right one when booking.")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                }
                ForEach(cards) { card in
                    NavigationLink {
                        EditInsuranceView(memberId: memberId, memberName: memberName, card: card) { Task { await load() } }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(card.label).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                                if card.isPrimary {
                                    Text("Primary").font(.caption2.weight(.bold))
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.accentSoft, in: Capsule()).foregroundStyle(Theme.accent)
                                } else if card.isSecondary {
                                    Text("Backup").font(.caption2.weight(.bold))
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.inkSecondary.opacity(0.12), in: Capsule()).foregroundStyle(Theme.inkSecondary)
                                }
                            }
                            if let m = card.memberId, !m.isEmpty { Text("Member ID \(m)").font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                            if let h = card.holderName, !h.isEmpty { Text("Holder: \(h)").font(.kloveCaption).foregroundStyle(Theme.inkSecondary) }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .onDelete { offsets in Task { await remove(offsets) } }
            } header: {
                Text("\(memberName)'s insurance")
            }
            .listRowBackground(Theme.surface)

            Section {
                Button { showAdd = true } label: { Label("Add a card", systemImage: "plus.circle.fill") }
                    .tint(Theme.accent)
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .kloveBackground()
        .tint(Theme.accent)
        .navigationTitle("Insurance")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && cards.isEmpty { ProgressView().tint(Theme.accent) } }
        .task { await load() }
        .sheet(isPresented: $showAdd) {
            AddInsuranceView(memberId: memberId, memberName: memberName, isFirstCard: cards.isEmpty) { Task { await load() } }
        }
    }

    private func load() async {
        loading = true; defer { loading = false }
        do { cards = try await api.memberInsurance(memberId); errorMessage = nil }
        catch { errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription }
    }

    private func remove(_ offsets: IndexSet) async {
        for i in offsets {
            guard cards.indices.contains(i) else { continue }
            _ = try? await api.deleteMemberInsurance(memberId, planId: cards[i].id)
        }
        await load()
    }
}

/// Add a single insurance card to a member's wallet. Manual entry (card-scan lives in My Info).
struct AddInsuranceView: View {
    let memberId: String
    let memberName: String
    /// When the wallet is empty, the first card defaults to Primary.
    var isFirstCard: Bool = false
    var onSaved: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var carrier = ""
    @State private var planName = ""
    @State private var memberNumber = ""
    @State private var groupId = ""
    @State private var holderName = ""
    @State private var role: InsuranceRole = .none
    @State private var saving = false
    @State private var errorMessage: String?
    private let api = APIClient()

    init(memberId: String, memberName: String, isFirstCard: Bool = false, onSaved: @escaping () -> Void = {}) {
        self.memberId = memberId
        self.memberName = memberName
        self.isFirstCard = isFirstCard
        self.onSaved = onSaved
        _role = State(initialValue: isFirstCard ? .primary : .none)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Carrier (e.g. Medicare, Blue Cross)", text: $carrier).textInputAutocapitalization(.words)
                    TextField("Plan name (e.g. Part B, Family PPO)", text: $planName)
                    TextField("Member ID", text: $memberNumber).autocorrectionDisabled().textInputAutocapitalization(.characters)
                    TextField("Group number (optional)", text: $groupId).autocorrectionDisabled()
                    TextField("Policyholder (if not \(memberName))", text: $holderName).textContentType(.name)
                } header: {
                    Text("Card for \(memberName)")
                }

                Section {
                    Picker("Role", selection: $role) {
                        ForEach(InsuranceRole.allCases) { r in Text(r.label).tag(r) }
                    }
                    .tint(Theme.accent)
                } header: {
                    Text("How this card is used")
                } footer: {
                    Text(roleFooter)
                }
                if let e = errorMessage { Section { Text(e).foregroundStyle(.red) } }
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if saving { ProgressView().tint(.white) } else { Text("Add card").font(.kloveButton) }
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(saving || carrier.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("Add insurance")
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.accent)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(saving || carrier.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func save() async {
        saving = true; defer { saving = false }
        let info = InsuranceInfo(
            carrier: nilIfBlank(carrier), planName: nilIfBlank(planName), memberId: nilIfBlank(memberNumber),
            groupId: nilIfBlank(groupId), rxBin: nil, rxPcn: nil, holderName: nilIfBlank(holderName)
        )
        do {
            _ = try await api.addMemberInsurance(memberId, info, makePrimary: role == .primary, makeBackup: role == .backup)
            onSaved(); dismiss()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private var roleFooter: String {
        switch role {
        case .primary: return "Klove uses this card first when booking for \(memberName)."
        case .backup: return "Billed after the primary — the backup payer for \(memberName)."
        case .none: return isFirstCard
            ? "Saved in the wallet but not used by default."
            : "Saved in the wallet; you can pick it per booking."
        }
    }

    private func nilIfBlank(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces); return t.isEmpty ? nil : t
    }
}

/// How a card is used when booking: the primary payer, the backup billed after it, or neither.
enum InsuranceRole: String, CaseIterable, Identifiable {
    case primary, backup, none
    var id: String { rawValue }
    var label: String {
        switch self {
        case .primary: return "Primary"
        case .backup: return "Backup"
        case .none: return "Neither"
        }
    }
}

/// Edit an existing wallet card — change any field, set its role (primary/backup), or delete it.
struct EditInsuranceView: View {
    let memberId: String
    let memberName: String
    let card: InsuranceCard
    var onSaved: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var carrier: String
    @State private var planName: String
    @State private var memberNumber: String
    @State private var groupId: String
    @State private var holderName: String
    @State private var role: InsuranceRole
    @State private var saving = false
    @State private var deleting = false
    @State private var errorMessage: String?
    private let api = APIClient()

    init(memberId: String, memberName: String, card: InsuranceCard, onSaved: @escaping () -> Void = {}) {
        self.memberId = memberId
        self.memberName = memberName
        self.card = card
        self.onSaved = onSaved
        _carrier = State(initialValue: card.carrier ?? "")
        _planName = State(initialValue: card.planName ?? "")
        _memberNumber = State(initialValue: card.memberId ?? "")
        _groupId = State(initialValue: card.groupId ?? "")
        _holderName = State(initialValue: card.holderName ?? "")
        _role = State(initialValue: card.isPrimary ? .primary : (card.isSecondary ? .backup : .none))
    }

    var body: some View {
        Form {
            Section {
                TextField("Carrier (e.g. Medicare, Blue Cross)", text: $carrier).textInputAutocapitalization(.words)
                TextField("Plan name (e.g. Part B, Family PPO)", text: $planName)
                TextField("Member ID", text: $memberNumber).autocorrectionDisabled().textInputAutocapitalization(.characters)
                TextField("Group number (optional)", text: $groupId).autocorrectionDisabled()
                TextField("Policyholder (if not \(memberName))", text: $holderName).textContentType(.name)
            } header: {
                Text("Card for \(memberName)")
            }
            .listRowBackground(Theme.surface)

            Section {
                Picker("Role", selection: $role) {
                    ForEach(InsuranceRole.allCases) { r in Text(r.label).tag(r) }
                }
                .tint(Theme.accent)
            } header: {
                Text("How this card is used")
            } footer: {
                Text(roleFooter)
            }
            .listRowBackground(Theme.surface)

            if let e = errorMessage { Section { Text(e).foregroundStyle(.red) }.listRowBackground(Theme.surface) }

            Section {
                Button(role: .destructive) {
                    Task { await deleteCard() }
                } label: {
                    HStack {
                        Spacer()
                        if deleting { ProgressView().tint(.red) } else { Text("Delete card").font(.kloveButton) }
                        Spacer()
                    }
                }
                .disabled(saving || deleting)
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .kloveBackground()
        .navigationTitle("Edit insurance")
        .navigationBarTitleDisplayMode(.inline)
        .tint(Theme.accent)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(saving || deleting || carrier.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func save() async {
        saving = true; defer { saving = false }
        let info = InsuranceInfo(
            carrier: nilIfBlank(carrier), planName: nilIfBlank(planName), memberId: nilIfBlank(memberNumber),
            groupId: nilIfBlank(groupId), rxBin: card.rxBin, rxPcn: card.rxPcn, holderName: nilIfBlank(holderName)
        )
        do {
            // Send the chosen role explicitly so the backend re-points the single primary/backup slot.
            _ = try await api.updateMemberInsurance(
                memberId, planId: card.id, info,
                makePrimary: role == .primary, makeBackup: role == .backup
            )
            onSaved(); dismiss()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private var roleFooter: String {
        switch role {
        case .primary: return "Klove uses this card first when booking for \(memberName)."
        case .backup: return "Billed after the primary — the backup payer for \(memberName)."
        case .none: return "Saved in the wallet but not used by default."
        }
    }

    private func deleteCard() async {
        deleting = true; defer { deleting = false }
        do {
            _ = try await api.deleteMemberInsurance(memberId, planId: card.id)
            onSaved(); dismiss()
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func nilIfBlank(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces); return t.isEmpty ? nil : t
    }
}
