import SwiftUI
import VisionKit
import Vision

/// On-device insurance-card capture (VisionKit document scanner) + text recognition (Vision).
/// Everything runs locally; the raw image is never uploaded or saved to the photo library — only
/// the parsed, user-confirmed fields are sent to the backend.
struct DocumentScanner: UIViewControllerRepresentable {
    var onScan: ([UIImage]) -> Void
    var onCancel: () -> Void

    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentScanner
        init(_ parent: DocumentScanner) { self.parent = parent }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            var images: [UIImage] = []
            for i in 0..<scan.pageCount { images.append(scan.imageOfPage(at: i)) }
            parent.onScan(images)
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.onCancel() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { parent.onCancel() }
    }
}

/// Recognize text from scanned card images and parse insurance fields (best-effort; user confirms).
enum InsuranceOCR {
    static func extract(from images: [UIImage]) async -> InsuranceInfo {
        var lines: [String] = []
        for image in images { lines += await recognize(image) }
        return parse(lines)
    }

    private static func recognize(_ image: UIImage) async -> [String] {
        guard let cg = image.cgImage else { return [] }
        return await withCheckedContinuation { (cont: CheckedContinuation<[String], Never>) in
            let request = VNRecognizeTextRequest { req, _ in
                let obs = (req.results as? [VNRecognizedTextObservation]) ?? []
                cont.resume(returning: obs.compactMap { $0.topCandidates(1).first?.string })
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            let handler = VNImageRequestHandler(cgImage: cg, options: [:])
            DispatchQueue.global(qos: .userInitiated).async { try? handler.perform([request]) }
        }
    }

    private static let knownCarriers = [
        "UnitedHealthcare", "United Healthcare", "Blue Cross Blue Shield", "Blue Cross", "Blue Shield",
        "BCBS", "Aetna", "Cigna", "Kaiser Permanente", "Kaiser", "Humana", "Anthem", "Oscar",
        "Molina", "Centene", "Medicare", "Medicaid",
    ]

    static func parse(_ lines: [String]) -> InsuranceInfo {
        var info = InsuranceInfo()
        let joined = lines.joined(separator: "\n")
        info.carrier = knownCarriers.first { joined.range(of: $0, options: .caseInsensitive) != nil }
        info.memberId = value(forLabels: ["member id", "member #", "subscriber id", "id #", "id:"], in: lines)
            ?? value(forLabels: ["member", "subscriber"], in: lines)
        info.groupId = value(forLabels: ["group number", "group #", "group no", "group id", "grp", "group"], in: lines)
        info.rxBin = value(forLabels: ["rx bin", "rxbin", "bin"], in: lines)
        info.rxPcn = value(forLabels: ["rx pcn", "rxpcn", "pcn"], in: lines)
        info.planName = value(forLabels: ["plan", "ppo", "hmo", "epo"], in: lines)
        return info
    }

    /// Find a value for a labeled field: same-line after the label, else the next line's first token.
    private static func value(forLabels labels: [String], in lines: [String]) -> String? {
        for (idx, line) in lines.enumerated() {
            let low = line.lowercased()
            guard let label = labels.first(where: { low.contains($0) }) else { continue }
            // Same line: text after the label (or after a colon).
            if let range = low.range(of: label) {
                let after = String(line[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: " :#-"))
                if let tok = firstToken(after) { return tok }
            }
            // Next line.
            if idx + 1 < lines.count, let tok = firstToken(lines[idx + 1]) { return tok }
        }
        return nil
    }

    /// First plausible ID-like token (alphanumeric, length ≥ 4).
    private static func firstToken(_ s: String) -> String? {
        let tokens = s.split { $0 == " " || $0 == "\t" }.map(String.init)
        return tokens.first { tok in
            let alnum = tok.filter { $0.isLetter || $0.isNumber }
            return alnum.count >= 4 && alnum.rangeOfCharacter(from: .decimalDigits) != nil
        }
    }
}
