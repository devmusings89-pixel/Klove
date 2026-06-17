import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { ensureHousehold, accessibleSubjects } from "../services/household.js";
import { placeBookingCallback } from "../services/orchestrator.js";
import { fromJson } from "../services/json.js";

const STATES = new Set(["needs_you", "waiting", "handled"]);

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
    return tasks.map((t) => ({ ...t, memberName: nameById.get(t.subjectUserId) ?? "Member", options: fromJson<string[]>(t.options, []) }));
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

  // Hand a task to the concierge engine — creates a (human-tier) Session and marks the task waiting.
  // Phase 4 fleshes out the booking handoff; here we create the job and link it.
  app.post<{ Params: { id: string } }>("/tasks/:id/route-to-concierge", { preHandler: requireUser }, async (req, reply) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return reply.code(404).send({ error: "not_found" });
    try {
      await resolveSubject(req, task.subjectUserId, { need: "operate" });
    } catch (err) {
      return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
    }
    await ensureHousehold(req.user!.id);
    const session = await prisma.session.create({
      data: {
        userId: task.subjectUserId,
        tier: "human",
        kind: "booking",
        status: "draft",
        patientInfo: JSON.stringify({ reason: task.title }),
      },
    });
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { state: "waiting", conciergeJobId: session.id },
    });
    // Make the handoff tangible: a confirmation lands in the inbox so the user knows a person has it.
    await prisma.message.create({
      data: {
        householdId: task.householdId,
        subjectUserId: task.subjectUserId,
        direction: "out",
        channel: "inapp",
        title: "Handed to a specialist",
        body: `A Klove specialist is taking over "${task.title}" and will update you here.`,
        relatedTaskId: task.id,
      },
    });
    return { ...updated, conciergeJobId: session.id };
  });
}
