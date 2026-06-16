import Foundation
import UIKit

/// Backs the "My Info" profile + insurance vault. Loads the saved profile, edits demographics and
/// insurance, and applies on-device card-scan results into the editable fields.
@MainActor
@Observable
final class ProfileModel {
    // Demographics
    var fullName = ""
    var dob = ""
    var phone = ""
    var email = UserDefaults.standard.string(forKey: AppStorageKey.userEmail) ?? ""
    var address = ""

    // Insurance
    var carrier = ""
    var planName = ""
    var memberId = ""
    var groupId = ""
    var rxBin = ""
    var rxPcn = ""
    var holderName = ""

    var isLoading = false
    var isSaving = false
    var isScanning = false // OCR in flight
    var savedConfirmation = false
    var errorMessage: String?

    private let api = APIClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            guard let p = try await api.getProfile() else { return }
            fullName = p.fullName
            dob = p.dob ?? ""
            phone = p.phone ?? ""
            email = p.email ?? email
            address = p.address ?? ""
            if let i = p.insurance {
                carrier = i.carrier ?? ""
                planName = i.planName ?? ""
                memberId = i.memberId ?? ""
                groupId = i.groupId ?? ""
                rxBin = i.rxBin ?? ""
                rxPcn = i.rxPcn ?? ""
                holderName = i.holderName ?? ""
            }
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    func save() async {
        guard !fullName.trimmingCharacters(in: .whitespaces).isEmpty else {
            errorMessage = "Please enter your name."
            return
        }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await api.putProfile(fullName: fullName, dob: nilIfEmpty(dob), phone: nilIfEmpty(phone), email: nilIfEmpty(email), address: nilIfEmpty(address))
            let info = InsuranceInfo(
                carrier: nilIfEmpty(carrier), planName: nilIfEmpty(planName), memberId: nilIfEmpty(memberId),
                groupId: nilIfEmpty(groupId), rxBin: nilIfEmpty(rxBin), rxPcn: nilIfEmpty(rxPcn), holderName: nilIfEmpty(holderName)
            )
            if !info.isEmpty { try await api.putInsurance(info) }
            savedConfirmation = true
        } catch {
            errorMessage = (error as? AppError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Run on-device OCR on the scanned card and fill the (still editable) insurance fields.
    func applyScan(_ images: [UIImage]) {
        isScanning = true
        Task {
            let info = await InsuranceOCR.extract(from: images)
            await MainActor.run {
                if let v = info.carrier, !v.isEmpty { carrier = v }
                if let v = info.planName, !v.isEmpty { planName = v }
                if let v = info.memberId, !v.isEmpty { memberId = v }
                if let v = info.groupId, !v.isEmpty { groupId = v }
                if let v = info.rxBin, !v.isEmpty { rxBin = v }
                if let v = info.rxPcn, !v.isEmpty { rxPcn = v }
                isScanning = false
            }
        }
    }

    private func nilIfEmpty(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }
}
