import SwiftUI

/// ★ Hero flow (J4). Walk in prepared: a one-page brief pulled from the member's record, plus
/// personalized questions the operator can edit — then authorize Klove to book and coordinate.
struct AppointmentBriefView: View {
    let memberId: String
    let memberName: String
    var appointmentId: String?

    @State private var brief: AppointmentBrief?
    @State private var questions: [String] = []
    @State private var loading = true
    @State private var booking = false
    @State private var booked = false
    @State private var provisional = false
    @State private var inProgress = false
    @State private var confirmation: String?
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if loading && brief == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if let b = brief {
                    headerCard(b)
                    snapshotCard(b)
                    if !b.recentEvents.isEmpty { recentCard(b) }
                    questionsCard
                    bookCard
                }
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Visit prep")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if let b = try? await api.getPrep(memberId, appointmentId: appointmentId) {
            brief = b
            questions = b.questions
        }
    }

    private func headerCard(_ b: AppointmentBrief) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(b.appointment?.title ?? "\(memberName)'s next visit")
                .font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
            if let p = b.appointment?.provider {
                Label(p, systemImage: "stethoscope").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            }
            Text("Everything you need, on one page.").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func snapshotCard(_ b: AppointmentBrief) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Snapshot", systemImage: "heart.text.square").font(.headline).foregroundStyle(Theme.ink)
            if !b.summary.activeConditions.isEmpty {
                briefRow("Conditions", b.summary.activeConditions.joined(separator: ", "))
            }
            if !b.summary.activeMedications.isEmpty {
                briefRow("Medications", b.summary.activeMedications.joined(separator: ", "))
            }
            briefRow("On file", "\(b.summary.counts.observations) results · \(b.summary.counts.appointments) visits")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private func recentCard(_ b: AppointmentBrief) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Recent", systemImage: "clock").font(.headline).foregroundStyle(Theme.ink)
            ForEach(b.recentEvents) { e in
                HStack(spacing: 8) {
                    Image(systemName: e.symbol).font(.caption).foregroundStyle(Theme.accent)
                    Text(e.title).font(.subheadline).foregroundStyle(Theme.ink)
                    Spacer()
                    Text(e.displayDate).font(.caption2).foregroundStyle(Theme.inkSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private var questionsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Questions to ask", systemImage: "questionmark.bubble").font(.headline).foregroundStyle(Theme.ink)
            ForEach(questions.indices, id: \.self) { i in
                HStack(alignment: .top, spacing: 8) {
                    Text("•").foregroundStyle(Theme.accent)
                    TextField("Question", text: $questions[i], axis: .vertical)
                        .font(.subheadline).foregroundStyle(Theme.ink)
                    Button { questions.remove(at: i) } label: {
                        Image(systemName: "minus.circle").foregroundStyle(Theme.inkSecondary)
                    }
                }
            }
            Button { questions.append("") } label: {
                Label("Add a question", systemImage: "plus.circle").font(.caption).foregroundStyle(Theme.accent)
            }
            if appointmentId != nil {
                Button("Save questions") { Task { await save() } }
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kloveCard()
    }

    private var bookCard: some View {
        VStack(spacing: 10) {
            if booked && provisional {
                VStack(spacing: 4) {
                    Label("Provisional hold placed", systemImage: "calendar.badge.clock")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.needsYou)
                    Text("Klove hasn't confirmed this with the office yet — you'll be updated in Today when it's confirmed.")
                        .font(.caption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                }
            } else if booked && inProgress {
                VStack(spacing: 4) {
                    Label("Klove is contacting the office", systemImage: "phone.arrow.up.right.fill")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                    Text("Nothing is confirmed yet — watch progress in Today & Actions; you'll be updated when it's booked.")
                        .font(.caption).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                }
            } else if booked {
                VStack(spacing: 4) {
                    Label("Booked by Klove", systemImage: "checkmark.seal.fill")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.handled)
                    if let c = confirmation {
                        Text("Confirmation \(c) · see it in Today & Actions").font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                }
            } else {
                Button { Task { await bookIt() } } label: {
                    Label("Have Klove book & coordinate", systemImage: "sparkles")
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                .foregroundStyle(Theme.background).background(Theme.accent, in: RoundedRectangle(cornerRadius: 12)).disabled(booking)
                Text("You authorize Klove to contact the office on \(memberName)'s behalf.")
                    .font(.caption2).foregroundStyle(Theme.inkSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .kloveCard()
    }

    private func briefRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption).foregroundStyle(Theme.inkSecondary)
            Text(value).font(.subheadline).foregroundStyle(Theme.ink)
        }
    }

    private func save() async {
        guard let appointmentId else { return }
        try? await api.saveQuestions(memberId, appointmentId: appointmentId, questions: questions.filter { !$0.isEmpty })
    }

    private func bookIt() async {
        booking = true
        defer { booking = false }
        try? await api.authorizeBooking(memberId)
        let reason = brief?.appointment?.title ?? "Appointment for \(memberName)"
        if let outcome = try? await api.bookForMember(memberId, reason: reason, provider: brief?.appointment?.provider, preferredDate: brief?.appointment?.startsAt) {
            confirmation = outcome.confirmation
            provisional = outcome.isProvisional
            inProgress = outcome.isInProgress
            booked = true
        }
    }
}
