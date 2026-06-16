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
