import SwiftUI

/// Find the best expert for a condition. Describe the condition → Klove routes it to the right specialty,
/// ranks credentialed specialists by credentials + public ratings, and flags each in-network / out /
/// unconfirmed against the patient's insurance. From a result you can book or save it to the directory.
struct PhysicianSearchView: View {
    var allowMemberChange = false

    @Environment(HouseholdStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: PhysicianSearchModel

    init(memberId: String, memberName: String, allowMemberChange: Bool = false) {
        _model = State(initialValue: PhysicianSearchModel(memberId: memberId, memberName: memberName))
        self.allowMemberChange = allowMemberChange
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    searchControls
                    if model.searching {
                        ProgressView("Finding specialists…").frame(maxWidth: .infinity).padding(.top, 40)
                    } else if model.hasSearched {
                        resultsSection
                    } else {
                        intro
                    }
                }
                .padding(Theme.Spacing.xl)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Find a specialist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .tint(Theme.accent)
            .alert("Search failed", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(model.errorMessage ?? "") }
            .navigationDestination(for: PhysicianResult.self) { p in
                PhysicianDetailView(result: p, model: model).environment(store)
            }
        }
    }

    // MARK: Controls

    private var searchControls: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if allowMemberChange && !store.actionableMembers.isEmpty {
                Picker("Patient", selection: $model.memberId) {
                    ForEach(store.actionableMembers) { m in Text(m.displayLabel).tag(m.userId) }
                }
                .onChange(of: model.memberId) { _, new in
                    model.memberName = store.actionableMembers.first { $0.userId == new }?.name ?? model.memberName
                }
            }
            TextField("Describe the condition — e.g. psoriasis, knee pain, afib", text: $model.condition, axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await model.search() } }
            HStack(spacing: Theme.Spacing.md) {
                TextField("Location — e.g. Seattle, WA", text: $model.location)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.words)
                Picker("Within", selection: $model.radiusMiles) {
                    ForEach(model.radiusOptions, id: \.self) { mi in Text("\(mi) mi").tag(mi) }
                }
                .pickerStyle(.menu)
                .tint(Theme.accent)
                .disabled(!model.radiusApplies)
            }
            if !model.radiusApplies {
                Text("Add a location to filter by distance.")
                    .font(.caption2).foregroundStyle(Theme.inkSecondary)
            }
            Button { Task { await model.search() } } label: {
                Label("Find experts", systemImage: "magnifyingglass")
            }
            .buttonStyle(KlovePrimaryButtonStyle())
            .disabled(!model.canSearch)
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("The right expert, not just any doctor").font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            Text("Tell Klove what's going on. We'll match it to the right specialty, rank board-certified specialists by credentials and public ratings, and show whether they likely take \(model.memberName)'s insurance.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    // MARK: Results

    @ViewBuilder
    private var resultsSection: some View {
        if let rec = model.recommendation, !rec.isEmpty {
            recommendationCard(rec)
        }
        if let spec = model.resolvedSpecialty {
            Text(("Best matches · " + spec + (model.resolvedSubspecialty.map { " · \($0)" } ?? "")).uppercased())
                .font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
        }
        if model.results.isEmpty {
            Text("No specialists found. Try describing the condition differently, widening the radius, or changing the location.")
                .font(.kloveBody).foregroundStyle(Theme.inkSecondary).kloveCard()
        } else {
            ForEach(model.results) { p in
                NavigationLink(value: p) { resultCard(p) }.buttonStyle(.plain)
            }
            if model.hasMore {
                Button { Task { await model.loadMore() } } label: {
                    if model.loadingMore { ProgressView() } else { Label("Load more", systemImage: "arrow.down.circle") }
                }
                .buttonStyle(KlovePrimaryButtonStyle())
                .disabled(model.loadingMore)
                .padding(.top, 4)
            }
            if !model.disclaimer.isEmpty {
                Text(model.disclaimer).font(.caption).foregroundStyle(Theme.inkSecondary).padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func recommendationCard(_ rec: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label("Klove's recommendation", systemImage: "sparkles")
                .font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.accent)
            Text(rec).font(.kloveBody).foregroundStyle(Theme.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCardSunken()
    }

    @ViewBuilder
    private func resultCard(_ p: PhysicianResult) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                    if let tax = p.taxonomyDesc {
                        Text(tax).font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                }
                Spacer()
                NetworkBadge(status: p.networkStatus)
            }

            HStack(spacing: Theme.Spacing.md) {
                if let rating = p.rating {
                    let count = p.reviewCount ?? 0
                    Text(count > 0 ? String(format: "%.1f★ · %d reviews", rating, count) : String(format: "%.1f★", rating))
                        .font(.caption.weight(.medium)).foregroundStyle(Theme.ink)
                }
                if let mi = p.distanceMiles {
                    Label(String(format: "%.1f mi", mi), systemImage: "mappin.and.ellipse")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                }
            }
            HStack(alignment: .bottom) {
                if let addr = p.address, !addr.isEmpty {
                    Text(addr).font(.caption2).foregroundStyle(Theme.inkSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }
}

/// Full detail for a tapped specialist: everything we know, plus live-loaded review snippets and the
/// insurance scraped from their website (which upgrades the network badge), and the primary booking CTA.
struct PhysicianDetailView: View {
    let result: PhysicianResult
    let model: PhysicianSearchModel

    @Environment(HouseholdStore.self) private var store
    @State private var detail: PhysicianDetail?
    @State private var loading = true
    @State private var showBook = false
    private let api = APIClient()

    private var networkStatus: NetworkStatus { detail?.networkStatus ?? result.networkStatus }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header
                bookCTA
                contactSection
                insuranceSection
                reviewsSection
                saveButton
            }
            .padding(Theme.Spacing.xl)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(result.name)
        .navigationBarTitleDisplayMode(.inline)
        .tint(Theme.accent)
        .task { await load() }
        .sheet(isPresented: $showBook) {
            BookAppointmentView(memberId: model.memberId, memberName: model.memberName,
                                initialReason: model.resolvedSpecialty ?? result.specialty)
                .environment(store)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(result.name).font(.kloveSerifHeading).foregroundStyle(Theme.ink)
            if let tax = result.taxonomyDesc { Text(tax).font(.kloveBody).foregroundStyle(Theme.inkSecondary) }
            HStack(spacing: Theme.Spacing.md) {
                if let rating = result.rating {
                    Text(String(format: "%.1f★ · %d reviews", rating, result.reviewCount ?? 0))
                        .font(.caption.weight(.medium)).foregroundStyle(Theme.ink)
                }
                if let mi = result.distanceMiles {
                    Label(String(format: "%.1f mi", mi), systemImage: "mappin.and.ellipse")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                }
                NetworkBadge(status: networkStatus)
            }
        }
    }

    private var bookCTA: some View {
        Button { showBook = true } label: {
            Label("Klove Book an appointment", systemImage: "calendar.badge.plus")
        }
        .buttonStyle(KlovePrimaryButtonStyle())
    }

    @ViewBuilder
    private var contactSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionLabel("Contact")
            if let addr = result.address, !addr.isEmpty {
                Link(destination: mapsURL(addr)) { rowLabel(addr, "mappin.and.ellipse") }
            }
            if let phone = result.phone, !phone.isEmpty, let tel = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                Link(destination: tel) { rowLabel(phone, "phone") }
            }
            if let web = result.website, !web.isEmpty, let url = URL(string: web) {
                Link(destination: url) { rowLabel(web, "globe").lineLimit(1) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    @ViewBuilder
    private var insuranceSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            sectionLabel("Insurance accepted")
            if loading {
                Label("Checking their website…", systemImage: "magnifyingglass").font(.caption).foregroundStyle(Theme.inkSecondary)
            } else if let d = detail, !d.acceptedCarriers.isEmpty {
                Text(d.acceptedCarriers.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.ink)
                networkVerdict
                if let src = d.insuranceSourceUrl, let url = URL(string: src) {
                    Link("Source: their website", destination: url).font(.caption2).tint(Theme.accent)
                }
            } else {
                Text(detail?.insuranceNote ?? "We couldn't confirm accepted insurance from their website. Call the office to verify your coverage.")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    @ViewBuilder
    private var networkVerdict: some View {
        switch networkStatus {
        case .inNetwork: Label("Likely takes your insurance", systemImage: "checkmark.seal.fill").font(.caption.weight(.semibold)).foregroundStyle(.green)
        case .outOfNetwork: Label("May be out-of-network for your plan", systemImage: "exclamationmark.triangle").font(.caption.weight(.semibold)).foregroundStyle(.red)
        default: Text("Confirm your specific plan with the office.").font(.caption2).foregroundStyle(Theme.inkSecondary)
        }
    }

    @ViewBuilder
    private var reviewsSection: some View {
        if let d = detail, !d.reviews.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                sectionLabel("What patients say")
                ForEach(Array(d.reviews.prefix(4).enumerated()), id: \.offset) { _, r in
                    Text("“\(r)”").font(.caption).foregroundStyle(Theme.inkSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kloveCard()
        }
    }

    private var saveButton: some View {
        Button { Task { await model.save(result) } } label: {
            Label(model.savedIds.contains(result.id) ? "Saved to your directory" : "Save to directory",
                  systemImage: model.savedIds.contains(result.id) ? "checkmark" : "bookmark")
        }
        .tint(Theme.accent)
        .disabled(model.savedIds.contains(result.id))
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(t.uppercased()).font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
    }
    private func rowLabel(_ t: String, _ icon: String) -> some View {
        Label(t, systemImage: icon).font(.caption).foregroundStyle(Theme.ink)
    }
    private func mapsURL(_ address: String) -> URL {
        URL(string: "http://maps.apple.com/?q=\(address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")!
    }

    private func load() async {
        loading = true
        defer { loading = false }
        detail = try? await api.physicianDetails(name: result.name, address: result.address, website: result.website, memberId: model.memberId)
    }
}

/// Color-coded in-network badge. Network status genuinely benefits from color even in the monochrome
/// system, so it uses semantic green/red with quiet greys for the unknowns.
struct NetworkBadge: View {
    let status: NetworkStatus

    var body: some View {
        Text(status.label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.8)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(tint.opacity(0.14), in: Capsule())
            .foregroundStyle(tint)
    }

    private var tint: Color {
        switch status {
        case .inNetwork: return .green
        case .outOfNetwork: return .red
        case .unconfirmed: return .orange
        case .unknown: return Theme.inkSecondary
        }
    }
}
