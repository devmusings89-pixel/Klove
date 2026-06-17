import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError, type AccessLevel } from "../services/auth.js";
import { toJson, fromJson } from "../services/json.js";

/** Medication schedules, dose logging, and adherence. Drives the worker ticks in services/medications. */
export async function medicationRoutes(app: FastifyInstance) {
  async function subjectOr403(req: FastifyRequest, reply: FastifyReply, id: string, need: AccessLevel): Promise<string | null> {
    try {
      return (await resolveSubject(req, id, { need })).userId;
    } catch (err) {
      reply.code(isConsentError(err) ? 403 : 500).send({ error: err instanceof Error ? err.message : "error" });
      return null;
    }
  }

  // The member's medications, each with its dosing schedule and today's dose statuses.
  app.get<{ Params: { id: string } }>("/members/:id/medications", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view");
    if (!userId) return;
    const meds = await prisma.medicationStatement.findMany({
      where: { userId },
      orderBy: { recordedAt: "desc" },
      include: { schedules: { where: { active: true } } },
    });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todaysDoses = await prisma.doseLog.findMany({
      where: { subjectUserId: userId, scheduledAt: { gte: startOfDay } },
      orderBy: { scheduledAt: "asc" },
    });
    return meds.map((m) => {
      const schedule = m.schedules[0] ?? null;
      return {
        id: m.id,
        display: m.display,
        dosage: m.dosage,
        status: m.status,
        nextRefillDue: m.nextRefillDue,
        refillsRemaining: m.refillsRemaining,
        schedule: schedule
          ? { id: schedule.id, times: fromJson<string[]>(schedule.times, []), active: schedule.active, critical: schedule.critical }
          : null,
        todaysDoses: todaysDoses
          .filter((d) => d.medicationId === m.id)
          .map((d) => ({ id: d.id, scheduledAt: d.scheduledAt, status: d.status, takenAt: d.takenAt })),
      };
    });
  });

  // Create or replace the dosing schedule for a medication (times = ["08:00","18:00"]).
  app.post<{ Params: { id: string }; Body: { times?: string[]; active?: boolean; critical?: boolean } }>(
    "/medications/:id/schedule",
    { preHandler: requireUser },
    async (req, reply) => {
      const med = await prisma.medicationStatement.findUnique({ where: { id: req.params.id } });
      if (!med) return reply.code(404).send({ error: "not_found" });
      const userId = await subjectOr403(req, reply, med.userId, "manage");
      if (!userId) return;

      const times = (req.body?.times ?? [])
        .map((t) => t.trim())
        .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
      if (times.length === 0) return reply.code(400).send({ error: "at least one valid HH:MM time required" });

      // One active schedule per medication: deactivate any prior, then create the new one.
      await prisma.medicationSchedule.updateMany({ where: { medicationId: med.id, active: true }, data: { active: false } });
      const schedule = await prisma.medicationSchedule.create({
        data: {
          medicationId: med.id,
          subjectUserId: med.userId,
          label: med.display,
          times: toJson(times),
          active: req.body?.active ?? true,
          critical: req.body?.critical ?? false,
        },
      });
      return reply.code(201).send({ id: schedule.id, times, active: schedule.active, critical: schedule.critical });
    },
  );

  // Stop reminding for a medication (deactivate its schedule).
  app.delete<{ Params: { id: string } }>("/medications/:id/schedule", { preHandler: requireUser }, async (req, reply) => {
    const med = await prisma.medicationStatement.findUnique({ where: { id: req.params.id } });
    if (!med) return reply.code(404).send({ error: "not_found" });
    const userId = await subjectOr403(req, reply, med.userId, "manage");
    if (!userId) return;
    await prisma.medicationSchedule.updateMany({ where: { medicationId: med.id, active: true }, data: { active: false } });
    return reply.send({ ok: true });
  });

  // Mark a scheduled dose as taken.
  app.post<{ Params: { id: string } }>("/doses/:id/taken", { preHandler: requireUser }, async (req, reply) => {
    const dose = await prisma.doseLog.findUnique({ where: { id: req.params.id } });
    if (!dose) return reply.code(404).send({ error: "not_found" });
    const userId = await subjectOr403(req, reply, dose.subjectUserId, "manage");
    if (!userId) return;
    const updated = await prisma.doseLog.update({ where: { id: dose.id }, data: { status: "taken", takenAt: new Date() } });
    return reply.send({ id: updated.id, status: updated.status, takenAt: updated.takenAt });
  });

  // Change a dose's status: taken | skipped | pending (the last undoes a mistaken tap). Lets a
  // caregiver correct a fat-finger "taken", or record a deliberately skipped/held dose.
  app.post<{ Params: { id: string }; Body: { status?: string } }>("/doses/:id/status", { preHandler: requireUser }, async (req, reply) => {
    const status = req.body?.status;
    if (!status || !["taken", "skipped", "pending"].includes(status)) {
      return reply.code(400).send({ error: "status must be taken | skipped | pending" });
    }
    const dose = await prisma.doseLog.findUnique({ where: { id: req.params.id } });
    if (!dose) return reply.code(404).send({ error: "not_found" });
    const userId = await subjectOr403(req, reply, dose.subjectUserId, "manage");
    if (!userId) return;
    const updated = await prisma.doseLog.update({
      where: { id: dose.id },
      data: { status, takenAt: status === "taken" ? new Date() : null },
    });
    return reply.send({ id: updated.id, status: updated.status, takenAt: updated.takenAt });
  });

  // 7-day adherence summary for a member (taken / missed / pending counts + rate).
  app.get<{ Params: { id: string } }>("/members/:id/adherence", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "view");
    if (!userId) return;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const doses = await prisma.doseLog.findMany({ where: { subjectUserId: userId, scheduledAt: { gte: since } } });
    const taken = doses.filter((d) => d.status === "taken").length;
    const missed = doses.filter((d) => d.status === "missed").length;
    const pending = doses.filter((d) => d.status === "pending").length;
    const scored = taken + missed;
    return { windowDays: 7, total: doses.length, taken, missed, pending, adherenceRate: scored ? taken / scored : null };
  });
}
