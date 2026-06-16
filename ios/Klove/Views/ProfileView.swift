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
