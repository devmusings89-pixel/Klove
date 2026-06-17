import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";
import { fromJson } from "../services/json.js";

/**
 * The chief-of-staff briefing. Aggregates across every member the operator can act on into three
 * buckets — Needs You · Waiting · Handled — plus upcoming appointments. Action over information:
 * this is the home surface, not a data dump.
 */
export async function todayRoutes(app: FastifyInstance) {
  app.get("/today", { preHandler: requireUser }, async (req) => {
    const subjects = await accessibleSubjects(req.user!.id);
    const ids = subjects.map((s) => s.id);
    const nameById = new Map(subjects.map((s) => [s.id, s.name]));

    const [tasks, appointments] = await Promise.all([
      prisma.task.findMany({
        where: { subjectUserId: { in: ids } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.appointment.findMany({
        where: { userId: { in: ids }, status: "scheduled", startsAt: { gte: new Date() } },
        orderBy: { startsAt: "asc" },
        take: 5,
      }),
    ]);

    const shape = (t: (typeof tasks)[number]) => ({
      id: t.id,
      title: t.title,
      detail: t.detail,
      kind: t.kind,
      state: t.state,
      memberName: nameById.get(t.subjectUserId) ?? "Member",
      subjectUserId: t.subjectUserId,
      options: fromJson<string[]>(t.options, []),
      createdAt: t.createdAt,
    });

    return {
      needsYou: tasks.filter((t) => t.state === "needs_you").map(shape),
      waiting: tasks.filter((t) => t.state === "waiting").map(shape),
      handled: tasks.filter((t) => t.state === "handled").slice(0, 10).map(shape),
      upcomingAppointments: appointments.map((a) => ({
        id: a.id,
        title: a.title,
        provider: a.provider,
        startsAt: a.startsAt,
        subjectUserId: a.userId,
        memberName: nameById.get(a.userId) ?? "Member",
        verified: a.verified,
        confirmation: a.confirmation,
      })),
      members: subjects,
    };
  });
}
