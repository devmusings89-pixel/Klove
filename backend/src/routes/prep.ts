import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError, type AccessLevel } from "../services/auth.js";
import { ensureHousehold } from "../services/household.js";
import { buildBrief, saveQuestions } from "../services/prep.js";
import { bookAppointment } from "../services/concierge.js";
import { resolveOffice } from "../services/lookup.js";
import { cancelAppointmentReminders } from "../services/reminders.js";
import { audit } from "../services/audit.js";

/**
 * Appointment-prep hero flow (J4): assemble a one-page brief + personalized questions, authorize
 * Klove to act, hand off booking to the concierge, and capture the visit summary into follow-ups.
 */
export async function prepRoutes(app: FastifyInstance) {
  async function subjectOr403(req: FastifyRequest, reply: FastifyReply, id: string, need: AccessLevel, category?: string) {
    try {
      return (await resolveSubject(req, id, { need, category })).userId;
    } catch (err) {
      reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
      return null;
    }
  }

  // The one-page brief + drafted questions for a member's upcoming visit.
  app.get<{ Params: { id: string }; Querystring: { appointmentId?: string } }>(
    "/members/:id/prep",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "view", "records");
      if (!userId) return;
      return reply.send(await buildBrief(userId, req.query.appointmentId));
    },
  );

  // Save operator-edited questions.
  app.patch<{ Params: { id: string; apptId: string }; Body: { questions: string[] } }>(
    "/members/:id/appointments/:apptId/questions",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "appointments");
      if (!userId) return;
      const questions = (req.body?.questions ?? []).filter((q) => typeof q === "string");
      await saveQuestions(userId, req.params.apptId, questions);
      return reply.send({ ok: true, questions });
    },
  );

  // Authorize Klove to act on the member's behalf (book/call). Records the authorization.
  app.post<{ Params: { id: string } }>("/members/:id/authorize-booking", { preHandler: requireUser }, async (req, reply) => {
    const userId = await subjectOr403(req, reply, req.params.id, "operate");
    if (!userId) return;
    const householdId = await ensureHousehold(req.user!.id);
    await prisma.message.create({
      data: {
        householdId,
        subjectUserId: userId,
        direction: "out",
        channel: "inapp",
        title: "Authorized",
        body: "You authorized Klove to book and coordinate this appointment on your behalf.",
      },
    });
    await audit(req.user!.id, "booking_authorized", userId);
    return reply.send({ ok: true, authorizedAt: new Date().toISOString() });
  });

  // Resolve an office by name so the booking form can confirm "found it" before the user books.
  // Returns { match: OfficeMatch | null }; the client debounces calls as the user types.
  app.get<{ Querystring: { q?: string } }>(
    "/lookup/office",
    { preHandler: requireUser },
    async (req, reply) => {
      const q = (req.query?.q ?? "").trim();
      if (q.length < 3) return reply.send({ match: null });
      return reply.send({ match: await resolveOffice(q) });
    },
  );

  // Book on the member's behalf (concierge). Live (Vapi/web/email) when LIVE_BOOKING is on and we can
  // reach the office; otherwise the outcome is "needs_info" and a task is surfaced to finish it.
  // Klove never fabricates a provisional appointment — status is "in_progress" or "needs_info".
  app.post<{ Params: { id: string }; Body: { reason?: string; provider?: string; preferredDate?: string; preferredTimes?: string; phone?: string; website?: string; insurancePlanId?: string } }>(
    "/members/:id/book",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "operate");
      if (!userId) return;
      const householdId = await ensureHousehold(req.user!.id);
      const reason = req.body?.reason?.trim() || "Appointment booking";
      const outcome = await bookAppointment(req.user!.id, userId, householdId, {
        reason,
        provider: req.body?.provider,
        preferredDate: req.body?.preferredDate,
        preferredTimes: req.body?.preferredTimes,
        phone: req.body?.phone,
        website: req.body?.website,
        insurancePlanId: req.body?.insurancePlanId,
      });
      // Don't write the free-text visit reason (PHI) into the audit trail — the audit helper is
      // explicitly "who did what, to whom, no PHI bodies". Record only that a booking was requested.
      await audit(req.user!.id, "booking_requested", userId);
      return reply.code(201).send(outcome);
    },
  );

  // Cancel or reschedule an appointment. Body: { status?: "cancelled" } and/or { startsAt?: ISO }.
  app.patch<{ Params: { id: string; apptId: string }; Body: { status?: string; startsAt?: string } }>(
    "/members/:id/appointments/:apptId",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "appointments");
      if (!userId) return;
      const appt = await prisma.appointment.findFirst({ where: { id: req.params.apptId, userId } });
      if (!appt) return reply.code(404).send({ error: "not_found" });

      const data: { status?: string; startsAt?: Date } = {};
      if (req.body?.status === "cancelled") data.status = "cancelled";
      if (req.body?.startsAt) {
        const d = new Date(req.body.startsAt);
        if (!Number.isNaN(d.getTime())) data.startsAt = d;
      }
      if (!Object.keys(data).length) return reply.code(400).send({ error: "nothing_to_update" });

      const updated = await prisma.appointment.update({ where: { id: appt.id }, data });
      // Cancel existing reminders; the tick re-creates one for the new time if still scheduled.
      await cancelAppointmentReminders(appt.id);
      return reply.send(updated);
    },
  );

  // Capture an after-visit summary and spawn follow-up tasks.
  app.post<{ Params: { id: string; apptId: string }; Body: { summary: string; followUps?: string[] } }>(
    "/members/:id/appointments/:apptId/summary",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = await subjectOr403(req, reply, req.params.id, "manage", "appointments");
      if (!userId) return;
      const householdId = await ensureHousehold(req.user!.id);
      const summary = req.body?.summary?.trim();
      if (!summary) return reply.code(400).send({ error: "summary required" });

      await prisma.appointment.updateMany({
        where: { id: req.params.apptId, userId },
        data: { status: "completed", notes: JSON.stringify({ visitSummary: summary }) },
      });

      const followUps = (req.body?.followUps ?? []).filter((f) => typeof f === "string" && f.trim());
      const createdTasks: string[] = [];
      for (const f of followUps) {
        const t = await prisma.task.create({
          data: { subjectUserId: userId, householdId, title: f.trim(), state: "needs_you", kind: "follow_up", detail: "From your recent visit." },
        });
        createdTasks.push(t.id);
      }
      return reply.send({ ok: true, followUpTasks: createdTasks.length });
    },
  );
}
