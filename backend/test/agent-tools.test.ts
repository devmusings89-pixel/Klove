// Agentic engine: the tool registry produces cards (read tools) + proposals (act tools), and the
// confirm gate (askConfirm) executes a stored pending action through executeAction with consent enforced.
// Hermetic: mock NPI (PHYSICIAN_SEARCH_LIVE unset), Places off, LIVE_BOOKING off, no LLM.

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.LIVE_BOOKING = "false";
process.env.GOOGLE_PLACES_API_KEY = "";
process.env.PHYSICIAN_SEARCH_LIVE = "";
process.env.OPENROUTER_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.WEB_AGENT_PROVIDER = "anthropic"; // anthropic + no key → no tool-capable LLM (loop unavailable)

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { getTool } = await import("../src/services/agent-tools.js");
const { askConfirm } = await import("../src/services/agent.js");

const SUFFIX = `agent-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

async function mkOperator(tag: string): Promise<{ id: string; householdId: string; name: string }> {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test`, displayName: "Operator" } });
  userIds.push(u.id);
  const householdId = await ensureHousehold(u.id);
  return { id: u.id, householdId, name: "Operator" };
}

function ctxFor(op: { id: string; householdId: string; name: string }, text: string) {
  return { operatorUserId: op.id, householdId: op.householdId, members: [{ id: op.id, name: op.name }], text, history: [], memory: [], activity: "" };
}

async function seedPending(userId: string, householdId: string, action: unknown) {
  await prisma.agentConversation.upsert({
    where: { userId },
    create: { userId, householdId, pendingAction: JSON.stringify(action), pendingExpiresAt: new Date(Date.now() + 600_000) },
    update: { pendingAction: JSON.stringify(action), pendingExpiresAt: new Date(Date.now() + 600_000) },
  });
}

after(async () => {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { household: { operatorUserId: { in: userIds } } } });
  await prisma.request.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.provider.deleteMany({ where: { household: { operatorUserId: { in: userIds } } } });
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("search_physicians read tool returns a physician_list card", async () => {
  const op = await mkOperator("search");
  const tool = getTool("search_physicians");
  assert.ok(tool && tool.kind === "read");
  const { summary, card } = await tool.run(ctxFor(op, "find a dermatologist"), { condition: "dermatologist" });
  assert.ok(summary.length > 0);
  assert.equal(card?.type, "physician_list");
  if (card?.type === "physician_list") assert.ok(card.results.length >= 1);
});

test("book_appointment act tool builds a proposal + booking_recap card (does not execute)", async () => {
  const op = await mkOperator("book");
  const tool = getTool("book_appointment");
  assert.ok(tool && tool.kind === "act");
  const { action, card } = await tool.build(ctxFor(op, "book it"), { reason: "dermatologist", provider: "Glow Dermatology", phone: "+12065551212" });
  assert.equal(action.tool, "book_appointment");
  assert.equal(action.subjectUserId, op.id);
  assert.equal(action.args.provider, "Glow Dermatology");
  assert.match(action.restatement, /Glow Dermatology/);
  assert.equal(card?.type, "booking_recap");
  // No appointment/session created just from building the proposal.
  assert.equal(await prisma.task.count({ where: { subjectUserId: op.id } }), 0);
});

test("askConfirm executes a pending booking (creates a tracking task) — LIVE_BOOKING off", async () => {
  const op = await mkOperator("confirm");
  await seedPending(op.id, op.householdId, {
    tool: "book_appointment",
    args: { reason: "dermatologist", provider: "Glow Dermatology", phone: "+12065551212" },
    subjectUserId: op.id,
    restatement: "Book dermatologist with Glow Dermatology?",
  });
  const res = await askConfirm(op.id);
  assert.equal(res.kind, "escalated");
  assert.ok(res.answer.length > 0);
  assert.ok((await prisma.task.count({ where: { subjectUserId: op.id } })) >= 1, "a tracking task was created");
  // Pending is cleared after confirm.
  const convo = await prisma.agentConversation.findUnique({ where: { userId: op.id } });
  assert.equal(convo?.pendingAction, null);
});

test("askConfirm executes set_reminder → creates a reminder task", async () => {
  const op = await mkOperator("remind");
  await seedPending(op.id, op.householdId, {
    tool: "set_reminder",
    args: { title: "Refill metformin", when: "Friday" },
    subjectUserId: op.id,
    restatement: 'Add a reminder for Friday: "Refill metformin"?',
  });
  const res = await askConfirm(op.id);
  assert.equal(res.kind, "escalated");
  const t = await prisma.task.findFirst({ where: { subjectUserId: op.id, kind: "reminder" } });
  assert.equal(t?.title, "Refill metformin");
});

test("askConfirm with nothing pending is a no-op answer", async () => {
  const op = await mkOperator("none");
  const res = await askConfirm(op.id);
  assert.equal(res.kind, "answer");
  assert.match(res.answer, /nothing to confirm/i);
});

test("confirm enforces consent for an unrelated subject", async () => {
  const op = await mkOperator("consent");
  const stranger = await prisma.user.create({ data: { email: `stranger.${SUFFIX}@klove.test` } });
  userIds.push(stranger.id);
  await seedPending(op.id, op.householdId, {
    tool: "book_appointment",
    args: { reason: "dermatologist", provider: "X" },
    subjectUserId: stranger.id, // operator has no consent to act for this user
    restatement: "Book?",
  });
  const res = await askConfirm(op.id);
  assert.match(res.answer, /can't act|permission/i);
  assert.equal(await prisma.task.count({ where: { subjectUserId: stranger.id } }), 0);
});
