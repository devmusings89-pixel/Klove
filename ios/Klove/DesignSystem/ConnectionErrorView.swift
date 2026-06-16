import SwiftUI

/// Shown when a screen can't reach the Klove backend — so the app never silently goes blank.
struct ConnectionErrorView: View {
    var message: String?
    var retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 38))
                .foregroundStyle(Theme.inkSecondary)
                .padding(.top, 50)
            Text("Couldn't reach Klove")
                .font(.headline).foregroundStyle(Theme.ink)
            Text(message ?? "Check that the Klove backend is running, then try again.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                .multilineTextAlignment(.center).padding(.horizontal, 32)
            Button { retry() } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 22).padding(.vertical, 11)
                    .background(Theme.accent, in: Capsule())
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }
}
