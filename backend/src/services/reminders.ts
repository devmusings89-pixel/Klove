// Reminder firing (Klove). Due reminders become Messages in the member's household (the inbox);
// the scheduler tick drains them. In Phase 5 a fired Message also pushes via APNs.

import { prisma } from "../db.js";
import { sendPushToUser } from "./push.js";

function nextFire(from: Date, repeatRule: string): Date {
  const d = new Date(from);
  switch (repeatRule) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    default: d.setFullYear(d.getFullYear() + 100); // effectively once
  }
  return d;
}

/** Fire all due reminders: emit a Message and either reschedule (repeat) or mark fired. */
export async function runReminderTick(): Promise<number> {
  const due = await prisma.reminder.findMany({
    where: { status: "scheduled", fireAt: { lte: new Date() } },
    take: 100,
  });

  let fired = 0;
  for (const r of due) {
    const membership = await prisma.householdMembership.findFirst({
      where: { userId: r.subjectUserId },
      select: { householdId: true },
    });
    if (membership) {
      await prisma.message.create({
        data: {
          householdId: membership.householdId,
          subjectUserId: r.subjectUserId,
          direction: "out",
          channel: r.channel,
          title: "Reminder",
          body: r.title,
          relatedTaskId: r.taskId ?? undefined,
        },
      });
      await sendPushToUser(r.subjectUserId, "Klove reminder", r.title);
    }
    if (r.repeatRule) {
      await prisma.reminder.update({ where: { id: r.id }, data: { fireAt: nextFire(r.fireAt, r.repeatRule) } });
    } else {
      await prisma.reminder.update({ where: { id: r.id }, data: { status: "fired" } });
    }
    fired++;
  }
  return fired;
}

/**
 * Auto-create a "day before" reminder for each upcoming scheduled appointment that doesn't have one
 * yet. Runs on the scheduler tick. Idempotent via sourceAppointmentId.
 */
export async function autoGenerateReminders(): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 86_400_000); // next 60 days
  const appts = await prisma.appointment.findMany({
    where: { status: "scheduled", startsAt: { gt: now, lte: horizon } },
    take: 200,
  });

  let created = 0;
  for (const a of appts) {
    if (!a.startsAt) continue;
    const existing = await prisma.reminder.findFirst({ where: { sourceAppointmentId: a.id, status: { not: "cancelled" } } });
    if (existing) continue;
    // Fire `reminderLeadHours` before (or right away if the visit is sooner than that).
    const pref = await prisma.user.findUnique({ where: { id: a.userId }, select: { reminderLeadHours: true } });
    const leadMs = (pref?.reminderLeadHours ?? 24) * 3_600_000;
    const before = new Date(a.startsAt.getTime() - leadMs);
    const fireAt = before > now ? before : now;
    await prisma.reminder.create({
      data: {
        subjectUserId: a.userId,
        sourceAppointmentId: a.id,
        title: `Tomorrow: ${a.title}${a.provider ? ` with ${a.provider}` : ""}`,
        fireAt,
        channel: "push",
      },
    });
    created++;
  }
  return created;
}

/** Cancel auto-generated reminders for an appointment (used when it's cancelled/rescheduled away). */
export async function cancelAppointmentReminders(appointmentId: string): Promise<void> {
  await prisma.reminder.updateMany({
    where: { sourceAppointmentId: appointmentId, status: "scheduled" },
    data: { status: "cancelled" },
  });
}
