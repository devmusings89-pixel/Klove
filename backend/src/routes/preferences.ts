import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";

/** Per-user notification preferences: push on/off + appointment reminder lead time. */
export async function preferenceRoutes(app: FastifyInstance) {
  app.get("/preferences", { preHandler: requireUser }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { pushEnabled: true, reminderLeadHours: true },
    });
    return { pushEnabled: user?.pushEnabled ?? true, reminderLeadHours: user?.reminderLeadHours ?? 24 };
  });

  app.patch<{ Body: { pushEnabled?: boolean; reminderLeadHours?: number } }>(
    "/preferences",
    { preHandler: requireUser },
    async (req, reply) => {
      const lead = req.body?.reminderLeadHours;
      // (12) Reject an out-of-range lead explicitly rather than silently dropping it to a no-op, so
      // the client learns its write didn't take. Range is 1–168 hours (1 hour … 1 week).
      if (lead !== undefined && (typeof lead !== "number" || Number.isNaN(lead) || lead < 1 || lead > 168)) {
        return reply.code(400).send({ error: "reminderLeadHours must be between 1 and 168" });
      }
      const updated = await prisma.user.update({
        where: { id: req.user!.id },
        data: {
          pushEnabled: typeof req.body?.pushEnabled === "boolean" ? req.body.pushEnabled : undefined,
          reminderLeadHours: typeof lead === "number" ? Math.round(lead) : undefined,
        },
        select: { pushEnabled: true, reminderLeadHours: true },
      });
      return reply.send(updated);
    },
  );
}
