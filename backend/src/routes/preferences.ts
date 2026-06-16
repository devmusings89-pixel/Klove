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
      const updated = await prisma.user.update({
        where: { id: req.user!.id },
        data: {
          pushEnabled: typeof req.body?.pushEnabled === "boolean" ? req.body.pushEnabled : undefined,
          reminderLeadHours: typeof lead === "number" && lead >= 1 && lead <= 168 ? Math.round(lead) : undefined,
        },
        select: { pushEnabled: true, reminderLeadHours: true },
      });
      return reply.send(updated);
    },
  );
}
