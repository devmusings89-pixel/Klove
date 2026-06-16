import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";

/** Reminders: scheduled nudges that fire into the notifications inbox (and Phase-5 push). */
export async function reminderRoutes(app: FastifyInstance) {
  app.get("/reminders", { preHandler: requireUser }, async (req) => {
    const subjects = await accessibleSubjects(req.user!.id);
    const nameById = new Map(subjects.map((s) => [s.id, s.name]));
    const reminders = await prisma.reminder.findMany({
      where: { subjectUserId: { in: subjects.map((s) => s.id) }, status: { not: "cancelled" } },
      orderBy: { fireAt: "asc" },
    });
    return reminders.map((r) => ({ ...r, memberName: nameById.get(r.subjectUserId) ?? "Member" }));
  });

  app.post<{ Body: { subjectUserId?: string; title: string; fireAt: string; repeatRule?: string; taskId?: string } }>(
    "/reminders",
    { preHandler: requireUser },
    async (req, reply) => {
      const { subjectUserId, title, fireAt, repeatRule, taskId } = req.body ?? ({} as Record<string, string>);
      if (!title?.trim() || !fireAt) return reply.code(400).send({ error: "title and fireAt required" });
      let subject: string;
      try {
        subject = (await resolveSubject(req, subjectUserId, { need: "manage" })).userId;
      } catch (err) {
        return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
      }
      const reminder = await prisma.reminder.create({
        data: { subjectUserId: subject, title: title.trim(), fireAt: new Date(fireAt), repeatRule: repeatRule ?? null, taskId: taskId ?? null },
      });
      return reply.code(201).send(reminder);
    },
  );

  app.post<{ Params: { id: string } }>("/reminders/:id/cancel", { preHandler: requireUser }, async (req, reply) => {
    const reminder = await prisma.reminder.findUnique({ where: { id: req.params.id } });
    if (!reminder) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, reminder.subjectUserId, { need: "manage" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "cancelled" } });
    return reply.send({ ok: true });
  });
}
