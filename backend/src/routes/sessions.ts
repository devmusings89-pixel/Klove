import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { toJson } from "../services/json.js";
import { placeNextCall, placeBookingCallback, placeInfoCallback, submitVerification } from "../services/orchestrator.js";
import { fromJson } from "../services/json.js";
import { CreateSessionSchema, ChooseSlotSchema, ProvideInfoSchema, VerifyCodeSchema } from "../types.js";
import { serializeSession } from "./serialize.js";
import { requireUser } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";

const withTargets = { targets: { orderBy: { order: "asc" }, include: { results: true } } } as const;

/** True when `userId` may read this session: it's their own, or they have access to its subject. */
async function canAccessSession(userId: string, sessionUserId: string): Promise<boolean> {
  if (userId === sessionUserId) return true;
  const subjects = await accessibleSubjects(userId);
  return subjects.some((s) => s.id === sessionUserId);
}

/**
 * Load a session-scoped CallTarget after asserting the caller may act on the session it belongs to.
 * Returns the target, or null after replying 404 (target/session missing) / 403 (no access).
 */
async function authorizeTarget(
  req: { user?: { id: string } },
  reply: import("fastify").FastifyReply,
  sessionId: string,
  targetId: string,
) {
  const target = await prisma.callTarget.findFirst({
    where: { id: targetId, sessionId },
    include: { session: { select: { userId: true } } },
  });
  if (!target) {
    await reply.code(404).send({ error: "target_not_found" });
    return null;
  }
  if (!(await canAccessSession(req.user!.id, target.session.userId))) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return target;
}

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

  // Create a session and start calling immediately. Booking is free — no payment step.
  app.post("/sessions", { preHandler: requireUser }, async (req, reply) => {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const input = parsed.data;

    // Enforce the call cap server-side regardless of client.
    const targets = input.targets.slice(0, config.maxCallsPerSession);

    // The session owner is the authenticated caller — never the client-supplied email (which is
    // only the patient contact used for booking forms). Keep deviceId current.
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { deviceId: input.deviceId ?? undefined },
    });

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        status: "scheduling",
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

    void placeNextCall(session.id); // fire and forget — booking starts right away

    return reply.code(201).send({ sessionId: session.id });
  });

  // Full session state (polling source for the iOS progress screen). Auth + ownership required —
  // the payload includes the patient's info and call transcripts (PHI).
  app.get<{ Params: { id: string } }>("/sessions/:id", { preHandler: requireUser }, async (req, reply) => {
    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      include: withTargets,
    });
    if (!session) return reply.code(404).send({ error: "not_found" });
    if (!(await canAccessSession(req.user!.id, session.userId))) return reply.code(403).send({ error: "forbidden" });
    return serializeSession(session);
  });

  // Patient picks one of the offered slots → place the booking callback to that office.
  app.post<{ Params: { id: string } }>("/sessions/:id/choose", { preHandler: requireUser }, async (req, reply) => {
    const parsed = ChooseSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, slot } = parsed.data;

    const target = await authorizeTarget(req, reply, req.params.id, targetId);
    if (!target) return;

    const offered = fromJson<string[]>(target.offeredSlots, []);
    if (!offered.includes(slot)) {
      // Don't echo the full offered-slot set back in the error body.
      return reply.code(400).send({ error: "slot_not_offered" });
    }

    void placeBookingCallback(targetId, slot); // fire and forget
    return reply.send({ ok: true });
  });

  // Patient supplies info the office required → re-call that office with the answers.
  app.post<{ Params: { id: string } }>("/sessions/:id/provide-info", { preHandler: requireUser }, async (req, reply) => {
    const parsed = ProvideInfoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, answers } = parsed.data;

    const target = await authorizeTarget(req, reply, req.params.id, targetId);
    if (!target) return;

    void placeInfoCallback(targetId, answers); // fire and forget
    return reply.send({ ok: true });
  });

  // Patient enters the one-time code an online scheduler sent → resume the held session & confirm.
  app.post<{ Params: { id: string } }>("/sessions/:id/verify", { preHandler: requireUser }, async (req, reply) => {
    const parsed = VerifyCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { targetId, code } = parsed.data;

    const target = await authorizeTarget(req, reply, req.params.id, targetId);
    if (!target) return;
    if (target.status !== "awaiting_verification") {
      return reply.code(409).send({ error: "not_awaiting_verification", status: target.status });
    }

    void submitVerification(targetId, code); // fire and forget
    return reply.send({ ok: true });
  });

  // Server-Sent Events stream of session state for live progress. Closes when terminal.
  //
  // NOTE: the iOS client currently consumes session state via polling (SessionProgressView /
  // SessionLiveCard hitting GET /sessions/:id), NOT this stream — polling is the canonical
  // progress mechanism. This endpoint is kept for web/non-iOS clients, but it is bounded so an
  // idle/never-terminal session can't pin a DB poll loop + open connection indefinitely:
  //   - hard max lifetime (SSE_MAX_LIFETIME_MS): the stream ends even if the session never finishes;
  //   - if nothing changed, we send a lightweight `: heartbeat` comment instead of re-serializing.
  const SSE_MAX_LIFETIME_MS = 5 * 60_000; // 5 min cap per connection
  const SSE_POLL_MS = 2000;
  app.get<{ Params: { id: string } }>("/sessions/:id/events", { preHandler: requireUser }, async (req, reply) => {
    const owned = await prisma.session.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!owned || !(await canAccessSession(req.user!.id, owned.userId))) {
      return reply.code(owned ? 403 : 404).send({ error: owned ? "forbidden" : "not_found" });
    }
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });

    const deadline = Date.now() + SSE_MAX_LIFETIME_MS;
    let lastPayload = "";
    while (!closed) {
      if (Date.now() >= deadline) {
        // Don't hold the connection forever; tell the client to reconnect/poll and bow out.
        reply.raw.write(`event: timeout\ndata: ${JSON.stringify({ reason: "max_lifetime" })}\n\n`);
        break;
      }
      const session = await prisma.session.findUnique({
        where: { id: req.params.id },
        include: withTargets,
      });
      if (!session) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "not_found" })}\n\n`);
        break;
      }
      const payload = JSON.stringify(serializeSession(session));
      if (payload !== lastPayload) {
        reply.raw.write(`data: ${payload}\n\n`);
        lastPayload = payload;
      } else {
        // No state change — keep the connection alive cheaply without resending the whole payload.
        reply.raw.write(`: heartbeat\n\n`);
      }
      if (session.status === "completed" || session.status === "failed") break;
      await new Promise((r) => setTimeout(r, SSE_POLL_MS));
    }
    reply.raw.end();
  });

  // Deprecated: booking is free, so there's nothing to confirm. Kept as a tolerant no-op for
  // older clients that still call it after creating a session.
  app.post<{ Params: { id: string } }>("/sessions/:id/confirm-mock-payment", { preHandler: requireUser }, async (req, reply) => {
    const session = await prisma.session.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!session) return reply.code(404).send({ error: "not_found" });
    if (!(await canAccessSession(req.user!.id, session.userId))) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ ok: true });
  });
}
