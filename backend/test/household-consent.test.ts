import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { prisma } from "../src/db.js";
import { resolveSubject, ConsentError } from "../src/services/auth.js";
import { backfillHouseholds } from "../scripts/backfill-households.js";

// Unique suffix so repeated runs never collide on the unique email constraint.
const SUFFIX = `consent-test-${process.pid}-${process.hrtime.bigint()}`;
const created = { users: [] as string[], grants: [] as string[], households: [] as string[] };

async function mkUser(tag: string, managed = false): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `${tag}.${SUFFIX}@klove.test`, managed },
  });
  created.users.push(u.id);
  return u.id;
}

function reqAs(userId: string): FastifyRequest {
  return { user: { id: userId, email: "x" } } as unknown as FastifyRequest;
}

after(async () => {
  // Tear down in FK-safe order.
  if (created.grants.length) await prisma.consentGrant.deleteMany({ where: { id: { in: created.grants } } });
  await prisma.consentGrant.deleteMany({ where: { OR: [{ granteeUserId: { in: created.users } }, { subjectUserId: { in: created.users } }] } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

test("resolveSubject: self-access is always full, no grant needed", async () => {
  const me = await mkUser("self");
  const ctx = await resolveSubject(reqAs(me), me, { need: "operate", category: "records" });
  assert.equal(ctx.self, true);
  assert.equal(ctx.userId, me);
  assert.equal(ctx.accessLevel, "operate");
});

test("resolveSubject: defaults subject to the caller when omitted", async () => {
  const me = await mkUser("self-default");
  const ctx = await resolveSubject(reqAs(me));
  assert.equal(ctx.self, true);
  assert.equal(ctx.userId, me);
});

test("resolveSubject: no grant over another member is denied", async () => {
  const operator = await mkUser("op-nogrant");
  const other = await mkUser("other-nogrant");
  await assert.rejects(() => resolveSubject(reqAs(operator), other), (e) => e instanceof ConsentError);
});

test("resolveSubject: access-level matrix (view < manage < operate)", async () => {
  const operator = await mkUser("op-level");
  const subject = await mkUser("subj-level", true);
  const grant = await prisma.consentGrant.create({
    data: { granteeUserId: operator, subjectUserId: subject, accessLevel: "manage", categories: '["all"]', status: "active" },
  });
  created.grants.push(grant.id);

  // view & manage permitted; operate denied at a manage grant.
  await assert.doesNotReject(() => resolveSubject(reqAs(operator), subject, { need: "view" }));
  await assert.doesNotReject(() => resolveSubject(reqAs(operator), subject, { need: "manage" }));
  await assert.rejects(() => resolveSubject(reqAs(operator), subject, { need: "operate" }), (e) => e instanceof ConsentError);
});

test("resolveSubject: category scoping (records-only grant blocks appointments)", async () => {
  const operator = await mkUser("op-cat");
  const subject = await mkUser("subj-cat", true);
  const grant = await prisma.consentGrant.create({
    data: { granteeUserId: operator, subjectUserId: subject, accessLevel: "operate", categories: '["records"]', status: "active" },
  });
  created.grants.push(grant.id);

  await assert.doesNotReject(() => resolveSubject(reqAs(operator), subject, { category: "records" }));
  await assert.rejects(() => resolveSubject(reqAs(operator), subject, { category: "appointments" }), (e) => e instanceof ConsentError);
});

test("resolveSubject: revoked grant is denied", async () => {
  const operator = await mkUser("op-revoked");
  const subject = await mkUser("subj-revoked", true);
  const grant = await prisma.consentGrant.create({
    data: { granteeUserId: operator, subjectUserId: subject, accessLevel: "operate", categories: '["all"]', status: "revoked" },
  });
  created.grants.push(grant.id);
  await assert.rejects(() => resolveSubject(reqAs(operator), subject), (e) => e instanceof ConsentError);
});

test("backfillHouseholds: creates a household + self-membership and is idempotent", async () => {
  const me = await mkUser("backfill");

  const first = await backfillHouseholds();
  assert.ok(first.created >= 1, "creates at least the new user's household");

  const hh = await prisma.household.findUnique({ where: { operatorUserId: me } });
  assert.ok(hh, "household exists for the user");
  const membership = await prisma.householdMembership.findFirst({ where: { householdId: hh!.id, userId: me } });
  assert.ok(membership, "self-membership exists");
  assert.equal(membership!.isOperator, true);
  assert.equal(membership!.relationship, "self");

  // Second run must not duplicate.
  const before = await prisma.household.count({ where: { operatorUserId: me } });
  await backfillHouseholds();
  const afterCount = await prisma.household.count({ where: { operatorUserId: me } });
  assert.equal(before, afterCount, "idempotent: no duplicate household");

  // Record the household for teardown.
  created.households.push(hh!.id);
});
