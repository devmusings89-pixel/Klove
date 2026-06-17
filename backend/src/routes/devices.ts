import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { registerDeviceToken } from "../services/push.js";

/** Register the caller's APNs device token so Klove can reach them, and capture their timezone
 * (used to schedule medication doses in the right local time). */
export async function deviceRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string; timezone?: string } }>("/devices/token", { preHandler: requireUser }, async (req, reply) => {
    const token = req.body?.token?.trim();
    if (!token) return reply.code(400).send({ error: "token required" });
    await registerDeviceToken(req.user!.id, token);
    const tz = req.body?.timezone?.trim();
    if (tz) await prisma.user.update({ where: { id: req.user!.id }, data: { timezone: tz } });
    return reply.send({ ok: true });
  });
}
