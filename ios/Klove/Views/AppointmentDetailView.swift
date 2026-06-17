import SwiftUI

/// An appointment with actions: reschedule, cancel, or log the visit summary afterward.
struct AppointmentDetailView: View {
    let memberId: String
    let memberName: String
    let appt: UpcomingAppt
    var onChange: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var showReschedule = false
    @State private var newDate = Date().addingTimeInterval(86_400)
    @State private var showSummary = false
    @State private var confirmCancel = false
    @State private var working = false
    @State private var note: String?
    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(appt.title).font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let p = appt.provider { Label(p, systemImage: "stethoscope").font(.subheadline).foregroundStyle(Theme.inkSecondary) }
                    Label(appt.whenDisplay, systemImage: "calendar").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    Text("For \(memberName)").font(.caption).foregroundStyle(Theme.inkSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .kloveCard()

                if appt.isProvisional {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Provisional hold", systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                        Text("Klove placed this time but hasn't confirmed it with the office yet. Don't rely on it until it's confirmed.")
                            .font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .kloveCard()
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Confirmed with the office", systemImage: "checkmark.seal.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.handled)
                        if let c = appt.confirmation, !c.isEmpty {
                            Text("Confirmation \(c)").font(.caption).foregroundStyle(Theme.inkSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .kloveCard()
                }

                if let note { Text(note).font(.caption).foregroundStyle(Theme.handled).kloveCard() }

                VStack(spacing: 10) {
                    actionButton("Reschedule", "calendar.badge.clock", Theme.accent) { showReschedule = true }
                    // A provisional hold isn't a real visit yet — can't log a summary for it.
                    if !appt.isProvisional {
                        actionButton("Log visit summary", "square.and.pencil", Theme.handled) { showSummary = true }
                    }
                    Button(role: .destructive) { confirmCancel = true } label: {
                        Label("Cancel appointment", systemImage: "xmark.circle")
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                    }
                    .tint(.red)
                    .confirmationDialog("Cancel this appointment?", isPresented: $confirmCancel, titleVisibility: .visible) {
                        Button("Cancel appointment", role: .destructive) { Task { await cancel() } }
                    }
                }
                .disabled(working)
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Appointment")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showReschedule) {
            NavigationStack {
                Form {
                    DatePicker("New time", selection: $newDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                }
                .navigationTitle("Reschedule").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showReschedule = false } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await reschedule() } } }
                }
                .tint(Theme.accent)
            }
        }
        .sheet(isPresented: $showSummary) {
            VisitSummaryView(memberId: memberId, memberName: memberName, appointmentId: appt.id)
        }
    }

    private func actionButton(_ title: String, _ icon: String, _ tint: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .foregroundStyle(.white).background(tint, in: RoundedRectangle(cornerRadius: 12))
    }

    private func reschedule() async {
        working = true; defer { working = false }
        let iso = ISO8601DateFormatter().string(from: newDate)
        if (try? await api.rescheduleAppointment(memberId, appointmentId: appt.id, startsAt: iso)) != nil {
            showReschedule = false; note = "Rescheduled."; onChange()
        }
    }

    private func cancel() async {
        working = true; defer { working = false }
        if (try? await api.cancelAppointment(memberId, appointmentId: appt.id)) != nil { onChange(); dismiss() }
    }
}
