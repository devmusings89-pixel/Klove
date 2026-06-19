// Physician search: condition → specialty resolution (keyword fallback, no LLM), NPI candidate ranking,
// and the in-network carrier heuristic across all four states. Deterministic — NPI runs in mock mode
// (PHYSICIAN_SEARCH_LIVE off → seeded specialists), Places off, no LLM key → classifySpecialty fallback.

import { test, after } from "node:test";
import assert from "node:assert/strict";

// Set BEFORE importing modules that read config at load time.
process.env.LIVE_BOOKING = "false";
process.env.GOOGLE_PLACES_API_KEY = "";
process.env.PHYSICIAN_SEARCH_LIVE = "";
process.env.OPENROUTER_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.WEB_AGENT_PROVIDER = "anthropic"; // anthropic + no key → no LLM, exercises the fallback path

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { upsertProvider } = await import("../src/services/providers.js");
const { searchPhysicians, resolveCondition, normalizeCarrier, networkStatus, memberCarriers } = await import(
  "../src/services/physician-search.js"
);

const SUFFIX = `physsearch-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];
const profileIds: string[] = [];

async function mkOperator(tag: string): Promise<{ id: string; householdId: string }> {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test` } });
  userIds.push(u.id);
  const householdId = await ensureHousehold(u.id);
  return { id: u.id, householdId };
}

async function giveInsurance(userId: string, carrier: string): Promise<void> {
  const profile = await prisma.profile.create({ data: { userId, fullName: "Test Patient" } });
  profileIds.push(profile.id);
  await prisma.insurancePlan.create({ data: { profileId: profile.id, carrier } });
}

after(async () => {
  await prisma.provider.deleteMany({
    where: { OR: [{ subjectUserId: { in: userIds } }, { household: { operatorUserId: { in: userIds } } }] },
  });
  await prisma.insurancePlan.deleteMany({ where: { profileId: { in: profileIds } } });
  await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("normalizeCarrier collapses aliases to a shared key", () => {
  assert.equal(normalizeCarrier("Anthem Blue Cross"), "bcbs");
  assert.equal(normalizeCarrier("Blue Cross Blue Shield"), "bcbs");
  assert.equal(normalizeCarrier("UnitedHealthcare"), "unitedhealth");
  assert.equal(normalizeCarrier("Aetna PPO"), "aetna");
  assert.equal(normalizeCarrier(""), null);
});

test("networkStatus covers all four states", () => {
  assert.equal(networkStatus([], []), "unknown"); // no insurance on file
  assert.equal(networkStatus([], ["aetna"]), "unconfirmed"); // provider carriers unknown
  assert.equal(networkStatus(["aetna"], ["aetna"]), "in_network");
  assert.equal(networkStatus(["bcbs"], ["aetna"]), "out_of_network");
});

test("resolveCondition falls back to keyword classification with no LLM", async () => {
  const r = await resolveCondition("rash on my skin");
  assert.equal(r.specialty, "dermatologist");
  assert.equal(r.npiTaxonomy, "Dermatology");
});

test("searchPhysicians returns ranked seeded specialists with match reasons", async () => {
  const op = await mkOperator("ranked");
  const out = await searchPhysicians({ householdId: op.householdId, subjectUserId: op.id, condition: "skin rash" });
  assert.equal(out.resolvedSpecialty, "dermatologist");
  assert.ok(out.results.length >= 1, "got candidates");
  assert.ok(out.results[0].matchReasons.length >= 1, "has a human-readable match reason");
  assert.ok(out.results[0].name.length > 0);
  assert.ok(out.disclaimer.toLowerCase().includes("confirm coverage"));
});

test("a member with no insurance gets network status 'unknown'", async () => {
  const op = await mkOperator("noins");
  const out = await searchPhysicians({ householdId: op.householdId, subjectUserId: op.id, condition: "dermatologist" });
  assert.ok(out.results.every((r) => r.networkStatus === "unknown"));
});

test("fresh search hits are 'unconfirmed' when the member has insurance but the provider isn't tagged", async () => {
  const op = await mkOperator("unconf");
  await giveInsurance(op.id, "Aetna");
  assert.deepEqual(await memberCarriers(op.id), ["aetna"]);
  const out = await searchPhysicians({ householdId: op.householdId, subjectUserId: op.id, condition: "dermatologist" });
  assert.ok(out.results.every((r) => r.networkStatus === "unconfirmed"));
});

test("a saved provider tagged with the member's carrier reads as in_network; a non-overlapping one is out_of_network", async () => {
  const op = await mkOperator("innet");
  await giveInsurance(op.id, "Aetna");
  // Save two directory providers by the seeded mock names, with accepted carriers.
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Avery Chen, MD", specialty: "dermatologist", source: "search", acceptedCarriers: ["aetna"] });
  await upsertProvider({ householdId: op.householdId, subjectUserId: op.id, name: "Jordan Patel, DO", specialty: "dermatologist", source: "search", acceptedCarriers: ["bcbs"] });

  const out = await searchPhysicians({ householdId: op.householdId, subjectUserId: op.id, condition: "dermatologist" });
  const avery = out.results.find((r) => r.name === "Avery Chen, MD");
  const jordan = out.results.find((r) => r.name === "Jordan Patel, DO");
  assert.equal(avery?.networkStatus, "in_network");
  assert.equal(jordan?.networkStatus, "out_of_network");
});
