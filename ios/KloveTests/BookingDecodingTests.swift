import XCTest
@testable import Klove

/// Decoding + small-logic tests for the booking flow's API contracts. These are pure (no network/UI),
/// so they run fast in Xcode. Generate the project first: `xcodegen generate`, then run the KloveTests
/// scheme (⌘U).
final class BookingDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testBookingPlanReadyDecodes() throws {
        let json = """
        {"status":"ready","reason":"dermatologist","provider":{"id":"p1","name":"Glow Dermatology","phone":"+12065551212","website":null,"address":null,"specialty":"dermatologist","source":"directory"},"candidates":[],"missing":["insurance"],"patientName":"Khushboo","insuranceLabel":"","preferredTimes":"","recap":"Book dermatologist for Khushboo with Glow Dermatology."}
        """
        let plan = try decode(BookingPlan.self, json)
        XCTAssertTrue(plan.isReady)
        XCTAssertEqual(plan.provider?.name, "Glow Dermatology")
        XCTAssertEqual(plan.provider?.id, "p1")
        XCTAssertEqual(plan.missing, ["insurance"])
    }

    func testBookingPlanNeedsProviderDecodes() throws {
        let json = """
        {"status":"needs_provider","reason":"dermatologist","provider":null,"candidates":[{"id":"c1","name":"Some Dental Office","phone":"+1","website":null,"address":null,"specialty":"dentist","source":"manual"}],"missing":[],"patientName":"Khushboo","insuranceLabel":"","preferredTimes":"","recap":"Pick a provider to book dermatologist for Khushboo."}
        """
        let plan = try decode(BookingPlan.self, json)
        XCTAssertFalse(plan.isReady)
        XCTAssertNil(plan.provider)
        XCTAssertEqual(plan.candidates.count, 1)
        XCTAssertEqual(plan.candidates.first?.name, "Some Dental Office")
    }

    func testPlanProviderIdFallsBackToName() throws {
        // A Places match has no id; Identifiable should fall back to the name so it's usable in ForEach.
        let json = """
        {"name":"Walk-in Clinic","phone":null,"website":null,"address":null,"specialty":null,"source":"places"}
        """
        let p = try decode(PlanProvider.self, json)
        XCTAssertNil(p.providerId)
        XCTAssertEqual(p.id, "Walk-in Clinic")
    }

    func testBookingOutcomeStatusHelpers() throws {
        let inProgress = try decode(BookingOutcome.self, """
        {"status":"in_progress","title":"dermatologist","provider":"Glow","taskId":"t1","verified":true}
        """)
        XCTAssertTrue(inProgress.isInProgress)
        XCTAssertFalse(inProgress.isConfirmed)
    }
}
