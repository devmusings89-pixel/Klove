// Cross-flow consistency: a booking started on ANY surface (app booking form, WhatsApp, Ask Klove)
// must be visible to the agent on a later turn, so it can answer "which office am I booking with?" /
// "how did you pick that center?" instead of claiming it never selected anything. loadBookingActivity
// is the shared context the orchestrator feeds every subagent — this verifies it surfaces the chosen
// office for an in-flight booking (from the Session's CallTarget) and a confirmed one (from bookingJson),
// and that it respects consent (only members the operator can see).
//
// Deterministic: no LLM, no Google Places — fixtures are constructed directly.

import { test, after } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { loadBookingActivity } = await import("../src/services/agent.js");
const { toJson } = await import("../src/services/json.js");

const SUFFIX = `activity-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

async function mkOperator(tag: string): Promise<{ id: string; householdId: string }> {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test` } });
  userIds.push(u.id);
  const householdId = await ensureHousehold(u.id);
  return { id: u.id, householdId };
}

after(async () => {
  await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("loadBookingActivity surfaces the chosen office for an in-flight booking (cross-flow)", async () => {
  const op = await mkOperator("inflight");
  const session = await prisma.session.create({
    data: {
      userId: op.id,
      kind: "booking",
      status: "in_progress",
      patientInfo: toJson({ name: "inflight", reason: "Botox for migraines" }),
      targets: { create: { officeName: "Overlake Medical Center", phoneNumber: "+14256885000", order: 0 } },
    },
  });
  await prisma.task.create({
    data: {
      subjectUserId: op.id,
      householdId: op.householdId,
      title: "Booking: Botox for migraines",
      kind: "book",
      state: "waiting",
      conciergeJobId: session.id,
    },
  });

  const activity = await loadBookingActivity(op.householdId, [{ id: op.id, name: "inflight" }]);
  assert.match(activity, /Overlake Medical Center/, "names the office Klove is contacting");
  assert.match(activity, /in progress/, "marks it in-flight, not booked");
});

test("loadBookingActivity surfaces a confirmed booking from bookingJson", async () => {
  const op = await mkOperator("booked");
  await prisma.task.create({
    data: {
      subjectUserId: op.id,
      householdId: op.householdId,
      title: "Dermatology visit",
      kind: "book",
      state: "handled",
      bookingJson: toJson({ when: null, whenText: "Tue, Jun 23 at 9:00 AM", provider: "Glow Dermatology", confirmation: "ABC123", verified: true }),
    },
  });

  const activity = await loadBookingActivity(op.householdId, [{ id: op.id, name: "booked" }]);
  assert.match(activity, /Glow Dermatology/);
  assert.match(activity, /booked/);
  assert.match(activity, /ABC123/, "includes the confirmation number");
});

test("loadBookingActivity excludes tasks for members the operator can't see (consent)", async () => {
  const op = await mkOperator("consent");
  // A task for some other subject not in the passed-in members list must not leak.
  const other = await prisma.user.create({ data: { email: `other.${SUFFIX}@klove.test` } });
  userIds.push(other.id);
  await prisma.task.create({
    data: {
      subjectUserId: other.id,
      householdId: op.householdId,
      title: "Private cardiology booking",
      kind: "book",
      state: "waiting",
    },
  });

  const activity = await loadBookingActivity(op.householdId, [{ id: op.id, name: "consent" }]);
  assert.doesNotMatch(activity, /Private cardiology/, "tasks for inaccessible members are filtered out");
});

test("loadBookingActivity returns empty string when there's no booking activity", async () => {
  const op = await mkOperator("empty");
  const activity = await loadBookingActivity(op.householdId, [{ id: op.id, name: "empty" }]);
  assert.equal(activity, "");
});
