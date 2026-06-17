import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../services/auth.js";
import {
  serializeProfile,
  upsertProfile,
  addInsurance,
  updateInsurance,
  deleteInsurance,
  listInsurance,
} from "../services/profiles.js";

const ProfileSchema = z.object({
  fullName: z.string().min(1),
  dob: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
});

const InsuranceSchema = z.object({
  carrier: z.string().optional(),
  planName: z.string().optional(),
  memberId: z.string().optional(),
  groupId: z.string().optional(),
  rxBin: z.string().optional(),
  rxPcn: z.string().optional(),
  holderName: z.string().optional(),
  isPrimary: z.boolean().optional(),
  isSecondary: z.boolean().optional(),
});

/**
 * The operator's own "My Info" + insurance wallet. Demographics + insurance are stored once and
 * auto-fill bookings. Insurance is a COLLECTION — the operator can hold multiple cards (family plan,
 * spouse's plan, a parent's Medicare). Per-member profiles/wallets live under /members/:id (see
 * member-data routes); these self routes are sugar for the operator's own userId.
 */
export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", { preHandler: requireUser }, async (req) => {
    return { profile: await serializeProfile(req.user!.id) };
  });

  app.put("/profile", { preHandler: requireUser }, async (req, reply) => {
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    await upsertProfile(req.user!.id, parsed.data, "self");
    return { profile: await serializeProfile(req.user!.id) };
  });

  // Insurance wallet (collection).
  app.get("/profile/insurance", { preHandler: requireUser }, async (req) => {
    return { plans: await listInsurance(req.user!.id) };
  });

  // Add a card. Back-compat: PUT also adds (older clients used PUT to "save insurance").
  const addCard = async (req: any, reply: any) => {
    const parsed = InsuranceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    const plans = await addInsurance(req.user!.id, parsed.data);
    return { plans, profile: await serializeProfile(req.user!.id) };
  };
  app.post("/profile/insurance", { preHandler: requireUser }, addCard);
  app.put("/profile/insurance", { preHandler: requireUser }, addCard);

  app.patch<{ Params: { planId: string } }>("/profile/insurance/:planId", { preHandler: requireUser }, async (req, reply) => {
    const parsed = InsuranceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    const plans = await updateInsurance(req.user!.id, req.params.planId, parsed.data);
    if (!plans) return reply.code(404).send({ error: "not_found" });
    return { plans };
  });

  app.delete<{ Params: { planId: string } }>("/profile/insurance/:planId", { preHandler: requireUser }, async (req, reply) => {
    const plans = await deleteInsurance(req.user!.id, req.params.planId);
    if (!plans) return reply.code(404).send({ error: "not_found" });
    return { plans };
  });
}
