import SwiftUI
import AuthenticationServices

/// First-run flow: welcome → value prop → identify → connect data sources.
/// Completion is signaled by setting the `hasOnboarded` flag, which the app root observes.
struct OnboardingView: View {
    @State private var model = OnboardingModel()
    @State private var authBusy = false

    private func emailAuth(signup: Bool) async {
        authBusy = true
        defer { authBusy = false }
        model.identifyError = nil
        let email = model.email.trimmingCharacters(in: .whitespaces)
        let ok = signup
            ? await AuthService.shared.signUpWithEmail(email, model.password)
            : await AuthService.shared.signInWithEmail(email, model.password)
        if !ok { model.identifyError = AuthService.shared.errorMessage }
        // On success, AuthService sets hasOnboarded → the app root switches to MainTabView.
    }

    var body: some View {
        VStack(spacing: 0) {
            ProgressDots(count: OnboardingModel.Step.allCases.count, current: model.step.rawValue)
                .padding(.top, 12)

            ScrollView {
                content
                    .padding(.horizontal, 24)
                    .padding(.top, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            footer
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
        }
        .animation(.snappy, value: model.step)
    }

    // MARK: - Step content

    @ViewBuilder
    private var content: some View {
        switch model.step {
        case .welcome: welcome
        case .value: value
        case .identify: identify
        case .family: family
        case .connect: connect
        case .channels: channels
        }
    }

    private var family: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Who are you caring for?").font(.largeTitle.bold())
            Text("Add the family members you coordinate care for. You can add more (or invite adults) later.")
                .foregroundStyle(.secondary)
            HStack {
                TextField("Name (e.g. Dad, Ava)", text: $model.newMemberName).textInputAutocapitalization(.words)
                    .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                Button { Task { await model.addMember() } } label: { Image(systemName: "plus.circle.fill").font(.title2) }
                    .disabled(model.newMemberName.trimmingCharacters(in: .whitespaces).isEmpty || model.addingMember)
            }
            Picker("Type", selection: $model.newMemberType) {
                ForEach(NewMemberType.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented)
            if !model.addedMembers.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.addedMembers, id: \.self) { name in
                        Label(name, systemImage: "checkmark.circle.fill").foregroundStyle(.tint)
                    }
                }.padding(.top, 4)
            }
            Text("You can skip this and add family anytime from the Family tab.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var channels: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("How should Klove reach you?").font(.largeTitle.bold())
            Text("Klove sends a calm nudge only when something needs you — never a pile of unread.")
                .foregroundStyle(.secondary)
            Toggle(isOn: $model.pushEnabled) {
                Label("Push notifications", systemImage: "bell.badge.fill")
            }
            .padding(12).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 8) {
                Label("Text & WhatsApp — coming soon", systemImage: "message")
                Label("Email digest — coming soon", systemImage: "envelope")
            }
            .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "heart.text.square.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
            Text("Welcome to Klove")
                .font(.largeTitle.bold())
            Text("Your health records, appointments, and the dots between them — understood in one place.")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var value: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("What Klove does")
                .font(.largeTitle.bold())
            VStack(alignment: .leading, spacing: 20) {
                FeatureRow(icon: "tray.full.fill", title: "All your records, together",
                           detail: "Labs, conditions, medications, and visits in one timeline.")
                FeatureRow(icon: "bell.badge.fill", title: "Never miss an appointment",
                           detail: "Reminders and AI-assisted booking when you need care.")
                FeatureRow(icon: "exclamationmark.shield.fill", title: "Things to be aware of",
                           detail: "Surfaces out-of-range results worth discussing with your doctor.")
                FeatureRow(icon: "point.3.connected.trianglepath.dotted", title: "Connects the dots",
                           detail: "Finds patterns across your diagnoses and history.")
            }
        }
    }

    private var identify: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Let's set up your account")
                .font(.largeTitle.bold())
            Text("We'll use this to keep your health data private to you.")
                .foregroundStyle(.secondary)

            TextField("you@example.com", text: $model.email)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.emailAddress)
                .padding()
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))

            SecureField("Password", text: $model.password)
                .textContentType(.password)
                .padding()
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 10) {
                Button { Task { await emailAuth(signup: false) } } label: {
                    Text("Sign in").font(.headline).frame(maxWidth: .infinity).frame(height: 46)
                        .overlay(Capsule().stroke(Color(.systemGray3), lineWidth: 1))
                }
                Button { Task { await emailAuth(signup: true) } } label: {
                    Text("Create account").font(.headline).frame(maxWidth: .infinity).frame(height: 46)
                        .foregroundStyle(.white).background(Theme.accent, in: Capsule())
                }
            }
            .disabled(!model.email.contains("@") || model.password.count < 6 || authBusy)

            if let error = model.identifyError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }

            HStack { line; Text("or").font(.caption).foregroundStyle(.secondary); line }
                .padding(.vertical, 4)

            SignInWithAppleButton(.signIn) { req in
                AuthService.shared.configure(req)
            } onCompletion: { result in
                AuthService.shared.handle(result)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 48)
            .clipShape(Capsule())

            Button { Task { await AuthService.shared.signInWithGoogle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "globe").font(.headline)
                    Text("Continue with Google").font(.headline)
                }
                .frame(maxWidth: .infinity).frame(height: 48)
                .foregroundStyle(.primary)
                .overlay(Capsule().stroke(Color(.systemGray3), lineWidth: 1))
            }

            if let authError = AuthService.shared.errorMessage {
                Text(authError).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private var line: some View { Rectangle().fill(Color(.systemGray4)).frame(height: 1) }

    private var connect: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Bring in your health data")
                .font(.largeTitle.bold())
            Text("Connect any sources you like — you can add more later.")
                .foregroundStyle(.secondary)

            ConnectSourcesView(model: model.sources)

            Text("Your data is processed securely and is never shared without your consent. Klove surfaces information to discuss with your provider and is not a substitute for medical advice.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
    }

    // MARK: - Footer buttons

    private var footer: some View {
        VStack(spacing: 12) {
            // The account step authenticates via its own Sign in / Create account
            // actions. A generic "Continue" here would let users skip past auth, so
            // the footer's primary button is omitted on that step — the screen offers
            // only Log in or Register.
            if model.step != .identify {
                Button(action: primaryAction) {
                    Text(model.step.isLast ? "Finish" : "Continue")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
            }

            if model.step.isLast {
                Button("Skip for now", action: { model.finish() })
                    .font(.subheadline)
            } else if model.step != .welcome {
                Button("Back", action: { model.back() })
                    .font(.subheadline)
            }
        }
    }

    private func primaryAction() {
        if model.step.isLast { model.finish() } else { model.advance() }
    }
}

// MARK: - Small building blocks

private struct ProgressDots: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i == current ? Theme.accent : Color(.systemGray4))
                    .frame(width: i == current ? 22 : 7, height: 7)
            }
        }
    }
}

private struct FeatureRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}
