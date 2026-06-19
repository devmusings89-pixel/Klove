// Known-provider directory: resolution (member → household, by specialty + recency), dedup upsert,
// backfill from past appointments, and search. Deterministic — Google Places is disabled so resolution
// relies only on the directory (searchOffices returns [] when Places is off but Vapi is configured).

import { test, after } from "node:test";
import assert from "node:assert/strict";

// Set BEFORE importing modules that read config at load time.
process.env.LIVE_BOOKING = "false";
process.env.GOOGLE_PLACES_API_KEY = "";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { resolveProvider, upsertProvider, listProviders, searchProviders, backfillProviders, classifySpecialty } =
  await import("../src/services/providers.js");

const SUFFIX = `provdir-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

async function mkOperator(tag: string): Promise<{ id: string; householdId: string }> {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test` } });
  userIds.push(u.id);
  const householdId = await ensureHousehold(u.id);
  return { id: u.id, householdId };
}

after(async () => {
  await prisma.provider.deleteMany({
    where: { OR: [{ subjectUserId: { in: userIds } }, { household: { operatorUserId: { in: userIds } } }] },
  });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("classifySpecialty normalizes free text into a specialty key", () => {
  assert.equal(classifySpecialty("dermatologist"), "dermatologist");
  assert.equal(classifySpecialty("rash on my skin"), "dermatologist");
  assert.equal(classifySpecialty("teeth cleaning"), "dentist");
  assert.equal(classifySpecialty("totally unrelated phrase"), undefined);
});

test("resolveProvider returns a member's known provider by specialty", async () => {
  const op = await mkOperator("known");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Glow Dermatology", phone: "+12065551212", specialty: "dermatologist", source: "manual", usedAt: new Date() });
  const r = await resolveProvider({ householdId: op.householdId, subjectUserId: op.id, reason: "dermatologist" });
  assert.equal(r.source, "directory");
  assert.equal(r.provider?.name, "Glow Dermatology");
  assert.equal(r.provider?.phone, "+12065551212");
});

test("resolveProvider falls back to a household-wide provider when the member has none", async () => {
  const op = await mkOperator("hh");
  await upsertProvider({ householdId: op.householdId, subjectUserId: null, name: "Family Dental", phone: "+12065550000", specialty: "dentist", source: "manual" });
  const r = await resolveProvider({ householdId: op.householdId, subjectUserId: op.id, specialty: "dentist", reason: "cleaning" });
  assert.equal(r.source, "directory");
  assert.equal(r.provider?.name, "Family Dental");
});

test("a member-specific provider outranks a household-wide one of the same specialty", async () => {
  const op = await mkOperator("rank");
  await upsertProvider({ householdId: op.householdId, subjectUserId: null, name: "Generic Cardio", specialty: "cardiologist", phone: "+1", source: "manual" });
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Heart Specialists", specialty: "cardiologist", phone: "+2", source: "manual", usedAt: new Date() });
  const r = await resolveProvider({ householdId: op.householdId, subjectUserId: op.id, specialty: "cardiologist" });
  assert.equal(r.provider?.name, "Heart Specialists");
});

test("resolveProvider returns none when the directory is empty and Places is disabled", async () => {
  const op = await mkOperator("none");
  const r = await resolveProvider({ householdId: op.householdId, subjectUserId: op.id, reason: "dermatologist" });
  assert.equal(r.source, "none");
  assert.equal(r.provider, null);
});

test("upsertProvider dedupes by name (case-insensitive) and refreshes contact + recency", async () => {
  const op = await mkOperator("dedupe");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Acme Clinic", phone: "+1111", source: "manual" });
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "acme clinic", website: "https://acme.example", source: "booking", usedAt: new Date() });
  const rows = await prisma.provider.findMany({ where: { householdId: op.householdId, subjectUserId: op.id } });
  assert.equal(rows.length, 1, "deduped to one row");
  assert.equal(rows[0].phone, "+1111", "kept existing phone");
  assert.equal(rows[0].website, "https://acme.example", "added website");
  assert.ok(rows[0].lastUsedAt, "marked used");
});

test("backfillProviders seeds the directory from past appointments and is idempotent", async () => {
  const op = await mkOperator("backfill");
  await prisma.appointment.create({
    data: { userId: op.id, sourceType: "gmail", title: "Dental cleaning", provider: "Bright Smiles", providerPhone: "+12065559999", startsAt: new Date() },
  });
  const n1 = await backfillProviders(op.householdId);
  assert.ok(n1 >= 1);
  const count1 = await prisma.provider.count({ where: { householdId: op.householdId } });
  await backfillProviders(op.householdId);
  const count2 = await prisma.provider.count({ where: { householdId: op.householdId } });
  assert.equal(count1, count2, "running backfill again creates no duplicates");
  const p = await prisma.provider.findFirst({ where: { householdId: op.householdId, name: "Bright Smiles" } });
  assert.equal(p?.specialty, "dentist");
  assert.equal(p?.phone, "+12065559999");
});

test("searchProviders finds directory entries by name", async () => {
  const op = await mkOperator("search");
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Lakeview Pediatrics", specialty: "pediatrician", source: "manual" });
  const res = await searchProviders(op.householdId, "lakeview");
  assert.ok(res.directory.some((p) => p.name === "Lakeview Pediatrics"));
});
