import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { bookAppointment, reconcileConciergeJobs } from "../src/services/concierge.js";
import { autoGenerateReminders, runReminderTick } from "../src/services/reminders.js";
import { runAnalysis } from "../src/services/analysis.js";
import { buildTimeline, buildSeries } from "../src/services/graph.js";
import { toJson } from "../src/services/json.js";

const SUFFIX = `flows-${process.pid}-${process.hrtime.bigint()}`;
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
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.observation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.condition.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.healthAlert.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("simulated booking creates a confirmed appointment + handled task", async () => {
  const op = await mkOperator("book");
  const out = await bookAppointment(op.id, op.id, op.householdId, {
    reason: "Eye exam",
    preferredDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  assert.equal(out.status, "confirmed");
  assert.ok(out.appointmentId);
  const appt = await prisma.appointment.findUnique({ where: { id: out.appointmentId! } });
  assert.equal(appt?.status, "scheduled");
  const task = await prisma.task.findUnique({ where: { id: out.taskId } });
  assert.equal(task?.state, "handled");
});

test("booking is free and a simulated hold is marked unverified (no payment gate)", async () => {
  const op = await mkOperator("free");
  const out = await bookAppointment(op.id, op.id, op.householdId, { reason: "Dental cleaning" });
  // No payment_required status anywhere — the $5 gate is gone.
  assert.equal(out.status, "confirmed");
  // A simulated booking must be flagged unverified so the UI can label it a provisional hold.
  assert.equal(out.verified, false);
  assert.ok(out.sessionId, "exposes the session id for live progress");
});

test("auto-reminders generate for an upcoming appointment and fire into a message", async () => {
  const op = await mkOperator("rem");
  await prisma.appointment.create({
    data: { userId: op.id, sourceType: "test", title: "Cardiology", status: "scheduled", startsAt: new Date(Date.now() + 2 * 86_400_000) },
  });
  assert.ok((await autoGenerateReminders()) >= 1);
  const rem = await prisma.reminder.findFirst({ where: { subjectUserId: op.id } });
  assert.ok(rem, "reminder created");
  await prisma.reminder.update({ where: { id: rem!.id }, data: { fireAt: new Date(Date.now() - 1000) } });
  assert.ok((await runReminderTick()) >= 1);
  assert.ok(await prisma.message.findFirst({ where: { subjectUserId: op.id } }), "reminder fired a message");
});

test("proactive analysis flags an A1c gap for diabetes without recent labs", async () => {
  const op = await mkOperator("dx");
  await prisma.condition.create({ data: { userId: op.id, sourceType: "test", display: "Type 2 diabetes mellitus", clinicalStatus: "active" } });
  await runAnalysis(op.id);
  const tasks = await prisma.task.findMany({ where: { subjectUserId: op.id } });
  assert.ok(tasks.some((t) => t.title.includes("A1c")), "A1c screening task created");
});

test("concierge reconcile turns a booked job into an appointment + handled task", async () => {
  const op = await mkOperator("rec");
  const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const session = await prisma.session.create({
    data: {
      userId: op.id, tier: "human", kind: "booking", status: "completed", patientInfo: "{}",
      targets: {
        create: {
          officeName: "Clinic", order: 0, status: "booked", chosenSlot: when,
          results: { create: { phase: "book", structuredData: toJson({ outcome: "booked", appointmentDateTime: when, confirmation: "X1" }) } },
        },
      },
    },
  });
  const task = await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Booking: Eye", state: "waiting", kind: "book", conciergeJobId: session.id },
  });
  await reconcileConciergeJobs();
  assert.equal((await prisma.task.findUnique({ where: { id: task.id } }))?.state, "handled");
  assert.ok(await prisma.appointment.findFirst({ where: { userId: op.id, sourceType: "klove_booking" } }), "appointment created");
});

test("buildTimeline + buildSeries reflect seeded observations", async () => {
  const op = await mkOperator("ts");
  for (const [v, d] of [[6.4, "2026-01-01"], [6.0, "2026-04-01"]] as [number, string][]) {
    await prisma.observation.create({ data: { userId: op.id, sourceType: "test", display: "Hemoglobin A1c", valueNum: v, unit: "%", effectiveAt: new Date(d) } });
  }
  assert.ok((await buildTimeline(op.id)).some((e) => e.kind === "observation"));
  const s = await buildSeries(op.id, "A1c");
  assert.equal(s?.points.length, 2);
});
