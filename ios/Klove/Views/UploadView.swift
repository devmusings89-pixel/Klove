import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Add a health document: photo library, camera, or a file (PDF). Uploads and shows extraction status.
struct UploadView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model = UploadModel()
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var showCamera = false

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .idle: chooser
                case .uploading: progress("Uploading…")
                case .processing: progress("Reading your document…")
                case .done(let status): result(status)
                case .failed(let message): failure(message)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Add a record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    await model.upload(data: data, mimeType: "image/jpeg", filename: "photo-\(shortID).jpg")
                }
            }
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .image]) { result in
            guard case .success(let url) = result else { return }
            Task { await uploadFile(url) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { data in
                Task { await model.upload(data: data, mimeType: "image/jpeg", filename: "scan-\(shortID).jpg") }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: - States

    private var chooser: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.viewfinder")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Add a lab result, after-visit summary, or any health document.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)

            PhotosPicker(selection: $photoItem, matching: .images) {
                ChooserLabel(icon: "photo.on.rectangle", text: "Choose from Photos")
            }
            if CameraPicker.isAvailable {
                Button { showCamera = true } label: {
                    ChooserLabel(icon: "camera.fill", text: "Take a photo")
                }
            }
            Button { showFileImporter = true } label: {
                ChooserLabel(icon: "folder.fill", text: "Choose a file (PDF)")
            }
        }
    }

    private func progress(_ text: String) -> some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large)
            Text(text).foregroundStyle(.secondary)
        }
    }

    private func result(_ status: DocumentStatus) -> some View {
        VStack(spacing: 16) {
            Image(systemName: icon(for: status.status))
                .font(.system(size: 56))
                .foregroundStyle(color(for: status.status))
            Text(title(for: status.status)).font(.title3.bold())
            if let summary = status.lastJob?.summary {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button("Add another") { model.reset(); photoItem = nil }
                .buttonStyle(.bordered)
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48)).foregroundStyle(Theme.needsYou)
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Try again") { model.reset(); photoItem = nil }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Helpers

    private var shortID: String { String(UUID().uuidString.prefix(8)) }

    private func uploadFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            model.phase = .failed("Couldn't read that file.")
            return
        }
        let isPDF = url.pathExtension.lowercased() == "pdf"
        await model.upload(data: data,
                           mimeType: isPDF ? "application/pdf" : "image/jpeg",
                           filename: url.lastPathComponent)
    }

    private func title(for status: String) -> String {
        switch status {
        case "extracted": return "Added to your records"
        case "skipped_non_health": return "No health data found"
        case "failed": return "Couldn't process this"
        default: return "Still processing"
        }
    }
    private func icon(for status: String) -> String {
        switch status {
        case "extracted": return "checkmark.circle.fill"
        case "skipped_non_health": return "questionmark.circle.fill"
        case "failed": return "xmark.circle.fill"
        default: return "clock.fill"
        }
    }
    private func color(for status: String) -> Color {
        switch status {
        case "extracted": return .green
        case "failed": return .red
        default: return .orange
        }
    }
}

private struct ChooserLabel: View {
    let icon: String
    let text: String

    var body: some View {
        HStack {
            Image(systemName: icon)
            Text(text).fontWeight(.medium)
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}
