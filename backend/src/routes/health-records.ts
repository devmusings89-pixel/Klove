import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { fromJson } from "../services/json.js";

/**
 * Read-only views of a user's normalized health record + alerts, and per-document status.
 * Every query is scoped to req.user.id (server-side ownership; RLS is defense-in-depth).
 */
export async function healthRecordRoutes(app: FastifyInstance) {
  // Full normalized record set, grouped by resource type.
  app.get("/health-records", { preHandler: requireUser }, async (req) => {
    const userId = req.user!.id;
    const [observations, conditions, medications, reports, allergies] = await Promise.all([
      prisma.observation.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.condition.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.medicationStatement.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.diagnosticReport.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
      prisma.allergyIntolerance.findMany({ where: { userId }, orderBy: { recordedAt: "desc" } }),
    ]);
    return { observations, conditions, medications, reports, allergies };
  });

  // Appointments parsed from email/documents, soonest first (drives reminders).
  app.get("/appointments", { preHandler: requireUser }, async (req) => {
    const appointments = await prisma.appointment.findMany({
      where: { userId: req.user!.id },
      orderBy: { startsAt: "asc" },
    });
    return appointments;
  });

  // Extraction status for one uploaded/ingested document.
  app.get<{ Params: { id: string } }>("/health-records/documents/:id", { preHandler: requireUser }, async (req, reply) => {
    const doc = await prisma.healthDocument.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { jobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!doc) return reply.code(404).send({ error: "not_found" });
    return {
      id: doc.id,
      sourceType: doc.sourceType,
      mimeType: doc.mimeType,
      originalName: doc.originalName,
      status: doc.status,
      lastJob: doc.jobs[0] ? { kind: doc.jobs[0].kind, status: doc.jobs[0].status, summary: doc.jobs[0].resultSummary } : null,
      createdAt: doc.createdAt,
    };
  });

  // Alerts surfaced by the analysis pass.
  app.get("/health-records/alerts", { preHandler: requireUser }, async (req) => {
    const alerts = await prisma.healthAlert.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ acknowledgedAt: "asc" }, { createdAt: "desc" }],
    });
    return alerts.map((a) => ({ ...a, relatedResourceIds: fromJson<string[]>(a.relatedResourceIds, []) }));
  });

  // Acknowledge (dismiss) an alert.
  app.post<{ Params: { id: string } }>("/health-records/alerts/:id/ack", { preHandler: requireUser }, async (req, reply) => {
    const updated = await prisma.healthAlert.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { acknowledgedAt: new Date() },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });
}
