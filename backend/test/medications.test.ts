import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { runMedicationDoseTick, runMissedDoseTick, runRefillTick } from "../src/services/medications.js";
import { toJson } from "../src/services/json.js";

const SUFFIX = `meds-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

/** An operator (caregiver) plus a managed member in the operator's household. */
async function mkCaregiverAndMember(tag: string) {
  const op = await prisma.user.create({ data: { email: `op.${tag}.${SUFFIX}@klove.test`, displayName: "Operator" } });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  const member = await prisma.user.create({ data: { displayName: "Mom", managed: true, managedByUserId: op.id } });
  userIds.push(member.id);
  await prisma.householdMembership.create({
    data: { householdId, userId: member.id, relationship: "parent", memberType: "aging_parent", isOperator: false },
  });
  return { operatorId: op.id, memberId: member.id, householdId };
}

async function mkMedication(memberId: string, display: string, extra: Record<string, unknown> = {}) {
  return prisma.medicationStatement.create({
    data: { userId: memberId, sourceType: "test", display, status: "active", ...extra },
  });
}

after(async () => {
  await prisma.doseLog.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.medicationSchedule.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.medicationStatement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("dose tick creates one pending DoseLog for a due time and is idempotent", async () => {
  const { memberId } = await mkCaregiverAndMember("dose");
  const med = await mkMedication(memberId, "Metformin 500mg");
  await prisma.medicationSchedule.create({
    data: { medicationId: med.id, subjectUserId: memberId, label: med.display, times: toJson(["08:00"]), active: true },
  });

  const now = new Date();
  now.setHours(8, 30, 0, 0); // 30 min after the 08:00 dose — within the due window
  // The tick covers today AND yesterday (outage safety), so assert today's dose + idempotency
  // rather than a fixed total. Scope to this member (the tick is global, shared DB).
  assert.ok((await runMedicationDoseTick(now)) >= 1);
  const afterFirst = await prisma.doseLog.count({ where: { subjectUserId: memberId } });
  await runMedicationDoseTick(now);
  assert.equal(await prisma.doseLog.count({ where: { subjectUserId: memberId } }), afterFirst, "idempotent for this member");

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayDose = await prisma.doseLog.findFirst({ where: { subjectUserId: memberId, scheduledAt: { gte: startOfToday } } });
  assert.equal(todayDose?.status, "pending");
  assert.equal(todayDose?.scheduledAt.getHours(), 8);
  assert.equal(todayDose?.scheduledAt.getMinutes(), 0);
});

test("missed-dose tick marks overdue doses missed and alerts the caregiver", async () => {
  const { memberId, householdId } = await mkCaregiverAndMember("missed");
  const med = await mkMedication(memberId, "Lisinopril 10mg");
  const sched = await prisma.medicationSchedule.create({
    data: { medicationId: med.id, subjectUserId: memberId, label: med.display, times: toJson(["08:00"]), active: true },
  });
  const now = new Date();
  // A pending dose scheduled 3 hours ago — past the grace window.
  await prisma.doseLog.create({
    data: {
      scheduleId: sched.id,
      medicationId: med.id,
      subjectUserId: memberId,
      label: med.display,
      scheduledAt: new Date(now.getTime() - 3 * 3_600_000),
      status: "pending",
    },
  });

  // Global tick; assert against this member's own data rather than the cross-member return count.
  assert.ok((await runMissedDoseTick(now)) >= 1);
  const dose = await prisma.doseLog.findFirst({ where: { subjectUserId: memberId } });
  assert.equal(dose?.status, "missed");
  const alert = await prisma.message.findFirst({ where: { householdId, title: "Missed dose" } });
  assert.ok(alert, "caregiver missed-dose message created");
  assert.match(alert!.body, /Mom/);

  // No re-alert: a second run leaves this household's missed-dose message count unchanged.
  const before = await prisma.message.count({ where: { householdId, title: "Missed dose" } });
  await runMissedDoseTick(now);
  assert.equal(await prisma.message.count({ where: { householdId, title: "Missed dose" } }), before);
});

test("a late dose tick still creates the dose so it can be flagged missed", async () => {
  const { memberId } = await mkCaregiverAndMember("late");
  const med = await mkMedication(memberId, "Warfarin 5mg");
  await prisma.medicationSchedule.create({
    data: { medicationId: med.id, subjectUserId: memberId, label: med.display, times: toJson(["08:00"]), active: true },
  });
  // The worker runs at 2pm — hours past the 08:00 slot. The dose must still be created (not skipped).
  const now = new Date();
  now.setHours(14, 0, 0, 0);
  assert.ok((await runMedicationDoseTick(now)) >= 1);
  const dose = await prisma.doseLog.findFirst({ where: { subjectUserId: memberId } });
  assert.ok(dose, "dose created even though the tick ran long after the slot");
  assert.equal(dose?.scheduledAt.getHours(), 8);
});

test("a missed critical dose raises a Today task with stronger wording", async () => {
  const { memberId, householdId } = await mkCaregiverAndMember("crit");
  const med = await mkMedication(memberId, "Insulin");
  const sched = await prisma.medicationSchedule.create({
    data: { medicationId: med.id, subjectUserId: memberId, label: med.display, times: toJson(["08:00"]), active: true, critical: true },
  });
  const now = new Date();
  await prisma.doseLog.create({
    data: { scheduleId: sched.id, medicationId: med.id, subjectUserId: memberId, label: med.display, scheduledAt: new Date(now.getTime() - 3 * 3_600_000), status: "pending" },
  });
  await runMissedDoseTick(now);
  const task = await prisma.task.findFirst({ where: { householdId, state: "needs_you", title: { contains: "Missed dose" } } });
  assert.ok(task, "missed dose surfaces as a Today task");
  const alert = await prisma.message.findFirst({ where: { householdId, title: "Missed dose" } });
  assert.match(alert!.body, /CRITICAL/);
});

test("refill re-nudges for a new due-date cycle (per-cycle idempotency)", async () => {
  const { memberId, householdId } = await mkCaregiverAndMember("recycle");
  const now = new Date();
  const med = await mkMedication(memberId, "Levothyroxine", { nextRefillDue: new Date(now.getTime() + 2 * 86_400_000) });
  assert.equal(await runRefillTick(now), 1);
  // Next cycle: a new due date → a new nudge, not silently suppressed.
  await prisma.medicationStatement.update({ where: { id: med.id }, data: { nextRefillDue: new Date(now.getTime() + 32 * 86_400_000) } });
  const later = new Date(now.getTime() + 30 * 86_400_000);
  assert.equal(await runRefillTick(later), 1, "a new due date nudges again");
  assert.equal(await prisma.message.count({ where: { householdId, title: "Refill due soon" } }), 2);
});

test("refill tick nudges the caregiver once for a medication due soon", async () => {
  const { memberId, householdId } = await mkCaregiverAndMember("refill");
  const now = new Date();
  await mkMedication(memberId, "Atorvastatin 20mg", { nextRefillDue: new Date(now.getTime() + 2 * 86_400_000) });

  assert.equal(await runRefillTick(now), 1);
  assert.equal(await runRefillTick(now), 0, "idempotent — no duplicate refill nudge");
  const msgs = await prisma.message.findMany({ where: { householdId, title: "Refill due soon" } });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /Atorvastatin/);
});
