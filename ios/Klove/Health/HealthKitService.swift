import Foundation
import HealthKit

/// Reads health data from Apple Health and pushes it to the backend for normalization.
/// Onboarding only needs `requestAuthorization`; `syncClinicalRecords` is the Phase-2 hook that
/// streams FHIR clinical records (HKClinicalRecord.fhirResource) up to POST /sources/healthkit/sync.
@MainActor
final class HealthKitService {
    private let store = HKHealthStore()
    private let api = APIClient()

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Quantity/category types we read for vitals & labs (work on simulator without special access).
    private var sampleReadTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()
        let quantityIds: [HKQuantityTypeIdentifier] = [
            .bloodGlucose, .heartRate, .bodyMass, .height,
            .bloodPressureSystolic, .bloodPressureDiastolic, .stepCount, .oxygenSaturation,
        ]
        for id in quantityIds { if let t = HKQuantityType.quantityType(forIdentifier: id) { types.insert(t) } }
        return types
    }

    /// Clinical (FHIR) record types — gated by the Health Records entitlement; ignored if unavailable.
    private var clinicalReadTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()
        let clinicalIds: [HKClinicalTypeIdentifier] = [
            .labResultRecord, .conditionRecord, .medicationRecord, .allergyRecord, .immunizationRecord,
        ]
        for id in clinicalIds { if let t = HKObjectType.clinicalType(forIdentifier: id) { types.insert(t) } }
        return types
    }

    /// Present the Health authorization sheet for the types we read. Returns false if HealthKit is absent.
    func requestAuthorization() async throws -> Bool {
        guard Self.isAvailable else { return false }
        let read = sampleReadTypes.union(clinicalReadTypes)
        try await store.requestAuthorization(toShare: [], read: read)
        return true
    }

    /// Read available FHIR clinical records and push them to the backend. Best-effort.
    func syncClinicalRecords() async throws {
        guard Self.isAvailable else { return }
        var fhirJson: [String] = []
        for type in clinicalReadTypes.compactMap({ $0 as? HKClinicalType }) {
            let records = try await clinicalRecords(of: type)
            for record in records {
                if let data = record.fhirResource?.data, let json = String(data: data, encoding: .utf8) {
                    fhirJson.append(json)
                }
            }
        }
        guard !fhirJson.isEmpty else { return }
        try await api.syncHealthKit(resources: fhirJson)
    }

    private func clinicalRecords(of type: HKClinicalType) async throws -> [HKClinicalRecord] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: nil, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: (samples as? [HKClinicalRecord]) ?? []) }
            }
            store.execute(query)
        }
    }
}
