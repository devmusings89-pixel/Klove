// Proactive concierge outreach. Once per day per operator, surface the things the spec asks the agent
// to raise unprompted: interesting health trends/insights and items that still need scheduling. The
// daily throttle lives on User.lastProactiveAt; delivery goes through notifyUser, so WhatsApp only
// fires inside the 24h window (push otherwise). Booking-status updates are handled separately by
// reconcileConciergeJobs → pushToOperator → notifyUser.

import { prisma } from "../db.js";
import { accessibleSubjects } from "./household.js";
import { notifyUser } from "./notify.js";

const DAY_MS = 86_400_000;

/**
 * Send each due operator a single check-in digest of new insights + things to schedule. Idempotent
 * per day via lastProactiveAt; returns the number of operators messaged. Gated to WhatsApp-verified
 * operators so we don't push a chat-style digest to app-only users.
 */
export async function runProactiveOutreachTick(now: Date = new Date()): Promise<number> {
  const households = await prisma.household.findMany({ select: { operatorUserId: true } });
  let sent = 0;

  for (const hh of households) {
    try {
      const op = await prisma.user.findUnique({
        where: { id: hh.operatorUserId },
        select: { id: true, lastProactiveAt: true, whatsappVerified: true, whatsappEnabled: true },
      });
      if (!op || !op.whatsappVerified || op.whatsappEnabled === false) continue;
      if (op.lastProactiveAt && now.getTime() - op.lastProactiveAt.getTime() < DAY_MS) continue;

      const subjects = await accessibleSubjects(op.id);
      const ids = subjects.map((s) => s.id);
      const selfName = subjects[0]?.name;
      const nameById = new Map(subjects.map((s) => [s.id, s.name]));

      const [alerts, followups] = await Promise.all([
        prisma.healthAlert.findMany({
          where: { userId: { in: ids }, acknowledgedAt: null, category: { in: ["trend", "screening", "follow_up"] } },
          orderBy: { rank: "desc" },
          take: 3,
        }),
        prisma.task.findMany({
          where: { subjectUserId: { in: ids }, state: "needs_you", kind: "follow_up" },
          orderBy: { createdAt: "desc" },
          take: 3,
        }),
      ]);
      if (!alerts.length && !followups.length) continue;

      const lines: string[] = [];
      for (const a of alerts) {
        const who = nameById.get(a.userId);
        lines.push(`• ${a.title}${who && who !== selfName ? ` (${who})` : ""}`);
      }
      for (const f of followups) lines.push(`• ${f.title} — want me to schedule it?`);

      await notifyUser(op.id, { title: "Klove check-in", body: lines.join("\n") });
      await prisma.user.update({ where: { id: op.id }, data: { lastProactiveAt: now } });
      sent++;
    } catch (err) {
      console.error("proactive outreach failed for household operator", hh.operatorUserId, err);
    }
  }
  return sent;
}
