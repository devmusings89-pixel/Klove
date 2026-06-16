import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { registerDeviceToken } from "../services/push.js";

/** Register the caller's APNs device token so Klove can reach them (Phase 5 live push). */
export async function deviceRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string } }>("/devices/token", { preHandler: requireUser }, async (req, reply) => {
    const token = req.body?.token?.trim();
    if (!token) return reply.code(400).send({ error: "token required" });
    await registerDeviceToken(req.user!.id, token);
    return reply.send({ ok: true });
  });
}
