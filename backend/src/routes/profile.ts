import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { encryptToken, decryptToken } from "../services/crypto.js";

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
});

/**
 * The reusable patient profile ("My Info") + insurance vault. Demographics + insurance are stored
 * once and auto-fill every booking. Member/group IDs are envelope-encrypted at rest (crypto.ts).
 * Insurance-card OCR happens ON DEVICE; only the confirmed fields are sent here.
 */
export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", { preHandler: requireUser }, async (req) => {
    const profile = await primaryProfile(req.user!.id);
    return { profile: profile ? serialize(profile) : null };
  });

  app.put("/profile", { preHandler: requireUser }, async (req, reply) => {
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });

    const existing = await primaryProfile(req.user!.id);
    const data = { ...parsed.data, relationship: "self", isPrimary: true };
    const profile = existing
      ? await prisma.profile.update({ where: { id: existing.id }, data, include: { insurance: true } })
      : await prisma.profile.create({ data: { ...data, userId: req.user!.id }, include: { insurance: true } });
    return { profile: serialize(profile) };
  });

  app.put("/profile/insurance", { preHandler: requireUser }, async (req, reply) => {
    const parsed = InsuranceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    const i = parsed.data;

    // Ensure a primary profile exists to attach insurance to.
    let profile = await primaryProfile(req.user!.id);
    if (!profile) {
      profile = await prisma.profile.create({
        data: { userId: req.user!.id, fullName: i.holderName ?? "", relationship: "self", isPrimary: true },
        include: { insurance: true },
      });
    }

    const data = {
      carrier: i.carrier,
      planName: i.planName,
      memberIdEnc: i.memberId ? encryptToken(i.memberId) : null,
      groupIdEnc: i.groupId ? encryptToken(i.groupId) : null,
      rxBin: i.rxBin,
      rxPcn: i.rxPcn,
      holderName: i.holderName,
      isPrimary: true,
    };
    const plan = profile.insurance[0];
    if (plan) {
      await prisma.insurancePlan.update({ where: { id: plan.id }, data });
    } else {
      await prisma.insurancePlan.create({ data: { ...data, profileId: profile.id } });
    }
    const fresh = await primaryProfile(req.user!.id);
    return { profile: fresh ? serialize(fresh) : null };
  });
}

type ProfileWithInsurance = NonNullable<Awaited<ReturnType<typeof primaryProfile>>>;

function primaryProfile(userId: string) {
  return prisma.profile.findFirst({
    where: { userId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    include: { insurance: true },
  });
}

/** Serialize a profile, decrypting insurance IDs for the owner. */
function serialize(p: ProfileWithInsurance) {
  const plan = p.insurance[0];
  return {
    id: p.id,
    fullName: p.fullName,
    dob: p.dob,
    phone: p.phone,
    email: p.email,
    address: p.address,
    insurance: plan
      ? {
          carrier: plan.carrier,
          planName: plan.planName,
          memberId: plan.memberIdEnc ? decryptToken(plan.memberIdEnc) : null,
          groupId: plan.groupIdEnc ? decryptToken(plan.groupIdEnc) : null,
          rxBin: plan.rxBin,
          rxPcn: plan.rxPcn,
          holderName: plan.holderName,
        }
      : null,
  };
}

/** Insurance as a one-line string for booking intake/agents (no raw IDs unless present). */
export function insuranceSummary(p: { insurance: { carrier?: string | null; planName?: string | null } | null }): string {
  if (!p.insurance) return "";
  return [p.insurance.carrier, p.insurance.planName].filter(Boolean).join(" ");
}
