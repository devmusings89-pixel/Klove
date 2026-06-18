import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { prisma } from "../src/db.js";
import { webhookRoutes } from "../src/routes/webhooks.js";

/** A Fastify app with just the Vapi webhook route. */
async function buildApp() {
  const app = Fastify();
  await app.register(webhookRoutes);
  await app.ready();
  return app;
}

const SUFFIX = `callstatus-${process.pid}-${process.hrtime.bigint()}`;
const userIds: string[] = [];

after(async () => {
  await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

/** A session with one calling target carrying a known Vapi call id. */
async function mkCallingTarget(tag: string, callId: string) {
  const u = await prisma.user.create({ data: { email: `${tag}.${SUFFIX}@klove.test` } });
  userIds.push(u.id);
  const session = await prisma.session.create({
    data: {
      userId: u.id, tier: "human", kind: "booking", status: "in_progress", patientInfo: "{}",
      targets: { create: { officeName: "Clinic", order: 0, status: "calling", vapiCallId: callId, calledAt: new Date() } },
    },
    include: { targets: true },
  });
  return { targetId: session.targets[0].id };
}

async function postStatus(app: Awaited<ReturnType<typeof buildApp>>, callId: string, status: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/vapi",
    payload: { message: { type: "status-update", status, call: { id: callId } } },
  });
}

test("vapi status-update refines an active call: calling → ringing → in_call", async () => {
  const app = await buildApp();
  const callId = `vapi-${SUFFIX}-a`;
  const { targetId } = await mkCallingTarget("a", callId);

  await postStatus(app, callId, "ringing");
  assert.equal((await prisma.callTarget.findUnique({ where: { id: targetId } }))?.status, "ringing");

  await postStatus(app, callId, "in-progress");
  assert.equal((await prisma.callTarget.findUnique({ where: { id: targetId } }))?.status, "in_call");
});

test("vapi status-update never overwrites a finalized target (booked stays booked)", async () => {
  const app = await buildApp();
  const callId = `vapi-${SUFFIX}-b`;
  const { targetId } = await mkCallingTarget("b", callId);
  await prisma.callTarget.update({ where: { id: targetId }, data: { status: "booked" } });

  await postStatus(app, callId, "in-progress");
  assert.equal((await prisma.callTarget.findUnique({ where: { id: targetId } }))?.status, "booked", "finalized status is owned by end-of-call-report");
});

test("unrecognized vapi statuses leave the target unchanged", async () => {
  const app = await buildApp();
  const callId = `vapi-${SUFFIX}-c`;
  const { targetId } = await mkCallingTarget("c", callId);

  await postStatus(app, callId, "queued");
  assert.equal((await prisma.callTarget.findUnique({ where: { id: targetId } }))?.status, "calling");
});
