import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { sendWhatsApp, verifyTwilioSignature } from "../src/services/whatsapp.js";
import { resolveUserByWhatsapp, handleInboundMessage } from "../src/services/agent.js";
import { loadMemory, rememberFromTurn } from "../src/services/agent-memory.js";
import { llmAvailable } from "../src/services/llm-tool.js";
import { runProactiveOutreachTick } from "../src/services/proactive.js";
import { toJson } from "../src/services/json.js";

const SUFFIX = `wa-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

/** A WhatsApp-verified operator with a self household + a primary profile (so booking has a name). */
async function mkOperator(tag: string, opts: { verified?: boolean } = {}) {
  const phone = `+1206${String(Date.now() % 10_000_000).padStart(7, "0")}${userIds.length}`.slice(0, 12);
  const op = await prisma.user.create({
    data: {
      email: `op.${tag}.${SUFFIX}@klove.test`,
      displayName: "Tester",
      whatsappPhone: phone,
      whatsappVerified: opts.verified ?? true,
    },
  });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  await prisma.profile.create({ data: { userId: op.id, fullName: "Tester McTest", isPrimary: true } });
  return { id: op.id, phone, householdId };
}

after(async () => {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.healthAlert.deleteMany({ where: { userId: { in: userIds } } });
  // Sessions + their targets/results created by simulatedBooking.
  const sessions = await prisma.session.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const sids = sessions.map((s) => s.id);
  const targets = await prisma.callTarget.findMany({ where: { sessionId: { in: sids } }, select: { id: true } });
  await prisma.callResult.deleteMany({ where: { callTargetId: { in: targets.map((t) => t.id) } } });
  await prisma.callTarget.deleteMany({ where: { sessionId: { in: sids } } });
  await prisma.session.deleteMany({ where: { id: { in: sids } } });
  await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.consentGrant.deleteMany({ where: { granteeUserId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("sendWhatsApp returns true in mock mode and false for an unusable number", async () => {
  assert.equal(await sendWhatsApp("+12065551234", "hello"), true); // mock log
  assert.equal(await sendWhatsApp("nonsense", "hello"), false);
});

test("verifyTwilioSignature accepts a correct signature and rejects a tampered one", async () => {
  const prev = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = "test-token-123";
  try {
    const url = "https://api.klovehealth.com/webhooks/whatsapp";
    const params = { Body: "hi", From: "whatsapp:+12065551234", To: "whatsapp:+14155238886" };
    const data = Object.keys(params)
      .sort()
      .reduce((acc, k) => acc + k + (params as Record<string, string>)[k], url);
    const sig = createHmac("sha1", "test-token-123").update(Buffer.from(data, "utf8")).digest("base64");
    assert.equal(verifyTwilioSignature(url, params, sig), true);
    assert.equal(verifyTwilioSignature(url, { ...params, Body: "tampered" }, sig), false);
    assert.equal(verifyTwilioSignature(url, params, undefined), false);
  } finally {
    if (prev === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = prev;
  }
});

test("resolveUserByWhatsapp finds a linked user and returns null for an unknown number", async () => {
  const op = await mkOperator("resolve");
  const found = await resolveUserByWhatsapp(op.phone);
  assert.equal(found?.id, op.id);
  assert.equal(await resolveUserByWhatsapp("+19999999999"), null);
});

test("unverified number must reply YES to connect before the agent acts", async () => {
  const op = await mkOperator("onboard", { verified: false });
  const r1 = await handleInboundMessage({ id: op.id, whatsappVerified: false }, "book a dermatologist");
  assert.match(r1, /reply yes/i);
  const r2 = await handleInboundMessage({ id: op.id, whatsappVerified: false }, "yes");
  assert.match(r2, /connected/i);
  const reloaded = await prisma.user.findUnique({ where: { id: op.id }, select: { whatsappVerified: true } });
  assert.equal(reloaded?.whatsappVerified, true);
});

test("a booking request searches for an office and never books before confirmation", async () => {
  const op = await mkOperator("book");
  const reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, "book a dermatologist");
  const convo = await prisma.agentConversation.findUnique({ where: { userId: op.id } });
  if (convo?.pendingAction) {
    // Search found an office (Places configured) → it proposes and waits for confirmation.
    assert.match(reply, /yes/i);
  } else {
    // No office lookup available → it asks for one honestly, rather than fabricating a hold.
    assert.match(reply, /office|search|where|city/i);
  }
  // Either way, nothing is booked before the user confirms.
  assert.equal(await prisma.task.count({ where: { subjectUserId: op.id, kind: "book" } }), 0);
});

test("confirming a pending booking executes it (and writes an audit event)", async () => {
  const op = await mkOperator("confirm");
  // Seed a pending action with no contact info so execution takes the safe needs_info path (no live call).
  const pending = toJson({ tool: "book_appointment", args: { reason: "Eye exam" }, subjectUserId: op.id, restatement: "?" });
  await prisma.agentConversation.upsert({
    where: { userId: op.id },
    create: { userId: op.id, householdId: op.householdId, pendingAction: pending, pendingExpiresAt: new Date(Date.now() + 600_000) },
    update: { pendingAction: pending, pendingExpiresAt: new Date(Date.now() + 600_000) },
  });

  const reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, "yes");
  assert.match(reply, /book|office|actions/i);
  const task = await prisma.task.findFirst({ where: { subjectUserId: op.id, kind: "book" } });
  assert.ok(task, "a booking task should exist after confirmation");
  const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: op.id, action: "booking_authorized" } });
  assert.ok(audit, "an audit event should be written for the booking");
  const cleared = await prisma.agentConversation.findUnique({ where: { userId: op.id } });
  assert.equal(cleared?.pendingAction, null, "pending action should be cleared after execution");
});

test("a follow-up message supersedes a pending action instead of executing it", async () => {
  const op = await mkOperator("supersede");
  // Pending booking awaiting confirmation.
  const pending = toJson({ tool: "book_appointment", args: { reason: "dermatologist" }, subjectUserId: op.id, restatement: "?" });
  await prisma.agentConversation.upsert({
    where: { userId: op.id },
    create: { userId: op.id, householdId: op.householdId, pendingAction: pending, pendingExpiresAt: new Date(Date.now() + 600_000) },
    update: { pendingAction: pending, pendingExpiresAt: new Date(Date.now() + 600_000) },
  });

  // A non-yes/no message must NOT execute the pending booking — it supersedes it.
  await handleInboundMessage({ id: op.id, whatsappVerified: true }, "actually, what medications am I on?");

  const convo = await prisma.agentConversation.findUnique({ where: { userId: op.id } });
  assert.equal(convo?.pendingAction, null, "pending action should be cleared (superseded)");
  assert.equal(await prisma.task.count({ where: { subjectUserId: op.id, kind: "book" } }), 0, "the booking must NOT have executed");
  // Both turns are persisted to the WhatsApp thread (history carries across turns).
  const msgs = await prisma.message.count({ where: { subjectUserId: op.id, channel: "whatsapp" } });
  assert.ok(msgs >= 2, "inbound + outbound turns recorded for history");
});

test("the consent net refuses a pending action on a non-consented member", async () => {
  const op = await mkOperator("consent");
  // A member with NO consent grant to the operator.
  const stranger = await prisma.user.create({ data: { displayName: "Stranger", managed: true } });
  userIds.push(stranger.id);
  await prisma.agentConversation.upsert({
    where: { userId: op.id },
    create: {
      userId: op.id,
      householdId: op.householdId,
      pendingAction: toJson({ tool: "book_appointment", args: { reason: "x-ray" }, subjectUserId: stranger.id, restatement: "?" }),
      pendingExpiresAt: new Date(Date.now() + 600_000),
    },
    update: {
      pendingAction: toJson({ tool: "book_appointment", args: { reason: "x-ray" }, subjectUserId: stranger.id, restatement: "?" }),
      pendingExpiresAt: new Date(Date.now() + 600_000),
    },
  });
  const reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, "yes");
  assert.match(reply, /permission/i);
  // No booking should have happened for the stranger.
  assert.equal(await prisma.task.count({ where: { subjectUserId: stranger.id, kind: "book" } }), 0);
});

test("the agent remembers a stated preference across sessions (cross-session memory)", async (t) => {
  if (!llmAvailable()) return t.skip("no LLM configured");
  const op = await mkOperator("memory");

  // Session 1: the user states durable preferences.
  await rememberFromTurn(op.id, op.householdId, "Just so you know, I prefer morning appointments and I always use my Aetna insurance.", []);

  // A later session is just a fresh load — memory persists on the conversation row, not in history.
  const mem = await loadMemory(op.id);
  assert.ok(mem.length >= 1, "a durable preference should be stored");
  assert.match(mem.join(" | ").toLowerCase(), /morning|aetna/, "stored memory should capture the preference");

  // Re-stating the same thing must not balloon memory (dedupe).
  await rememberFromTurn(op.id, op.householdId, "I prefer morning appointments.", mem);
  const mem2 = await loadMemory(op.id);
  assert.ok(mem2.length <= mem.length + 1, "duplicate preference should not grow memory");
});

test("proactive outreach is throttled to once per day per operator", async () => {
  const op = await mkOperator("proactive");
  await prisma.user.update({ where: { id: op.id }, data: { lastWhatsappInboundAt: new Date() } });
  await prisma.healthAlert.create({
    data: { userId: op.id, severity: "watch", rank: 10, category: "trend", title: "LDL trending up", detail: "Discuss with your provider." },
  });

  await runProactiveOutreachTick();
  const after1 = await prisma.user.findUnique({ where: { id: op.id }, select: { lastProactiveAt: true } });
  assert.ok(after1?.lastProactiveAt, "lastProactiveAt should be set after the first tick");

  await runProactiveOutreachTick();
  const after2 = await prisma.user.findUnique({ where: { id: op.id }, select: { lastProactiveAt: true } });
  assert.equal(after2?.lastProactiveAt?.getTime(), after1?.lastProactiveAt?.getTime(), "second tick within a day must not re-send");
});
