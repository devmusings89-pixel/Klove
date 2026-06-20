import SwiftUI

/// A provider chosen for a booking (from the directory, Places search, the specialist finder, or a
/// manual add). Carries enough to reach the *exact* office (phone/website) so booking never re-resolves.
struct PickedProvider {
    let name: String
    let phone: String?
    let website: String?
    let specialty: String?
    var address: String? = nil
    var npi: String? = nil
}

/// Search the known-provider directory + Google Places and pick a provider for a booking, run the full
/// specialist finder, or add a new one. Returns the chosen provider to the caller via `onPick`.
struct ProviderPickerView: View {
    let memberId: String
    let memberName: String
    var onPick: (PickedProvider) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(HouseholdStore.self) private var store
    @State private var query = ""
    @State private var directory: [DirectoryProvider] = []
    @State private var places: [OfficeMatch] = []
    @State private var loading = false
    @State private var searchTask: Task<Void, Never>?
    @State private var addName = ""
    @State private var addPhone = ""
    @State private var addWebsite = ""
    @State private var saving = false
    @State private var showSpecialistSearch = false
    private let api = APIClient()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search providers or offices", text: $query)
                        .onChange(of: query) { _, q in scheduleSearch(q) }
                    if loading { Label("Searching…", systemImage: "magnifyingglass").font(.caption).foregroundStyle(.secondary) }
                }
                Section {
                    Button { showSpecialistSearch = true } label: {
                        Label("Find a specialist", systemImage: "stethoscope")
                    }
                    .tint(Theme.accent)
                } footer: {
                    Text("Describe a condition and Klove finds the right expert — ranked by credentials, ratings, and your insurance.")
                }
                if !directory.isEmpty {
                    Section("Your providers") {
                        ForEach(directory) { p in
                            Button {
                                onPick(PickedProvider(name: p.name, phone: p.phone, website: p.website, specialty: p.specialty)); dismiss()
                            } label: { providerRow(p.name, p.phone, p.address) }
                        }
                    }
                }
                if !places.isEmpty {
                    Section("From search") {
                        ForEach(places, id: \.self) { m in
                            Button {
                                onPick(PickedProvider(name: m.displayName, phone: m.phone, website: m.website, specialty: nil)); dismiss()
                            } label: { providerRow(m.displayName, m.phone, m.address) }
                        }
                    }
                }
                Section("Add a provider") {
                    TextField("Name", text: $addName)
                    TextField("Phone", text: $addPhone).keyboardType(.phonePad)
                    TextField("Website", text: $addWebsite).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button { Task { await addAndPick() } } label: { Label("Save & use", systemImage: "plus.circle.fill") }
                        .disabled(addName.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .navigationTitle("Choose a provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .tint(Theme.accent)
            .task { await initialLoad() }
            .sheet(isPresented: $showSpecialistSearch) {
                // Reuse the full specialist finder in selection mode: a pick returns the structured
                // provider straight back to the booking form (no nested booking sheet).
                PhysicianSearchView(memberId: memberId, memberName: memberName) { picked in
                    showSpecialistSearch = false
                    onPick(picked)
                    dismiss()
                }
                .environment(store)
            }
        }
    }

    @ViewBuilder
    private func providerRow(_ name: String, _ phone: String?, _ address: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).foregroundStyle(Theme.ink)
            if let phone, !phone.isEmpty { Text(phone).font(.caption2).foregroundStyle(.secondary) }
            if let address, !address.isEmpty { Text(address).font(.caption2).foregroundStyle(.secondary) }
        }
    }

    private func initialLoad() async {
        directory = (try? await api.listProviders(memberId: memberId)) ?? []
    }

    private func scheduleSearch(_ raw: String) {
        searchTask?.cancel()
        let q = raw.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { places = []; return }
        loading = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            let res = try? await api.searchProviders(q)
            if Task.isCancelled { return }
            if let res { directory = res.directory; places = res.places }
            loading = false
        }
    }

    private func addAndPick() async {
        saving = true
        defer { saving = false }
        let name = addName.trimmingCharacters(in: .whitespaces)
        let phone = addPhone.isEmpty ? nil : addPhone
        let website = addWebsite.isEmpty ? nil : addWebsite
        _ = try? await api.addProvider(name: name, phone: phone, website: website, memberId: memberId)
        onPick(PickedProvider(name: name, phone: phone, website: website, specialty: nil))
        dismiss()
    }
}
