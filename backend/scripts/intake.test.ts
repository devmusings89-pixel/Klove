/**
 * Tests the NL booking intake (WS1): phrase → BookingDraft, slot-filling, and provider matching
 * from past appointments. Runs in mock-parse mode (no ANTHROPIC key needed).
 * Run: npx tsx --env-file=.env scripts/intake.test.ts
 */
import assert from "node:assert";
import { prisma } from "../src/db.js";
import { parseBookingIntent } from "../src/services/intake.js";

async function main() {
  const user = await prisma.user.upsert({ where: { email: "intake-test@example.com" }, create: { email: "intake-test@example.com" }, update: {} });
  // Seed a past dental appointment so it becomes a reusable provider candidate.
  const appt = await prisma.appointment.create({
    data: { userId: user.id, sourceType: "gmail", title: "Dental cleaning", provider: "Bright Smile Dental", location: "Brooklyn, NY", startsAt: new Date("2026-01-10T15:00:00Z"), status: "completed" },
  });
  const appts = await prisma.appointment.findMany({ where: { userId: user.id } });

  // 1) Known provider → matched candidate, ready to book.
  const d1 = await parseBookingIntent("book me a dentist visit", appts);
  assert.equal(d1.specialty, "dentist", "specialty extracted");
  assert.ok(d1.providerCandidates.some((c) => c.officeName === "Bright Smile Dental"), "past dental provider surfaced as candidate");
  assert.equal(d1.readyToBook, true, "ready once a provider candidate exists");
  console.log("1) 'dentist visit' →", d1.specialty, "| candidate:", d1.providerCandidates[0]?.officeName, "| ready:", d1.readyToBook);

  // 2) No known providers → must ask WHERE.
  const d2 = await parseBookingIntent("book me a dermatologist", []);
  assert.equal(d2.specialty, "dermatologist", "derm specialty extracted");
  assert.ok(d2.missingSlots.includes("where"), "asks where when no provider/location/candidate");
  assert.ok(d2.nextQuestion, "has a next question");
  console.log("2) 'dermatologist' (no history) → missing:", d2.missingSlots, "| asks:", JSON.stringify(d2.nextQuestion));

  // 3) Specialty + location in one phrase → ready, timing captured.
  const d3 = await parseBookingIntent("find me a dentist near Manhattan, saturday mornings", []);
  assert.equal(d3.readyToBook, true, "ready with specialty + location");
  assert.ok((d3.location ?? "").length > 0, "location captured");
  assert.match(d3.preferredTimes ?? "", /weekend|morning/i, "timing captured");
  console.log("3) 'dentist near Manhattan, sat mornings' → location:", JSON.stringify(d3.location), "| times:", JSON.stringify(d3.preferredTimes), "| ready:", d3.readyToBook);

  // 4) Multi-turn: vague first, refine next (draft persists slots).
  const t1 = await parseBookingIntent("I need to see someone", []);
  assert.ok(t1.missingSlots.includes("what"), "asks what when nothing given");
  const t2 = await parseBookingIntent("a dentist, near Brooklyn", [], t1);
  assert.equal(t2.specialty, "dentist", "specialty added on turn 2");
  assert.equal(t2.readyToBook, true, "ready after refinement");
  console.log("4) multi-turn → turn1 missing:", t1.missingSlots, "| turn2 ready:", t2.readyToBook);

  await prisma.appointment.delete({ where: { id: appt.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log("\n✅ intake parse: slot-filling, provider matching, multi-turn all pass");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
