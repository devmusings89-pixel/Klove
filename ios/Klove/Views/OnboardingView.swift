import SwiftUI
import AuthenticationServices

/// First-run flow (Figma "Lō x Klove V1"): an intro carousel → passwordless account → three numbered
/// detail steps (About You · Your Care Circle · Notifications) → into the app. Editorial monochrome.
struct OnboardingView: View {
    @State private var model = OnboardingModel()

    var body: some View {
        Group {
            switch model.step {
            case .welcome: WelcomeStep(model: model)
            case .identify: IdentifyStep(model: model)
            case .aboutYou: AboutYouStep(model: model)
            case .careCircle: CareCircleStep(model: model)
            case .notifications: NotificationsStep(model: model)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .animation(.snappy, value: model.step)
        // Apple/Google complete asynchronously: when a session lands on the identify step, continue
        // into the detail steps (magic link advances itself in mock mode).
        .onChange(of: AuthService.shared.isAuthenticated) { _, signedIn in
            if signedIn, model.step == .identify { model.advance() }
        }
    }
}

// MARK: - 1 · Welcome (intro carousel)

private struct WelcomeStep: View {
    let model: OnboardingModel
    @State private var slide = 0

    private struct Slide { let eyebrow, line1, line2, body: String }
    // Slide 1 is the V1 design; slides 2–3 carry the same layout with the product's value props.
    private let slides = [
        Slide(eyebrow: "FOR THE ONES YOU CARE FOR", line1: "All your family's health,", line2: "in one place.",
              body: "Health records, care history, and next steps all organized around the people who matter most."),
        Slide(eyebrow: "ONE CLEAR TIMELINE", line1: "Every record,", line2: "finally together.",
              body: "Labs, medications, conditions, and visits — pulled into one timeline you can actually read."),
        Slide(eyebrow: "ALWAYS A STEP AHEAD", line1: "Klove handles", line2: "the busywork.",
              body: "Reminders, prep, and booking — Klove surfaces the one next step the moment something needs you."),
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("klove.").font(.system(size: 26, design: .serif)).foregroundStyle(Theme.ink)
                Spacer()
                Button("Sign In") { model.advance() }
                    .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
            }
            .padding(.horizontal, OnbStyle.hMargin).padding(.top, 8)

            TabView(selection: $slide) {
                ForEach(slides.indices, id: \.self) { i in
                    let s = slides[i]
                    VStack(alignment: .leading, spacing: 0) {
                        Text(s.eyebrow).font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
                            .padding(.top, 24)
                        VStack(alignment: .leading, spacing: -2) {
                            Text(s.line1).font(.kloveTitle).foregroundStyle(Theme.ink)
                            Text(s.line2).font(.kloveTitleItalic).foregroundStyle(Theme.inkSecondary)
                        }
                        .padding(.top, 12)
                        Text(s.body).font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 12)
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .fill(Theme.surfaceSunken)
                            .padding(.top, 24)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, OnbStyle.hMargin)
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            OnbDots(count: slides.count, current: slide).padding(.bottom, 20)

            Button("Get Started") { model.advance() }
                .buttonStyle(OnbButtonStyle())
                .padding(.horizontal, OnbStyle.hMargin).padding(.bottom, 8)
        }
    }
}

// MARK: - 2 · Identify (magic link)

private struct IdentifyStep: View {
    @Bindable var model: OnboardingModel
    @FocusState private var emailFocused: Bool

    private var canContinue: Bool {
        model.email.contains("@") && model.email.contains(".") && model.agreedToTerms && !model.authBusy
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                OnbBackBar { model.back() }

                Text("Welcome to klove").font(.kloveTitle).foregroundStyle(Theme.ink)
                Text("Let's get your account set up.").font(.kloveBody).foregroundStyle(Theme.inkSecondary)

                OnbField(label: "Email") {
                    TextField("Enter your email", text: $model.email)
                        .focused($emailFocused)
                        .keyboardType(.emailAddress).textContentType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.kloveBody).foregroundStyle(Theme.ink)
                }
                .padding(.top, 4)

                // Terms agreement
                HStack(alignment: .top, spacing: 12) {
                    Button { model.agreedToTerms.toggle() } label: {
                        Image(systemName: model.agreedToTerms ? "checkmark.square.fill" : "square")
                            .font(.system(size: 24)).foregroundStyle(model.agreedToTerms ? Theme.accent : Theme.inkSecondary)
                    }
                    .buttonStyle(.plain)
                    VStack(alignment: .leading, spacing: 6) {
                        (Text("I agree to Klove's ")
                         + Text("Terms of Service").underline()
                         + Text(" and ")
                         + Text("Privacy Policy").underline()
                         + Text(". I understand that Klove helps coordinate care and does not provide medical advice."))
                            .font(.kloveCaption).foregroundStyle(Theme.ink)
                        Text("Your data is encrypted and never sold.").font(.kloveCaption.italic()).foregroundStyle(Theme.inkSecondary)
                    }
                }

                if let error = model.identifyError {
                    Text(error).font(.kloveCaption).foregroundStyle(.red)
                }

                if model.magicLinkSent {
                    Text("Enter the 6-digit code we emailed to \(model.email).")
                        .font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                    TextField("123456", text: $model.code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 26, weight: .semibold, design: .monospaced))
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.hairline, lineWidth: 1))
                    Button { Task { await model.verifyCode() } } label: {
                        if model.authBusy { ProgressView().tint(Theme.background) } else { Text("Verify code") }
                    }
                    .buttonStyle(OnbButtonStyle(enabled: model.code.trimmingCharacters(in: .whitespaces).count >= 6))
                    .disabled(model.code.trimmingCharacters(in: .whitespaces).count < 6)
                    Button("Resend code") { Task { await model.continueWithMagicLink() } }
                        .font(.kloveCaption).foregroundStyle(Theme.accent).padding(.top, 2)
                } else {
                    Button { Task { await model.continueWithMagicLink() } } label: {
                        if model.authBusy { ProgressView().tint(Theme.background) } else { Text("Continue with email") }
                    }
                    .buttonStyle(OnbButtonStyle(enabled: canContinue))
                    .disabled(!canContinue)
                    .padding(.top, 4)
                }

                OnbOrDivider()

                SignInWithAppleButton(.continue) { AuthService.shared.configure($0) }
                    onCompletion: { AuthService.shared.handle($0) }
                    .signInWithAppleButtonStyle(.whiteOutline)
                    .frame(height: 54).clipShape(Capsule())

                Button { Task { await AuthService.shared.signInWithGoogle() } } label: {
                    HStack(spacing: 8) {
                        Text("G").font(.system(size: 17, weight: .bold, design: .serif)).foregroundStyle(Theme.inkSecondary)
                        Text("Continue with Google").font(.kloveButton).foregroundStyle(Theme.ink)
                    }
                    .frame(maxWidth: .infinity).frame(height: 54)
                    .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)

                if let authError = AuthService.shared.errorMessage, model.identifyError == nil {
                    Text(authError).font(.kloveCaption).foregroundStyle(.red)
                }
            }
            .padding(.horizontal, OnbStyle.hMargin).padding(.top, 8).padding(.bottom, 24)
        }
    }
}

// MARK: - 3 · About You

private struct AboutYouStep: View {
    @Bindable var model: OnboardingModel
    @State private var showDOB = false
    @State private var tempDOB = Calendar.current.date(byAdding: .year, value: -40, to: Date()) ?? Date()

    private var dobText: String {
        guard let d = model.birthDate else { return "DD/MM/YYYY" }
        let f = DateFormatter(); f.dateFormat = "dd/MM/yyyy"; return f.string(from: d)
    }

    var body: some View {
        VStack(spacing: 0) {
            OnbProgress(title: "About You", step: 1) { model.back() }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    OnbDisplay(line1: "First, a little", line2: "about you.")
                        .padding(.top, 24)
                    Text("We'll use these details to personalize your experience and help organize your records.")
                        .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 12)

                    OnbField(label: "Full name") {
                        TextField("Your name", text: $model.fullName)
                            .textContentType(.name).textInputAutocapitalization(.words)
                            .font(.kloveBody).foregroundStyle(Theme.ink)
                    }
                    .padding(.top, 28)

                    Button { tempDOB = model.birthDate ?? tempDOB; showDOB = true } label: {
                        OnbField(label: "Date of birth") {
                            Text(dobText).font(.kloveBody)
                                .foregroundStyle(model.birthDate == nil ? Theme.inkSecondary : Theme.ink)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 12)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, OnbStyle.hMargin)
            }

            Button { Task { await model.saveAboutYouAndAdvance() } } label: {
                if model.savingProfile { ProgressView().tint(Theme.background) } else { Text("Continue") }
            }
            .buttonStyle(OnbButtonStyle(enabled: model.aboutYouComplete && !model.savingProfile))
            .disabled(!model.aboutYouComplete || model.savingProfile)
            .padding(.horizontal, OnbStyle.hMargin).padding(.bottom, 8)
        }
        .sheet(isPresented: $showDOB) {
            NavigationStack {
                DatePicker("Date of birth", selection: $tempDOB, in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.graphical).labelsHidden().padding()
                    .navigationTitle("Date of birth").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { model.birthDate = tempDOB; showDOB = false }
                        }
                    }
                    .tint(Theme.accent)
            }
            .presentationDetents([.medium])
        }
    }
}

// MARK: - 4 · Your Care Circle

private struct CareCircleStep: View {
    @Bindable var model: OnboardingModel
    @State private var showAdd = false
    @State private var pendingInvite: AddMemberResponse?

    var body: some View {
        VStack(spacing: 0) {
            OnbProgress(title: "Your Care Circle", step: 2) { model.back() }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    OnbDisplay(line1: "Who else", line2: "do you care for?")
                        .padding(.top, 24)
                    Text("Add people whose health you help manage. You can always come back later.")
                        .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 12)

                    VStack(spacing: Theme.Spacing.md) {
                        ForEach(model.store.members) { m in
                            CareCircleRow(member: m, age: m.memberType == "self" ? model.operatorAge : nil)
                        }
                        Button { showAdd = true } label: { addMemberRow }.buttonStyle(.plain)
                    }
                    .padding(.top, 28)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, OnbStyle.hMargin)
            }

            VStack(spacing: 14) {
                Button("Continue") { model.advance() }.buttonStyle(OnbButtonStyle())
                Button("Skip") { model.advance() }.font(.kloveBodyStrong).foregroundStyle(Theme.ink)
            }
            .padding(.horizontal, OnbStyle.hMargin).padding(.bottom, 8)
        }
        .task { if model.store.members.isEmpty { await model.store.load() } }
        .sheet(isPresented: $showAdd, onDismiss: {
            if let adult = pendingInvite { pendingInvite = nil }
            Task { await model.store.load() }
        }) {
            AddMemberView(onInvite: { pendingInvite = $0 }).environment(model.store)
        }
        .sheet(item: $pendingInvite) { adult in
            InviteMemberView(memberId: adult.userId, memberName: adult.displayName ?? "this member").environment(model.store)
        }
    }

    private var addMemberRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "plus").font(.system(size: 18, weight: .medium)).foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44).overlay(Circle().stroke(Theme.hairline, lineWidth: 1))
            Text("Add a member").font(.kloveBodyStrong).foregroundStyle(Theme.ink)
            Spacer()
        }
        .padding(Theme.Spacing.lg)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
    }
}

private struct CareCircleRow: View {
    let member: HouseholdMember
    let age: Int?

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(kloveInitials(member.name))
                .font(.system(size: 18, design: .serif)).foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44).overlay(Circle().stroke(Theme.hairline, lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                Text(subtitle).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(Theme.inkSecondary).frame(width: 6, height: 6)
                Text(statusLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Theme.surfaceSunken, in: Capsule())
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        .kloveCard()
    }

    private var subtitle: String {
        if member.memberType == "self" { return age.map { "You · \($0)" } ?? "You" }
        switch member.memberType {
        case "minor": return "Child · you manage"
        case "aging_parent": return "Parent · delegated"
        default: return member.consent == "pending" ? "Invite pending" : "Adult · shared"
        }
    }
    private var statusLabel: String {
        switch member.consent {
        case "pending": return "Pending"
        case "revoked": return "Revoked"
        default: return "Active"
        }
    }
}

// MARK: - 5 · Notifications

private struct NotificationsStep: View {
    @Bindable var model: OnboardingModel

    var body: some View {
        VStack(spacing: 0) {
            OnbProgress(title: "Notifications", step: 3) { model.back() }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    OnbDisplay(line1: "How should", line2: "I reach you?")
                        .padding(.top, 24)
                    Text("Choose how you'd like to receive important updates. We only reach out when something needs your attention. Your information stays private and is never sold.")
                        .font(.kloveBody).foregroundStyle(Theme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 12)

                    VStack(spacing: 0) {
                        channelRow("Push notifications", "Pushed to your device immediately", $model.pushEnabled)
                        channelRow("Text Messages", "Messages sent to your phone", $model.textEnabled)
                        whatsAppRow
                        channelRow("Email", "Messages sent to your inbox", $model.emailEnabled)
                    }
                    .padding(.top, 28)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, OnbStyle.hMargin)
            }

            Button { Task { await model.finishWithNotifications() } } label: {
                if model.savingProfile { ProgressView().tint(Theme.background) } else { Text("Done") }
            }
            .buttonStyle(OnbButtonStyle())
            .disabled(model.savingProfile)
            .padding(.horizontal, OnbStyle.hMargin).padding(.bottom, 8)
        }
    }

    private func channelRow(_ title: String, _ subtitle: String, _ isOn: Binding<Bool>) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                Text(subtitle).font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            }
            Spacer()
            Text(isOn.wrappedValue ? "On" : "Off").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
            Toggle("", isOn: isOn).labelsHidden().tint(Theme.accent)
        }
        .padding(.vertical, 14)
    }

    /// WhatsApp is the agentic channel: turning it on reveals a phone field that enrolls the number
    /// (POST /whatsapp/enroll) so the concierge agent can take over once the user replies YES.
    private var whatsAppRow: some View {
        let bind = Binding(
            get: { model.whatsappEnabled },
            set: { on in
                model.whatsappEnabled = on
                if !on { model.disconnectWhatsApp() }
            }
        )
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("WhatsApp").font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                    Text("Messages through WhatsApp").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                }
                Spacer()
                Text(model.whatsappEnabled ? "On" : "Off").font(.kloveCaption).foregroundStyle(Theme.inkSecondary)
                Toggle("", isOn: bind).labelsHidden().tint(Theme.accent)
            }

            if model.whatsappEnabled {
                if model.whatsappEnroll == .sent {
                    Label("We messaged you on WhatsApp. Reply YES to connect.", systemImage: "checkmark.circle")
                        .font(.kloveCaption).foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                } else {
                    HStack(spacing: Theme.Spacing.sm) {
                        TextField("+1 (555) 123-4567", text: $model.whatsappPhone)
                            .keyboardType(.phonePad).textContentType(.telephoneNumber)
                            .font(.kloveBody).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 14).padding(.vertical, 11)
                            .background(Theme.surface, in: Capsule())
                            .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
                        Button { Task { await model.connectWhatsApp() } } label: {
                            if model.whatsappEnroll == .enrolling {
                                ProgressView().tint(Theme.background).frame(width: 76, height: 42)
                            } else {
                                Text("Connect").font(.kloveButton).foregroundStyle(Theme.background)
                                    .frame(width: 76, height: 42)
                            }
                        }
                        .background(Theme.accent, in: Capsule())
                        .disabled(model.whatsappEnroll == .enrolling)
                    }
                    if case .failed(let msg) = model.whatsappEnroll {
                        Text(msg).font(.kloveCaption).foregroundStyle(.red)
                    }
                }
            }
        }
        .padding(.vertical, 14)
    }
}

// MARK: - Shared onboarding building blocks

private enum OnbStyle { static let hMargin: CGFloat = 24 }

/// Full-width ink capsule CTA; renders a flat grey when disabled (the Figma "inactive" state).
private struct OnbButtonStyle: ButtonStyle {
    var enabled: Bool = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.kloveButton).foregroundStyle(Theme.background)
            .frame(maxWidth: .infinity).padding(.vertical, 18)
            .background(enabled ? Theme.accent : Theme.inkSecondary, in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Field shell: tracked-caps label above an inset value/control, on a white rounded card.
private struct OnbField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.kloveLabel).textCase(.uppercase).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
            content
        }
        .padding(.horizontal, 18).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
    }
}

/// Two-line serif display heading (line 2 italic grey) used on every detail step.
private struct OnbDisplay: View {
    let line1: String
    let line2: String
    var body: some View {
        VStack(alignment: .leading, spacing: -2) {
            Text(line1).font(.kloveTitle).foregroundStyle(Theme.ink)
            Text(line2).font(.kloveTitleItalic).foregroundStyle(Theme.inkSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Centered step title + "STEP X OF 3" + a three-segment progress bar, with a back chevron.
private struct OnbProgress: View {
    let title: String
    let step: Int
    var onBack: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                VStack(spacing: 2) {
                    Text(title).font(.kloveBodyStrong).foregroundStyle(Theme.ink)
                    Text("STEP \(step) OF 3").font(.system(size: 11, weight: .semibold)).tracking(1.2).foregroundStyle(Theme.inkSecondary)
                }
                HStack {
                    Button(action: onBack) { Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium)).foregroundStyle(Theme.ink) }
                    Spacer()
                }
            }
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { i in
                    Capsule().fill(i < step ? Theme.accent : Theme.ink.opacity(0.12)).frame(height: 5)
                }
            }
        }
        .padding(.horizontal, OnbStyle.hMargin).padding(.top, 8)
    }
}

/// A bare back chevron bar (welcome/identify don't show the step progress).
private struct OnbBackBar: View {
    var onBack: () -> Void
    var body: some View {
        HStack {
            Button(action: onBack) { Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium)).foregroundStyle(Theme.ink) }
            Spacer()
        }
    }
}

/// Paged carousel dots — active dot is an elongated ink capsule.
private struct OnbDots: View {
    let count: Int
    let current: Int
    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { i in
                Capsule().fill(i == current ? Theme.accent : Theme.ink.opacity(0.18))
                    .frame(width: i == current ? 22 : 7, height: 7)
            }
        }
    }
}

/// "OR" divider with hairlines.
private struct OnbOrDivider: View {
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
            Text("OR").font(.kloveLabel).tracking(Theme.Tracking.label).foregroundStyle(Theme.inkSecondary)
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        .padding(.vertical, 4)
    }
}
