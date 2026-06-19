import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";
import { placeBookingCallback } from "../services/orchestrator.js";
import { appendQuestion } from "../services/prep.js";
import { fromJson } from "../services/json.js";

const STATES = new Set(["needs_you", "waiting", "handled", "snoozed"]);

/** Resurface snoozed tasks whose snooze window has elapsed (snoozed → needs_you). Runs on the tick. */
export async function resurfaceSnoozedTasks(): Promise<number> {
  const res = await prisma.task.updateMany({
    where: { state: "snoozed", dueAt: { lte: new Date() } },
    data: { state: "needs_you" },
  });
  return res.count;
}

/**
 * The Actions log + task state machine. Tasks belong to members; the operator sees tasks for every
 * member they can act on (self + active consent). Each task carries one clear next step and a
 * visible status (Needs You · Waiting · Handled).
 */
export async function taskRoutes(app: FastifyInstance) {
  // All tasks across the household the operator can act on, with the subject member's name.
  app.get("/tasks", { preHandler: requireUser }, async (req) => {
    const subjects = await accessibleSubjects(req.user!.id);
    const nameById = new Map(subjects.map((s) => [s.id, s.name]));
    const tasks = await prisma.task.findMany({
      where: { subjectUserId: { in: subjects.map((s) => s.id) } },
      orderBy: [{ state: "asc" }, { createdAt: "desc" }],
    });
    return tasks.map((t) => ({ ...t, memberName: nameById.get(t.subjectUserId) ?? "Member", options: fromJson<string[]>(t.options, []), booking: fromJson<unknown>(t.bookingJson, null), followUp: fromJson<unknown>(t.followUpJson, null) }));
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "view" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    return task;
  });

  // Advance a task (approve/handle/snooze). Needs manage access over the subject.
  app.patch<{ Params: { id: string }; Body: { state?: string } }>(
    "/tasks/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const task = await prisma.task.findUnique({ where: { id: req.params.id } });
      if (!task) return reply.code(404).send({ error: "not_found" });
      try {
        await resolveSubject(req, task.subjectUserId, { need: "manage" });
      } catch (err) {
        return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
      }
      const state = req.body?.state;
      if (!state || !STATES.has(state)) return reply.code(400).send({ error: "invalid_state" });
      const updated = await prisma.task.update({ where: { id: task.id }, data: { state } });
      return updated;
    },
  );

  // Snooze a task — hide it from Today for `days`, then resurface it (the spec's "do it now,
  // snooze, or hand to concierge"). Reuses dueAt as the resurface time; the tick brings it back.
  app.post<{ Params: { id: string }; Body: { days?: number } }>("/tasks/:id/snooze", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "manage" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    const days = Math.min(Math.max(Math.round(req.body?.days ?? 7), 1), 90);
    const dueAt = new Date(Date.now() + days * 86_400_000);
    const updated = await prisma.task.update({ where: { id: task.id }, data: { state: "snoozed", dueAt } });
    return reply.send(updated);
  });

  // Dismiss/delete a task (needs manage over the subject).
  app.delete<{ Params: { id: string } }>("/tasks/:id", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "manage" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    await prisma.task.delete({ where: { id: task.id } });
    return reply.send({ ok: true });
  });

  // Pick one of the alternate times the office offered (kind=choose_time) → book that slot.
  app.post<{ Params: { id: string }; Body: { slot: string } }>("/tasks/:id/choose", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task || !task.conciergeJobId) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "operate" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    const slot = req.body?.slot;
    const offered = fromJson<string[]>(task.options, []);
    if (!slot || !offered.includes(slot)) return reply.code(400).send({ error: "slot_not_offered", offered });

    const target = await prisma.callTarget.findFirst({
      where: { sessionId: task.conciergeJobId, status: "awaiting_choice" },
    });
    if (!target) return reply.code(409).send({ error: "not_awaiting_choice" });

    // Back to waiting while Klove books the chosen slot; reconcile finalizes it to handled.
    await prisma.task.update({
      where: { id: task.id },
      data: { state: "waiting", kind: "book", detail: `Booking ${slot}…`, title: task.title.replace(/^Pick a time:\s*/, "Booking: ") },
    });
    void placeBookingCallback(target.id, slot); // fire-and-forget
    return reply.send({ ok: true, slot });
  });

  // Borderline health-insight → "Book a follow-up". Convert the review task into a booking task the
  // user can act on through the normal booking path. Honest in mock mode: no fake "handling".
  app.post<{ Params: { id: string } }>("/tasks/:id/book-follow-up", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "manage" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    const followUp = fromJson<{ recommendedSpecialty?: string }>(task.followUpJson, {});
    const specialty = followUp?.recommendedSpecialty;
    const detail = specialty
      ? `Book a follow-up with ${specialty} to review: ${task.title}`
      : `Book a follow-up to review: ${task.title}`;
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { state: "needs_you", kind: "book", detail },
    });
    return { ...updated, options: fromJson<string[]>(updated.options, []), booking: fromJson<unknown>(updated.bookingJson, null), followUp: fromJson<unknown>(updated.followUpJson, null) };
  });

  // Borderline health-insight → "Add as a question to an upcoming visit". Attaches the insight to a
  // scheduled appointment's notes so it's raised at the visit, and marks the insight handled.
  app.post<{ Params: { id: string }; Body: { appointmentId?: string; question?: string } }>(
    "/tasks/:id/attach-question",
    { preHandler: requireUser },
    async (req, reply) => {
      const task = await prisma.task.findUnique({ where: { id: req.params.id } });
      if (!task) return reply.code(404).send({ error: "not_found" });
      try {
        await resolveSubject(req, task.subjectUserId, { need: "manage" });
      } catch (err) {
        return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
      }
      const appointmentId = req.body?.appointmentId;
      if (!appointmentId) return reply.code(400).send({ error: "missing_appointment" });
      const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
      // The appointment must belong to the same member and still be upcoming.
      if (!appt || appt.userId !== task.subjectUserId || appt.status !== "scheduled" || !appt.startsAt || appt.startsAt < new Date()) {
        return reply.code(404).send({ error: "appointment_not_available" });
      }
      const question = (req.body?.question?.trim() || task.title).trim();
      // Store via the prep question list (notes holds {questions:[…]} JSON) so it shows up in the
      // appointment's Discussion → Questions, not as a corrupting free-text append.
      const ok = await appendQuestion(task.subjectUserId, appt.id, question);
      if (!ok) return reply.code(404).send({ error: "appointment_not_available" });
      await prisma.task.update({ where: { id: task.id }, data: { state: "handled" } });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Added to your upcoming visit",
          body: `We'll raise "${question}" at your ${appt.provider ? `${appt.provider} ` : ""}visit.`,
          relatedTaskId: task.id,
        },
      });
      return reply.send({ ok: true });
    },
  );
}
