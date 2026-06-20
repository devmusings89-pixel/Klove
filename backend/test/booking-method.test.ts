// Per-office preferred booking method: the router tries the office's remembered channel first, and a
// successful booking captures the channel that worked so the next booking reuses it. Walkthrough uses
// "Avondale Smiles Dentistry". Hermetic: LIVE_BOOKING off, no live channels needed (we drive reconcile
// from fixtures, exactly like appointment-booking.test).

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.LIVE_BOOKING = "false";
process.env.GOOGLE_PLACES_API_KEY = "";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { reconcileConciergeJobs } = await import("../src/services/concierge.js");
const { upsertProvider } = await import("../src/services/providers.js");
const { prioritizeChannels } = await import("../src/channels/registry.js");
const { toJson } = await import("../src/services/json.js");

const SUFFIX = `bookmethod-${process.pid}-${process.hrtime.bigint()}`;
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
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { household: { operatorUserId: { in: userIds } } } });
  await prisma.provider.deleteMany({ where: { household: { operatorUserId: { in: userIds } } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("prioritizeChannels moves the office's preferred method to the front (rest stay in order)", () => {
  const supported = [{ channel: { type: "web" } }, { channel: { type: "voice" } }, { channel: { type: "messaging" } }];
  assert.deepEqual(prioritizeChannels(supported, "voice").map((d) => d.channel.type), ["voice", "web", "messaging"]);
  assert.deepEqual(prioritizeChannels(supported, null).map((d) => d.channel.type), ["web", "voice", "messaging"]);
  // A preferred channel that isn't currently supported is ignored (no crash, default order).
  assert.deepEqual(prioritizeChannels(supported, "fax").map((d) => d.channel.type), ["web", "voice", "messaging"]);
});

test("Avondale Smiles: a successful voice booking is remembered as the office's preferred method", async () => {
  const op = await mkOperator("avondale");
  const when = new Date(Date.now() + 5 * 86_400_000).toISOString();
  // Simulate the office answering and booking by PHONE (channel = voice).
  const session = await prisma.session.create({
    data: {
      userId: op.id, tier: "ai", kind: "booking", status: "completed", originChannel: "app", patientInfo: "{}",
      targets: {
        create: {
          officeName: "Avondale Smiles Dentistry", phoneNumber: "+14805551234", channel: "voice", order: 0, status: "booked", chosenSlot: when,
          results: { create: { phase: "book", structuredData: toJson({ outcome: "booked", appointmentBooked: true, appointmentDateTime: when, confirmation: "AV1" }) } },
        },
      },
    },
  });
  await prisma.task.create({
    data: { subjectUserId: op.id, householdId: op.householdId, title: "Booking: dental cleaning", state: "waiting", kind: "book", originChannel: "app", conciergeJobId: session.id },
  });

  await reconcileConciergeJobs();

  // The directory now remembers Avondale prefers voice — so the next booking will try voice first.
  const provider = await prisma.provider.findFirst({ where: { householdId: op.householdId, name: "Avondale Smiles Dentistry" } });
  assert.ok(provider, "Avondale captured into the directory");
  assert.equal(provider?.preferredBookingMethod, "voice");
});

test("upsertProvider preserves a remembered preferred method when later updates omit it", async () => {
  const op = await mkOperator("preserve");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Web First Clinic", source: "booking", preferredBookingMethod: "web" });
  // A later capture (e.g. manual edit) that doesn't pass the method must not wipe it.
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Web First Clinic", phone: "+15551112222", source: "manual" });
  const p = await prisma.provider.findFirst({ where: { householdId: op.householdId, name: "Web First Clinic" } });
  assert.equal(p?.preferredBookingMethod, "web");
  assert.equal(p?.phone, "+15551112222");
});
