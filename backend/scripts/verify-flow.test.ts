/**
 * Tests the patient-in-the-loop verification (#3) state machine end-to-end WITHOUT a live site:
 * a fake held browser session + adapter stand in for the real one. Asserts that submitting a code
 * resumes the held session, books, and completes the session.
 * Run: npm run dev:env -- scripts/verify-flow.test.ts   (or: node --env-file=.env --import tsx scripts/verify-flow.test.ts)
 */
import assert from "node:assert";
import { prisma } from "../src/db.js";
import { holdSession } from "../src/channels/session-hold.js";
import { submitVerification } from "../src/services/orchestrator.js";
import { toJson } from "../src/services/json.js";

const VERIFICATION_ID = "test-verif-" + Math.floor(Number(process.hrtime.bigint() % 1000000n));
let closed = false;

const fakeSession = { close: async () => { closed = true; } } as any;
const fakeAdapter = {
  name: "fake",
  matches: () => true,
  run: async () => ({ outcome: "verification_needed" as const, summary: "needs code" }),
  submitVerification: async (_s: unknown, _c: unknown, code: string) => {
    assert.equal(code, "482913", "adapter received the code the patient entered");
    return { outcome: "booked" as const, appointmentDateTime: "SAT Oct 3, 10:30 AM", confirmation: "ABC123", summary: "Confirmed." };
  },
} as any;

async function main() {
  const user = await prisma.user.upsert({ where: { email: "verif-test@example.com" }, create: { email: "verif-test@example.com" }, update: {} });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      status: "awaiting_verification",
      patientInfo: toJson({ name: "Test Patient", dob: "1984-09-28", reason: "cleaning" }),
      maxCalls: 3,
      minutesCap: 30,
      stopWhenBooked: true,
      targets: {
        create: [{
          officeName: "Avondale Smiles",
          website: "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/",
          channel: "web",
          status: "awaiting_verification",
          chosenSlot: "SAT Oct 3, 10:30 AM",
          verificationId: VERIFICATION_ID,
          verificationContact: "your email",
          order: 0,
        }],
      },
    },
    include: { targets: true },
  });
  const target = session.targets[0];

  // Hold a fake browser session under the same id the target carries.
  holdSession(VERIFICATION_ID, { session: fakeSession, adapter: fakeAdapter, ctx: { target, session, patient: {} as any, mode: "book", chosenSlot: target.chosenSlot ?? undefined } });

  // Patient submits the code → resume → book → complete.
  await submitVerification(target.id, "482913");

  const t = await prisma.callTarget.findUnique({ where: { id: target.id } });
  const s = await prisma.session.findUnique({ where: { id: session.id } });
  assert.equal(t?.status, "booked", "target should be booked after verification");
  assert.equal(s?.status, "completed", "session should complete after the only office books");
  assert.equal(closed, true, "held browser session should be closed after resume");
  const results = await prisma.callResult.findMany({ where: { callTargetId: target.id } });
  assert.ok(results.some((r) => r.phase === "book"), "a book-phase result should be recorded");

  // Cleanup.
  await prisma.callResult.deleteMany({ where: { callTargetId: target.id } });
  await prisma.callTarget.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.delete({ where: { id: session.id } });

  console.log("✅ verification flow: code → resume held session → booked → session completed");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
