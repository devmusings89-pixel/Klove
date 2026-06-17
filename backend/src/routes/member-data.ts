import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { enabled } from "../config.js";
import { requireUser, resolveSubject, isConsentError, type AccessLevel } from "../services/auth.js";
import { fromJson } from "../services/json.js";
import { getSource } from "../sources/registry.js";
import { healthKitSource, healthKitArtifacts } from "../sources/healthkit.js";
import { ensureUploadConnection } from "../sources/upload.js";
import { gmailSource } from "../sources/gmail.js";
import { ingestArtifact } from "../services/ingestion.js";
import { runExtractionTick } from "../services/health-worker.js";
import { buildTimeline, buildSummary } from "../services/graph.js";
import { ALLOWED_UPLOAD_MIMES, MAX_UPLOAD_BYTES } from "./uploads.js";
import type { SourceType } from "../sources/types.js";
import { serializeProfile, upsertProfile, addInsurance, updateInsurance, deleteInsurance, listInsurance } from "../services/profiles.js";

// A representative health email for the mock scan (live mode pulls real mail via Gmail). Kept to a
// single message so the deterministic mock extractor doesn't create duplicate records.
const SAMPLE_EMAILS = [
  {
    sourceRef: "gmail:demo:lab-results",
    subject: "Your lab results are ready",
    text:
      "Hello,\n\nYour recent labs from City Lab are available in your patient portal.\n" +
      "Hemoglobin A1c: 6.4% (high). Glucose: 142 mg/dL (high).\n\n" +
      "This also confirms your Endocrinology follow-up with Dr. Lin at City Endocrinology, " +
      "500 Main St, Suite 210. Please discuss your results at the visit.\n",
  },
];

const VALID: SourceType[] = ["gmail", "imap", "healthkit", "aggregator", "upload"];

/**
 * Per-member views of the health pipeline. Each route resolves the subject member via
 * `resolveSubject` (self-or-consent) before scoping the existing, already userId-keyed pipeline to
 * that member. This is the Phase-2 fan-out of records, sources, uploads, and the timeline.
 */
export async function memberDataRoutes(app: FastifyInstance) {
  // Resolve the subject member or send a 403/500 and return null.
  async function subjectOr403(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    need: AccessLevel,
    category?: string,
  ): Promise<string | null> {
    try {
      const ctx = await resolveSubject(req, id, { need, category });
      return ctx.userId;
    } catch (err) {
      reply.code(isConsentError(err) ? 403 : 500).send({ error: err instanceof Error ? err.message : "error" });
      return null;
    }
  }

  // ---- Records / appointments / insights / timeline ----

  app.get<{ Params: { id: string } }>("/members/:id/health-records", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    const [observations, conditions, medications, reports, allergies] = await Promise.all([
      prisma.observation.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.condition.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.medicationStatement.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.diagnosticReport.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.allergyIntolerance.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
    ]);
    return reply.send({ observations, conditions, medications, reports, allergies });
  });

  app.get<{ Params: { id: string } }>("/members/:id/appointments", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "appointments");
    if (!userId) return;
    return reply.send(await prisma.appointment.findMany({ where: { userId }, orderBy: { startsAt: "asc" } }));
  });

  // Insights = ranked, unacknowledged HealthAlerts (the Today-briefing feed for this member).
  app.get<{ Params: { id: string } }>("/members/:id/insights", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    const alerts = await prisma.healthAlert.findMany({
      where: { userId },
      orderBy: [{ acknowledgedAt: "asc" }, { rank: "desc" }, { createdAt: "desc" }],
    });
    return reply.send(alerts.map((a) => ({ ...a, relatedResourceIds: fromJson<string[]>(a.relatedResourceIds, []) })));
  });

  app.get<{ Params: { id: string } }>("/members/:id/timeline", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    return reply.send(await buildTimeline(userId));
  });

  // Compact grounded snapshot (drives the member profile header + appointment briefs).
  app.get<{ Params: { id: string } }>("/members/:id/summary", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    return reply.send(await buildSummary(userId));
  });

  // Correct the record: remove a wrong timeline entry (operator's "this isn't right / not mine").
  app.delete<{ Params: { id: string; kind: string; recordId: string } }>(
    "/members/:id/records/:kind/:recordId",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
      if (!userId) return;
      const { kind, recordId } = req.params;
      const where = { id: recordId, userId };
      let count = 0;
      switch (kind) {
        case "observation": ({ count } = await prisma.observation.deleteMany({ where })); break;
        case "condition": ({ count } = await prisma.condition.deleteMany({ where })); break;
        case "medication": ({ count } = await prisma.medicationStatement.deleteMany({ where })); break;
        case "allergy": ({ count } = await prisma.allergyIntolerance.deleteMany({ where })); break;
        case "appointment": ({ count } = await prisma.appointment.deleteMany({ where })); break;
        case "report": ({ count } = await prisma.diagnosticReport.deleteMany({ where })); break;
        case "vital": ({ count } = await prisma.vitalSign.deleteMany({ where })); break;
        default: return reply.code(400).send({ error: "unsupported_kind" });
      }
      if (count === 0) return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true });
    },
  );

  // ---- Sources (connections) ----

  app.get<{ Params: { id: string } }>("/members/:id/sources", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view");
    if (!userId) return;
    const connections = await prisma.dataSourceConnection.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    return reply.send(
      connections.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        externalAccountId: c.externalAccountId,
        lastSyncedAt: c.lastSyncedAt,
        lastError: c.lastError,
      })),
    );
  });

  app.post<{ Params: { id: string; type: string }; Body: Record<string, unknown> }>(
    "/members/:id/sources/:type/connect",
    { preHandler: requireUser },
    async (req, reply) => {
      const type = req.params.type as SourceType;
      if (!VALID.includes(type)) return reply.code(400).send({ error: "invalid_source" });
      const category = type === "healthkit" ? "apple_health" : "records";
      const userId = await subjectOr403(req, reply, req.params.id, "manage", category);
      if (!userId) return;
      const source = getSource(type);
      if (!source) return reply.code(400).send({ error: "invalid_source" });
      try {
        return reply.send(await source.connect(userId, req.body ?? {}));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "connect_failed" });
      }
    },
  );

  app.post<{ Params: { id: string; type: string } }>(
    "/members/:id/sources/:type/disconnect",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage");
      if (!userId) return;
      await prisma.dataSourceConnection.updateMany({
        where: { userId, type: req.params.type },
        data: { status: "revoked", accessTokenEnc: null, refreshTokenEnc: null },
      });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { resources?: unknown[] } }>(
    "/members/:id/sources/healthkit/sync",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "apple_health");
      if (!userId) return;
      const resources = req.body?.resources ?? [];
      if (!Array.isArray(resources)) return reply.code(400).send({ error: "resources_must_be_array" });
      const { connectionId } = await healthKitSource.connect(userId, {});
      const artifacts = healthKitArtifacts(resources);
      let queued = 0;
      for (const a of artifacts) {
        const r = await ingestArtifact(userId, "healthkit", a, connectionId);
        if (r.status === "queued") queued++;
      }
      await prisma.dataSourceConnection.update({ where: { id: connectionId }, data: { lastSyncedAt: new Date() } });
      return reply.send({ received: artifacts.length, queued });
    },
  );

  // Connect / scan email for medical records. Live (Gmail configured): returns the OAuth redirect.
  // Mock: ingests representative health emails through the real pipeline so the timeline populates.
  app.post<{ Params: { id: string } }>("/members/:id/sources/email/connect", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
    if (!userId) return;

    if (enabled.gmail()) {
      try {
        const r = await gmailSource.connect(userId, {});
        return reply.send({ ...r, mode: "live" });
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "connect_failed" });
      }
    }

    // Mock scan: ensure a connection, ingest the sample emails (idempotent by sourceRef), then drain.
    const conn = await prisma.dataSourceConnection.upsert({
      where: { userId_type_externalAccountId: { userId, type: "gmail", externalAccountId: "demo" } },
      create: { userId, type: "gmail", status: "connected", externalAccountId: "demo" },
      update: { status: "connected", lastSyncedAt: new Date() },
    });
    let queued = 0;
    for (const e of SAMPLE_EMAILS) {
      const r = await ingestArtifact(
        userId,
        "gmail",
        { sourceRef: e.sourceRef, mimeType: "text/plain", text: `Subject: ${e.subject}\n\n${e.text}`, originalName: e.subject, receivedAt: new Date().toISOString() },
        conn.id,
      );
      if (r.status === "queued") queued++;
    }
    // Drain extraction + chained analysis so records show immediately. Loop until the queue is
    // actually empty (each tick can chain a follow-up job, e.g. extract → fhir_normalize →
    // analysis) rather than a fixed tick count that could leave jobs pending. Capped to avoid an
    // unbounded loop if a job keeps re-queuing.
    const MAX_DRAIN_TICKS = 50;
    for (let i = 0; i < MAX_DRAIN_TICKS; i++) {
      const pending = await prisma.extractionJob.count({ where: { status: "pending", runAfter: { lte: new Date() } } });
      if (pending === 0) break;
      await runExtractionTick();
    }
    return reply.send({ mode: "mock", scanned: SAMPLE_EMAILS.length, queued });
  });

  // ---- Upload a document for a specific member ----

  app.post<{ Params: { id: string } }>("/members/:id/uploads", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
    if (!userId) return;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no_file" });
    // Reject unsupported types before reading bytes (vision/OCR only handles images + PDF).
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) return reply.code(415).send({ error: "unsupported_media_type" });
    const bytes = await file.toBuffer();
    if (bytes.byteLength === 0) return reply.code(400).send({ error: "empty_file" });
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: "file_too_large" });
    const connectionId = await ensureUploadConnection(userId);
    const result = await ingestArtifact(
      userId,
      "upload",
      { bytes, mimeType: file.mimetype, originalName: file.filename, receivedAt: new Date().toISOString() },
      connectionId,
    );
    return reply.code(201).send({ documentId: result.documentId, status: result.status });
  });

  // ---- Per-member profile + insurance wallet ----
  // The operator manages each member's demographics and their own collection of insurance cards
  // (e.g. a child on the family plan, an aging parent on Medicare + a supplement). Booking links a
  // specific card per person, so the office gets the right coverage — not the operator's default.

  app.get<{ Params: { id: string } }>("/members/:id/profile", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    return { profile: await serializeProfile(userId) };
  });

  app.put<{ Params: { id: string }; Body: Record<string, string> }>("/members/:id/profile", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
    if (!userId) return;
    await upsertProfile(userId, req.body ?? {});
    return { profile: await serializeProfile(userId) };
  });

  app.get<{ Params: { id: string } }>("/members/:id/insurance", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
    if (!userId) return;
    return { plans: await listInsurance(userId) };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/members/:id/insurance", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
    if (!userId) return;
    const plans = await addInsurance(userId, req.body ?? {});
    return reply.code(201).send({ plans });
  });

  app.patch<{ Params: { id: string; planId: string }; Body: Record<string, unknown> }>(
    "/members/:id/insurance/:planId",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
      if (!userId) return;
      const plans = await updateInsurance(userId, req.params.planId, req.body ?? {});
      if (!plans) return reply.code(404).send({ error: "not_found" });
      return { plans };
    },
  );

  app.delete<{ Params: { id: string; planId: string } }>("/members/:id/insurance/:planId", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "manage", "records");
    if (!userId) return;
    const plans = await deleteInsurance(userId, req.params.planId);
    if (!plans) return reply.code(404).send({ error: "not_found" });
    return { plans };
  });
}
