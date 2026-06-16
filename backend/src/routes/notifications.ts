import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { ensureHousehold } from "../services/household.js";

/** The notifications inbox: conversational nudges & confirmations across the operator's household. */
export async function notificationRoutes(app: FastifyInstance) {
  app.get("/notifications", { preHandler: requireUser }, async (req) => {
    const householdId = await ensureHousehold(req.user!.id);
    const messages = await prisma.message.findMany({
      where: { householdId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const unread = messages.filter((m) => !m.readAt).length;
    return { unread, messages };
  });

  app.post<{ Params: { id: string } }>("/notifications/:id/read", { preHandler: requireUser }, async (req, reply) => {
    const householdId = await ensureHousehold(req.user!.id);
    const updated = await prisma.message.updateMany({
      where: { id: req.params.id, householdId },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });
}
