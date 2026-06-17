import SwiftUI

/// The appointments hub: what needs your attention to finish booking, what's in progress, and all
/// upcoming/past appointments (Klove bookings + records). Self-contained navigation so the
/// pending-question deep-links work whether shown as a tab or pushed from Home.
struct AppointmentsView: View {
    @State private var model = AppointmentsModel()
    @State private var router = Router()

    var body: some View {
        NavigationStack(path: $router.path) {
            List {
                if isEmpty && !model.isLoading {
                    Section {
                        ContentUnavailableView("No appointments yet",
                                               systemImage: "calendar",
                                               description: Text("Book a visit, or connect your email and Klove will track appointments here."))
                    }
                }

                if !model.pendingActions.isEmpty {
                    Section {
                        ForEach(model.pendingActions) { action in
                            NavigationLink(value: route(for: action)) {
                                PendingActionRow(action: action)
                            }
                        }
                    } header: {
                        Label("Needs your attention", systemImage: "exclamationmark.circle.fill")
                    } footer: {
                        Text("Answer these to finish booking.")
                    }
                }

                if !model.inProgress.isEmpty {
                    Section("Working on it") {
                        ForEach(model.inProgress) { s in
                            NavigationLink(value: Route.progress(sessionId: s.id)) {
                                InProgressRow(session: s)
                            }
                        }
                    }
                }

                if !model.kloveBookings.isEmpty || !model.upcoming.isEmpty {
                    Section("Upcoming") {
                        ForEach(model.kloveBookings) { KloveBookingRow(booking: $0) }
                        ForEach(model.upcoming) { AppointmentRow(appointment: $0) }
                    }
                }
                if !model.past.isEmpty {
                    Section("Past") {
                        ForEach(model.past) { AppointmentRow(appointment: $0).opacity(0.6) }
                    }
                }
                if let error = model.errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Appointments")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .progress(let id): SessionProgressView(sessionId: id)
                case .choice(let id): ChoiceView(sessionId: id)
                case .info(let id): InfoRequestView(sessionId: id)
                case .verify(let id): VerifyView(sessionId: id)
                case .form: RequestFormView()
                }
            }
            .task { await model.load() }
            .refreshable { await model.load() }
        }
        .environment(router)
    }

    private var isEmpty: Bool {
        model.pendingActions.isEmpty && model.inProgress.isEmpty &&
        model.kloveBookings.isEmpty && model.appointments.isEmpty
    }

    private func route(for action: PendingAction) -> Route {
        switch action.kind {
        case .choice: return .choice(sessionId: action.id)
        case .info: return .info(sessionId: action.id)
        case .verification: return .verify(sessionId: action.id)
        }
    }
}

// MARK: - Rows

private struct PendingActionRow: View {
    let action: PendingAction
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.needsYou).font(.title3).frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(action.title).font(.headline)
                Text(action.detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Text(cta).font(.caption.weight(.semibold)).foregroundStyle(Theme.needsYou)
        }
        .padding(.vertical, 2)
    }
    private var icon: String {
        switch action.kind {
        case .choice: return "calendar.badge.clock"
        case .info: return "exclamationmark.bubble"
        case .verification: return "lock.shield"
        }
    }
    private var cta: String {
        switch action.kind {
        case .choice: return "Choose"
        case .info: return "Provide"
        case .verification: return "Enter code"
        }
    }
}

private struct InProgressRow: View {
    let session: SessionState
    var body: some View {
        HStack(spacing: 12) {
            ProgressView().frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.patientInfo?.reason ?? "Booking a visit").font(.headline)
                Text(statusText).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
    private var statusText: String {
        switch session.status {
        case "scheduling": return "Scheduling calls…"
        case "in_progress": return "Contacting offices…"
        default: return "Starting…"
        }
    }
}

private struct KloveBookingRow: View {
    let booking: KloveBooking
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.seal.fill").foregroundStyle(.green).font(.title3).frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(booking.reason).font(.headline)
                if let when = booking.whenText { Text(when).font(.subheadline) }
                Text(booking.office).font(.caption).foregroundStyle(.secondary)
                Text("Booked by Klove").font(.caption2).foregroundStyle(.green)
            }
        }
        .padding(.vertical, 2)
    }
}

struct AppointmentRow: View {
    let appointment: Appointment

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "calendar")
                .foregroundStyle(.tint)
                .font(.title3)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(appointment.title).font(.headline)
                Text(HealthFormat.dateTime(appointment.startsAt))
                    .font(.subheadline)
                    .foregroundStyle(appointment.isUpcoming ? .primary : .secondary)
                if let provider = appointment.provider {
                    Text(provider).font(.caption).foregroundStyle(.secondary)
                }
                if let location = appointment.location {
                    Label(location, systemImage: "mappin.and.ellipse")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if appointment.isProvisional {
                    Label("Provisional — not yet confirmed", systemImage: "exclamationmark.circle")
                        .font(.caption2.weight(.semibold)).foregroundStyle(Theme.needsYou)
                } else if let confirmation = appointment.confirmation {
                    Text("Confirmation: \(confirmation)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
