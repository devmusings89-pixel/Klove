import SwiftUI
import AuthenticationServices

/// Shown when the user has completed onboarding but has no valid session — i.e. no Supabase JWT (the
/// token was never obtained, was cleared, or expired). The production backend requires a real JWT, so
/// we must re-authenticate before the app can load anything. This replaces the old behavior where a
/// 401 surfaced as a misleading "Couldn't reach Klove" with no way to recover.
struct ReAuthView: View {
    @State private var auth = AuthService.shared
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Spacer().frame(height: 32)
                Text("Welcome back").font(.largeTitle.weight(.bold)).foregroundStyle(Theme.ink)
                Text("Sign in to reconnect to Klove.").font(.subheadline).foregroundStyle(Theme.inkSecondary)

                SignInWithAppleButton(.continue) { AuthService.shared.configure($0) }
                    onCompletion: { AuthService.shared.handle($0) }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 54).clipShape(Capsule()).padding(.top, 8)

                Button { Task { await AuthService.shared.signInWithGoogle() } } label: {
                    HStack(spacing: 8) {
                        Text("G").font(.system(size: 17, weight: .bold, design: .serif)).foregroundStyle(Theme.inkSecondary)
                        Text("Continue with Google").font(.kloveButton).foregroundStyle(Theme.ink)
                    }
                    .frame(maxWidth: .infinity).frame(height: 54)
                    .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)

                if let err = auth.errorMessage, !err.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.red)
                }

                Divider().padding(.vertical, 6)

                TextField("Email", text: $email)
                    .focused($focused)
                    .keyboardType(.emailAddress).textContentType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(12).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .padding(12).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))

                Button { Task { busy = true; _ = await auth.signInWithEmail(email.trimmingCharacters(in: .whitespaces), password); busy = false } } label: {
                    HStack { if busy { ProgressView().tint(.white) } else { Text("Sign in").font(.kloveButton) } }
                        .frame(maxWidth: .infinity).frame(height: 52)
                        .background(Theme.accent, in: Capsule()).foregroundStyle(.white)
                }
                .disabled(busy || email.isEmpty || password.isEmpty)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.background.ignoresSafeArea())
    }
}
