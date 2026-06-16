import SwiftUI

struct RequestFormView: View {
    @Environment(Router.self) private var router
    @State private var model = RequestFormModel()
    @State private var showConsent = false

    var body: some View {
        Form {
            Section("Your email") {
                TextField("you@example.com", text: $model.email)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            Section("Patient") {
                TextField("Full name", text: $model.patient.name)
                TextField("Date of birth (YYYY-MM-DD)", text: $model.patient.dob)
                TextField("Reason for visit", text: $model.patient.reason)
                TextField("Insurance (optional)", text: $model.patient.insurance)
                TextField("Preferred times (optional)", text: $model.patient.preferredTimes)
            }

            Section {
                TextField("Your phone (for callbacks)", text: $model.patient.patientPhone)
                    .keyboardType(.phonePad)
                TextField("Your email (for booking forms & codes)", text: $model.patient.patientEmail)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text("Online schedulers often require your email and send a one-time code there to confirm. If the office asks for something we don't have, we can connect them to you or call you back.")
            }

            Section {
                TextField("e.g. member ID, group #, referral, pharmacy", text: $model.patient.additionalInfo, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("Anything the office might ask for")
            }

            Section {
                TextField("e.g. any weekday morning in the next 2 weeks", text: $model.patient.acceptableWindow)
            } header: {
                Text("Auto-book if within")
            } footer: {
                Text("If a slot fits this window, we book it automatically. Otherwise we collect options and ask you to choose.")
            }

            officesSection

            Section {
                Toggle("Stop after first booking", isOn: $model.stopWhenBooked)
            } footer: {
                Text("We call up to \(model.maxTargets) offices, or 60 minutes total.")
            }

            if let error = model.errorMessage {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                Button(action: { showConsent = true }) {
                    HStack {
                        Spacer()
                        if model.isSubmitting { ProgressView() } else { Text("Continue — $5") .bold() }
                        Spacer()
                    }
                }
                .disabled(model.isSubmitting)
            }
        }
        .navigationTitle("Book an appointment")
        .alert("Consent", isPresented: $showConsent) {
            Button("Cancel", role: .cancel) {}
            Button("I agree") { Task { await submit() } }
        } message: {
            Text("An AI agent will call offices on your behalf and calls may be recorded. This service is not HIPAA-compliant; do not submit sensitive data you are not comfortable sharing.")
        }
    }

    private var officesSection: some View {
        Section("Offices") {
            ForEach($model.targets) { $target in
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Office name or search", text: $target.officeName)
                    TextField("Phone (optional)", text: $target.phoneNumber)
                        .keyboardType(.phonePad)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Booking website (optional)", text: $target.website)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Office email (optional)", text: $target.email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .onDelete(perform: model.removeTarget)

            if model.canAddTarget {
                Button("Add another office", systemImage: "plus") { model.addTarget() }
            }
        }
    }

    private func submit() async {
        guard let response = await model.submit() else { return }
        switch await PaymentService.pay(for: response) {
        case .completed:
            router.push(.progress(sessionId: response.sessionId))
        case .canceled:
            model.errorMessage = "Payment canceled."
        case .failed(let message):
            model.errorMessage = message
        }
    }
}
