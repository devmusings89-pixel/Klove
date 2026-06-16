import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { toJson } from "../services/json.js";
import { createPaymentIntent } from "../services/stripe.js";
import { placeNextCall, placeBookingCallback, placeInfoCallback, submitVerification } from "../services/orchestrator.js";
import { enabled } from "../config.js";
import { fromJson } from "../services/json.js";
import { CreateSessionSchema, ChooseSlotSchema, ProvideInfoSchema, VerifyCodeSchema } from "../types.js";
import { serializeSession } from "./serialize.js";
import { requireUser } from "../services/auth.js";

const withTargets = { targets: { orderBy: { order: "asc" }, include: { results: true } } } as const;

export async function sessionRoutes(app: FastifyInstance) {
  // All of the current user's booking sessions (newest first) — powers the Appointments hub.
  app.get("/sessions", { preHandler: requireUser }, async (req) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      include: withTargets,
    });
    return sessions.map(serializeSession);
  });

  // Create a draft session + PaymentIntent.
  app.post("/sessions", async (req, reply) => {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const input = parsed.data;

    // Enforce the call cap server-side regardless of client.
    const targets = input.targets.slice(0, config.maxCallsPerSession);

    const user = await prisma.user.upsert({
      where: { email: input.email },
      create: { email: input.email, deviceId: input.deviceId },
      update: { deviceId: input.deviceId },
    });

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        status: "draft",
        patientInfo: toJson(input.patientInfo),
        maxCalls: config.maxCallsPerSession,
        minutesCap: config.minutesCapPerSession,
        stopWhenBooked: input.stopWhenBooked,
        targets: {
          create: targets.map((t, i) => ({
            officeName: t.officeName,
            phoneNumber: t.phoneNumber,
            website: t.website,
            channelHints: t.email ? toJson({ email: t.email }) : null,
            timezone: t.timezone,
            order: i,
          })),
        },
      },
    });

    const pi = await createPaymentIntent(session.id);
    await prisma.session.update({
      where: { id: session.id },
      data: { stripePaymentIntentId: pi.paymentIntentId },
    });

    return reply.code(201).send({
      sessionId: session.id,
      clientSecret: pi.clientSecret,
      priceCents: config.sessionPriceCents,
      // In mock mode there's no Stripe webhook, so allow the client to confirm directly.
      mockPayment: !enabled.stripe(),
    });
  });

  // Full session state (polling source for the iOS progress screen).
  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      include: withTargets,
    });
    if (!session) return reply.code(404).send({ error: "not_found" });
    return serializeSession(session);
  });

  // Patient picks one of the offered slots → place the booking callback to that office.
  app.post<{ Params: { id: string } }>("/sessions/:id/choose", async (req, reply) => {
    const parsed = ChooseSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, slot } = parsed.data;

    const target = await prisma.callTarget.findFirst({
      where: { id: targetId, sessionId: req.params.id },
    });
    if (!target) return reply.code(404).send({ error: "target_not_found" });

    const offered = fromJson<string[]>(target.offeredSlots, []);
    if (!offered.includes(slot)) {
      return reply.code(400).send({ error: "slot_not_offered", offered });
    }

    void placeBookingCallback(targetId, slot); // fire and forget
    return reply.send({ ok: true });
  });

  // Patient supplies info the office required → re-call that office with the answers.
  app.post<{ Params: { id: string } }>("/sessions/:id/provide-info", async (req, reply) => {
    const parsed = ProvideInfoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, answers } = parsed.data;

    const target = await prisma.callTarget.findFirst({
      where: { id: targetId, sessionId: req.params.id },
    });
    if (!target) return reply.code(404).send({ error: "target_not_found" });

    void placeInfoCallback(targetId, answers); // fire and forget
    return reply.send({ ok: true });
  });

  // Patient enters the one-time code an online scheduler sent → resume the held session & confirm.
  app.post<{ Params: { id: string } }>("/sessions/:id/verify", async (req, reply) => {
    const parsed = VerifyCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, code } = parsed.data;

    const target = await prisma.callTarget.findFirst({
      where: { id: targetId, sessionId: req.params.id },
    });
    if (!target) return reply.code(404).send({ error: "target_not_found" });
    if (target.status !== "awaiting_verification") {
      return reply.code(409).send({ error: "not_awaiting_verification", status: target.status });
    }

    void submitVerification(targetId, code); // fire and forget
    return reply.send({ ok: true });
  });

  // Server-Sent Events stream of session state for live progress. Closes when terminal.
  app.get<{ Params: { id: string } }>("/sessions/:id/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });

    while (!closed) {
      const session = await prisma.session.findUnique({
        where: { id: req.params.id },
        include: withTargets,
      });
      if (!session) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "not_found" })}\n\n`);
        break;
      }
      reply.raw.write(`data: ${JSON.stringify(serializeSession(session))}\n\n`);
      if (session.status === "completed" || session.status === "failed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    reply.raw.end();
  });

  // Mock-mode payment confirmation (no Stripe). Marks the session paid and starts calling.
  app.post<{ Params: { id: string } }>("/sessions/:id/confirm-mock-payment", async (req, reply) => {
    if (enabled.stripe()) return reply.code(400).send({ error: "stripe_enabled_use_webhook" });
    const session = await prisma.session.findUnique({ where: { id: req.params.id } });
    if (!session) return reply.code(404).send({ error: "not_found" });
    await prisma.session.update({ where: { id: session.id }, data: { status: "paid" } });
    void placeNextCall(session.id); // fire and forget
    return reply.send({ ok: true });
  });
}
