// The chief-of-staff briefing, as a reusable service. routes/today.ts serves this over HTTP; the
// WhatsApp briefing subagent (services/agents/briefing.ts) calls it directly. Aggregates across every
// member the operator can act on into Needs You · Waiting · Handled, plus upcoming appointments.

import { prisma } from "../db.js";
import { accessibleSubjects } from "./household.js";
import { fromJson } from "./json.js";

export interface BriefingTask {
  id: string;
  title: string;
  detail: string | null;
  kind: string;
  state: string;
  memberName: string;
  subjectUserId: string;
  options: string[];
  booking: unknown;
  followUp: unknown;
  createdAt: Date;
}

export interface BriefingAppointment {
  id: string;
  title: string;
  provider: string | null;
  startsAt: Date | null;
  subjectUserId: string;
  memberName: string;
  verified: boolean;
  confirmation: string | null;
}

export interface TodayBriefing {
  needsYou: BriefingTask[];
  waiting: BriefingTask[];
  handled: BriefingTask[];
  upcomingAppointments: BriefingAppointment[];
  members: { id: string; name: string }[];
}

/** Build the Today briefing for an operator across every member they can act on. */
export async function buildTodayBriefing(operatorUserId: string): Promise<TodayBriefing> {
  const subjects = await accessibleSubjects(operatorUserId);
  const ids = subjects.map((s) => s.id);
  const nameById = new Map(subjects.map((s) => [s.id, s.name]));

  const [tasks, appointments] = await Promise.all([
    prisma.task.findMany({ where: { subjectUserId: { in: ids } }, orderBy: { createdAt: "desc" } }),
    prisma.appointment.findMany({
      where: { userId: { in: ids }, status: "scheduled", startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      take: 5,
    }),
  ]);

  const shape = (t: (typeof tasks)[number]): BriefingTask => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    kind: t.kind,
    state: t.state,
    memberName: nameById.get(t.subjectUserId) ?? "Member",
    subjectUserId: t.subjectUserId,
    options: fromJson<string[]>(t.options, []),
    booking: fromJson<unknown>(t.bookingJson, null),
    followUp: fromJson<unknown>(t.followUpJson, null),
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
}
