// WhatsApp enrollment (app-driven). The iOS app posts the user's phone number; we store it (E.164)
// and send a "reply YES to connect" verification over WhatsApp. The inbound webhook flips
// whatsappVerified when the user replies YES (see services/agent.ts onboarding). The agent refuses
// all actions until verified. Disabling clears the number.

import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { toE164 } from "../services/phone.js";
import { sendWhatsApp } from "../services/whatsapp.js";

export async function whatsappRoutes(app: FastifyInstance) {
  // Return the caller's current WhatsApp link status.
  app.get("/whatsapp/enroll", { preHandler: requireUser }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { whatsappPhone: true, whatsappVerified: true, whatsappEnabled: true },
    });
    return {
      phone: user?.whatsappPhone ?? null,
      verified: user?.whatsappVerified ?? false,
      enabled: user?.whatsappEnabled ?? false,
    };
  });

  // Link (or re-link) a WhatsApp number to the caller and send a verification prompt.
  app.post<{ Body: { phone?: string } }>("/whatsapp/enroll", { preHandler: requireUser }, async (req, reply) => {
    const e164 = toE164(req.body?.phone);
    if (!e164) return reply.code(400).send({ error: "invalid_phone" });

    // One user per number: refuse if another account already claimed it.
    const existing = await prisma.user.findUnique({ where: { whatsappPhone: e164 }, select: { id: true } });
    if (existing && existing.id !== req.user!.id) return reply.code(409).send({ error: "number_in_use" });

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { whatsappPhone: e164, whatsappVerified: false, whatsappEnabled: true },
    });
    const sent = await sendWhatsApp(e164, "This is Klove, your family's health concierge. Reply YES to connect this number to your account.");
    return reply.send({ ok: true, verificationSent: sent });
  });

  // Unlink the WhatsApp number / turn the channel off.
  app.delete("/whatsapp/enroll", { preHandler: requireUser }, async (req, reply) => {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { whatsappPhone: null, whatsappVerified: false, whatsappEnabled: false },
    });
    return reply.send({ ok: true });
  });
}
