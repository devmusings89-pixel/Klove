/**
 * Live, read-only test of the deterministic patientsreach gather (#1+#2): walk the funnel and scan
 * the calendar for Saturdays. Navigation only — never books. Run:
 *   npx tsx scripts/test-patientsreach-gather.ts
 */
import { WebSession } from "../src/channels/web-session.js";
import { patientsreachAdapter } from "../src/channels/adapters/patientsreach.js";
import type { BookingContext } from "../src/channels/types.js";

const URL = "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/";

const ctx: BookingContext = {
  target: { website: URL } as any,
  session: {} as any,
  patient: {
    name: "Prakash Ahuja", dob: "1984-09-28", reason: "cleaning", insurance: "",
    preferredTimes: "Saturdays", acceptableWindow: "Saturday", additionalInfo: "",
    patientPhone: "2063518641", patientEmail: "prakashahuja.84@gmail.com", patientStatus: "existing",
  },
  mode: "gather",
};

const session = new WebSession();
try {
  await session.start(URL);
  const result = await patientsreachAdapter.run(session, ctx);
  console.log("\n=== GATHER RESULT ===");
  console.log("outcome:", result.outcome);
  console.log("acceptableSlots (Saturdays):", result.acceptableSlots);
  console.log("offeredSlots (first 8):", result.offeredSlots?.slice(0, 8));
  console.log("summary:", result.summary);
} catch (e) {
  console.error("ERROR:", (e as Error).message);
} finally {
  await session.close();
}
process.exit(0);
