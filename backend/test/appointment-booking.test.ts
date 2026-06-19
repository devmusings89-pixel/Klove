// Appointment booking pipeline: the info/confirm gate, channel-origin stamping, reconcile outcomes,
// and the regression for the stuck dead-end seen in the screenshot (a waiting task linked to a
// target-less/draft session that never progressed).
//
// Deterministic: LIVE_BOOKING is off (so bookAppointment never places real calls) and Google Places is
// disabled (resolution relies only on the directory). Reconcile flows are exercised by constructing the
// Session/CallTarget/CallResult fixtures directly, exactly as klove-flows.test.ts does.

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.LIVE_BOOKING = "false";
process.env.GOOGLE_PLACES_API_KEY = "";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { bookAppointment, prepareBooking, reconcileConciergeJobs } = await import("../src/services/concierge.js");
const { upsertProvider } = await import("../src/services/providers.js");
const { toJson } = await import("../src/services/json.js");

const SUFFIX = `book-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

async function mkOperator(tag: string): Promise<{ id: string; householdId: string }> {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test` } });
  userIds.push(u.id);
  const householdId = await ensureHousehold(u.id);
  return { id: u.id, householdId };
}

after(async () => {
  await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: userIds } } } } });
  await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.provider.deleteMany({
    where: { OR: [{ subjectUserId: { in: userIds } }, { household: { operatorUserId: { in: userIds } } }] },
  });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---- info / no-fabrication gate + channel origin ----

test("booking with no reachable provider creates a needs-you task stamped with the origin channel", async () => {
  const op = await mkOperator("noprov");
  const out = await bookAppointment(op.id, op.id, op.householdId, { reason: "Eye exam", originChannel: "app" });
  assert.equal(out.status, "needs_info");
  assert.equal(out.appointmentId, undefined);
  assert.equal(await prisma.appointment.count({ where: { userId: op.id } }), 0, "no fabricated appointment");
  const task = await prisma.task.findUnique({ where: { id: out.taskId } });
  assert.equal(task?.state, "needs_you");
  assert.equal(task?.kind, "book");
  assert.equal(task?.originChannel, "app");
});

// ---- prepareBooking: resolve + confirm (no calls placed) ----

test("prepareBooking resolves a known directory provider and is ready to confirm", async () => {
  const op = await mkOperator("prep");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Glow Dermatology", phone: "+12065551212", specialty: "dermatologist", source: "manual", usedAt: new Date() });
  const plan = await prepareBooking(op.id, op.id, op.householdId, { reason: "dermatologist" });
  assert.equal(plan.status, "ready");
  assert.equal(plan.provider?.name, "Glow Dermatology");
  assert.match(plan.recap, /Glow Dermatology/);
  assert.ok(plan.missing.includes("insurance"), "surfaces missing info in the recap");
});

test("prepareBooking with an explicit phone is ready without a directory entry", async () => {
  const op = await mkOperator("prepphone");
  const plan = await prepareBooking(op.id, op.id, op.householdId, { reason: "Physical", provider: "Downtown Clinic", phone: "+12065550101" });
  assert.equal(plan.status, "ready");
  assert.equal(plan.provider?.phone, "+12065550101");
});

test("prepareBooking returns needs_provider with candidates when nothing resolves", async () => {
  const op = await mkOperator("prepnone");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Some Dental Office", specialty: "dentist", phone: "+1", source: "manual" });
  const plan = await prepareBooking(op.id, op.id, op.householdId, { reason: "dermatologist" });
  assert.equal(plan.status, "needs_provider");
  assert.equal(plan.provider, null);
  assert.ok(plan.candidates.length >= 1, "offers directory candidates to pick from or add to");
});

// ---- reconcile outcomes ----

test("reconcile turns a booked job into an appointment + handled task and captures the provider", async () => {
  const op = await mkOperator("booked");
  const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const session = await prisma.session.create({
    data: {
      userId: op.id, tier: "ai", kind: "booking", status: "completed", originChannel: "app", patientInfo: "{}",
      targets: {
        create: {
          officeName: "City Derm", phoneNumber: "+12065552222", order: 0, status: "booked", chosenSlot: when,
          results: { create: { phase: "book", structuredData: toJson({ outcome: "booked", appointmentBooked: true, appointmentDateTime: when, confirmation: "C1" }) } },
        },
      },
    },
  });
  const task = await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Booking: dermatologist", state: "waiting", kind: "book", originChannel: "app", conciergeJobId: session.id },
  });
  await reconcileConciergeJobs();
  assert.equal((await prisma.task.findUnique({ where: { id: task.id } }))?.state, "handled");
  const appt = await prisma.appointment.findFirst({ where: { userId: op.id, sourceType: "klove_booking" } });
  assert.ok(appt, "appointment created");
  assert.equal(appt?.provider, "City Derm");
  assert.equal(appt?.confirmation, "C1");
  const captured = await prisma.provider.findFirst({ where: { householdId: op.householdId, name: "City Derm" } });
  assert.ok(captured, "provider captured into the directory");
  assert.equal(captured?.specialty, "dermatologist");
});

test("reconcile surfaces a choose-time task when the office offered alternates", async () => {
  const op = await mkOperator("choose");
  const session = await prisma.session.create({
    data: {
      userId: op.id, tier: "ai", kind: "booking", status: "in_progress", originChannel: "app", patientInfo: "{}",
      targets: { create: { officeName: "Busy Office", order: 0, status: "awaiting_choice", offeredSlots: toJson(["Mon 9am", "Tue 2pm"]) } },
    },
  });
  const task = await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Booking: dentist", state: "waiting", kind: "book", originChannel: "app", conciergeJobId: session.id },
  });
  await reconcileConciergeJobs();
  const t = await prisma.task.findUnique({ where: { id: task.id } });
  assert.equal(t?.state, "needs_you");
  assert.equal(t?.kind, "choose_time");
  assert.deepEqual(JSON.parse(t?.options ?? "[]"), ["Mon 9am", "Tue 2pm"]);
});

test("reconcile surfaces a needs-you task when the job ends without a booking", async () => {
  const op = await mkOperator("failed");
  const session = await prisma.session.create({
    data: {
      userId: op.id, tier: "ai", kind: "booking", status: "failed", originChannel: "app", patientInfo: "{}",
      targets: { create: { officeName: "No Answer Office", order: 0, status: "failed" } },
    },
  });
  const task = await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Booking: physical", state: "waiting", kind: "book", originChannel: "app", conciergeJobId: session.id },
  });
  await reconcileConciergeJobs();
  assert.equal((await prisma.task.findUnique({ where: { id: task.id } }))?.state, "needs_you");
});

// ---- REGRESSION: the screenshot bug ----

test("reconcile self-heals a stuck waiting task whose session has no targets (the route-to-concierge dead-end)", async () => {
  const op = await mkOperator("stuck");
  // Exactly what route-to-concierge used to create: a draft session with NO call targets.
  const session = await prisma.session.create({
    data: { userId: op.id, tier: "ai", kind: "booking", status: "draft", originChannel: "app", patientInfo: "{}" },
  });
  const task = await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Book: Appointment for Khushboo", state: "waiting", kind: "book", originChannel: "app", conciergeJobId: session.id },
  });
  await reconcileConciergeJobs();
  const t = await prisma.task.findUnique({ where: { id: task.id } });
  assert.equal(t?.state, "needs_you", "no longer stuck on waiting");
  assert.equal(t?.conciergeJobId, null, "unlinked from the dead session");
  assert.match(t?.detail ?? "", /couldn't reach an office/);
});
