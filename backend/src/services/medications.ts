// Medication adherence (Klove). Turns dosing schedules into:
//  - dose reminders to the member (push) when a dose is due,
//  - missed-dose alerts to the CAREGIVER (inbox message + push + a Today task) when a due dose
//    goes unconfirmed — stronger and preference-bypassing for critical medications,
//  - refill nudges to the caregiver as a medication's supply runs low.
//
// Worker ticks are idempotent and accept an injectable `now` so they're deterministic in tests.
// Dose-log creation is DECOUPLED from the reminder window: a due slot always gets a DoseLog (so the
// missed-dose check can fire even if the worker was late/down), but the member is only push-reminded
// when the slot is fresh.

import { prisma } from "../db.js";
import { fromJson } from "./json.js";
import { sendPushToUser } from "./push.js";

const FRESH_REMINDER_MIN = 60; // only push "time for your dose" within this long after the slot
const GRACE_MIN = 120; // a pending dose older than this is "missed"
const REFILL_LEAD_DAYS = 5;

const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** "HH:MM" → [hour, minute], or null if malformed. */
function parseHHMM(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return [h, min];
}

/** Milliseconds `tz` is ahead of UTC at `date` (DST-aware). */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - date.getTime();
}

/** The instant of today's `HH:MM` in `tz` (the member's local time), relative to `now`. */
function zonedSlotToday(now: Date, hhmm: string, tz: string): Date | null {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;
  const [h, m] = parsed;
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m, 0);
  // Correct the naive-UTC guess by the zone's offset at that instant.
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

function whenLabel(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

/** The caregiver (household operator) + household for a member — who gets adherence alerts. */
async function caregiverFor(subjectUserId: string): Promise<{ operatorUserId: string; householdId: string } | null> {
  const membership = await prisma.householdMembership.findFirst({
    where: { userId: subjectUserId },
    select: { household: { select: { id: true, operatorUserId: true } } },
  });
  if (!membership?.household) return null;
  return { operatorUserId: membership.household.operatorUserId, householdId: membership.household.id };
}

async function memberContext(userId: string): Promise<{ name: string; tz: string }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, timezone: true } });
  return { name: u?.displayName?.trim() || "Your family member", tz: u?.timezone || SERVER_TZ };
}

/**
 * Create a DoseLog for every schedule slot that has already come due today (in the member's tz) and
 * doesn't have one yet — regardless of how late this tick runs — so missed detection never silently
 * skips a dose. Push the member a reminder only when the slot is still fresh.
 */
export async function runMedicationDoseTick(now: Date = new Date()): Promise<number> {
  const schedules = await prisma.medicationSchedule.findMany({ where: { active: true }, take: 500 });
  let created = 0;
  // Collect fresh reminders per member so a polypharmacy member gets ONE batched push, not 6+.
  const reminders = new Map<string, { labels: string[]; critical: boolean }>();
  for (const sched of schedules) {
    try {
      const { tz } = await memberContext(sched.subjectUserId);
      const times = fromJson<string[]>(sched.times, []);
      // Cover today AND yesterday so a slot the worker was down for (e.g. overnight) still gets a
      // DoseLog and can be flagged missed — never silently skipped across an outage/midnight.
      const bases = [now, new Date(now.getTime() - 86_400_000)];
      for (const base of bases) {
        for (const t of times) {
          const scheduledAt = zonedSlotToday(base, t, tz);
          if (!scheduledAt || scheduledAt.getTime() > now.getTime()) continue; // not due yet
          const existing = await prisma.doseLog.findUnique({
            where: { scheduleId_scheduledAt: { scheduleId: sched.id, scheduledAt } },
          });
          if (existing) continue;
          await prisma.doseLog.create({
            data: {
              scheduleId: sched.id,
              medicationId: sched.medicationId,
              subjectUserId: sched.subjectUserId,
              label: sched.label,
              scheduledAt,
              status: "pending",
            },
          });
          created++;
          const ageMin = (now.getTime() - scheduledAt.getTime()) / 60_000;
          if (ageMin <= FRESH_REMINDER_MIN) {
            const entry = reminders.get(sched.subjectUserId) ?? { labels: [], critical: false };
            entry.labels.push(sched.label);
            entry.critical = entry.critical || sched.critical;
            reminders.set(sched.subjectUserId, entry);
          }
        }
      }
    } catch (err) {
      console.error("dose tick failed for schedule", sched.id, err);
    }
  }
  // One batched push per member; critical meds force past the quiet-notification preference.
  for (const [subjectUserId, { labels, critical }] of reminders) {
    const body = labels.length === 1 ? `Time for ${labels[0]}` : `Time for ${labels.length} medications: ${labels.join(", ")}`;
    await sendPushToUser(subjectUserId, "Medication reminder", body, critical).catch((e) => console.error("dose reminder push failed", e));
  }
  return created;
}

/**
 * Mark pending doses past the grace window as missed and alert the caregiver once (inbox message +
 * push + a Today task). Critical-medication misses use stronger wording and a preference-bypassing
 * push. Per-dose failures are isolated so one bad row never aborts the batch.
 */
export async function runMissedDoseTick(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GRACE_MIN * 60_000);
  const overdue = await prisma.doseLog.findMany({
    where: { status: "pending", scheduledAt: { lt: cutoff } },
    include: { schedule: { select: { critical: true } } },
    take: 200,
  });
  let alerted = 0;
  for (const dose of overdue) {
    try {
      await prisma.doseLog.update({ where: { id: dose.id }, data: { status: "missed", alertedAt: now } });
      const care = await caregiverFor(dose.subjectUserId);
      if (!care) continue;
      const { name, tz } = await memberContext(dose.subjectUserId);
      const critical = dose.schedule?.critical ?? false;
      const body = critical
        ? `${name} hasn't logged their CRITICAL ${dose.label} dose (due ${whenLabel(dose.scheduledAt, tz)}). Please check in.`
        : `${name} hasn't logged their ${dose.label} dose (due ${whenLabel(dose.scheduledAt, tz)}).`;
      await prisma.message.create({
        data: { householdId: care.householdId, subjectUserId: dose.subjectUserId, direction: "out", channel: "inapp", title: "Missed dose", body },
      });
      // Surface it on Today so a busy caregiver doesn't have to dig into the member's profile.
      await prisma.task.create({
        data: {
          subjectUserId: dose.subjectUserId,
          householdId: care.householdId,
          title: `Missed dose: ${dose.label}`,
          detail: body,
          state: "needs_you",
          kind: "reminder",
        },
      });
      // Critical misses bypass the general push preference; routine ones respect it.
      await sendPushToUser(care.operatorUserId, critical ? "Missed critical dose" : "Missed dose", body, critical);
      alerted++;
    } catch (err) {
      console.error("missed-dose alert failed for dose", dose.id, err);
    }
  }
  return alerted;
}

/**
 * Nudge the caregiver when an active medication's refill is coming due (nextRefillDue within
 * REFILL_LEAD_DAYS). Idempotent PER refill cycle: the nudge embeds the specific due date, so the
 * NEXT cycle (a new due date) nudges again.
 */
export async function runRefillTick(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REFILL_LEAD_DAYS * 86_400_000);
  const meds = await prisma.medicationStatement.findMany({
    where: { status: "active", nextRefillDue: { not: null, lte: horizon, gte: new Date(now.getTime() - 86_400_000) } },
    take: 200,
  });
  let nudged = 0;
  for (const med of meds) {
    try {
      const care = await caregiverFor(med.userId);
      if (!care || !med.nextRefillDue) continue;
      const dueLabel = med.nextRefillDue.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      // Idempotency keyed on THIS medication AND this specific due date, so (a) a later refill cycle
      // (new date) nudges again, and (b) two meds sharing a due date don't suppress each other.
      const already = await prisma.message.findFirst({
        where: {
          householdId: care.householdId,
          title: "Refill due soon",
          AND: [{ body: { contains: med.display } }, { body: { contains: dueLabel } }],
        },
      });
      if (already) continue;
      const { name } = await memberContext(med.userId);
      const body = `${name}'s ${med.display} is due for a refill by ${dueLabel}.`;
      await prisma.message.create({
        data: { householdId: care.householdId, subjectUserId: med.userId, direction: "out", channel: "inapp", title: "Refill due soon", body },
      });
      await sendPushToUser(care.operatorUserId, "Refill due soon", body);
      nudged++;
    } catch (err) {
      console.error("refill nudge failed for med", med.id, err);
    }
  }
  return nudged;
}
