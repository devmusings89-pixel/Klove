import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { ensureHousehold, parseCategories } from "../services/household.js";
import { audit } from "../services/audit.js";

const MEMBER_TYPES = new Set(["minor", "aging_parent", "consenting_adult"]);

/**
 * Add and manage the people in a household. Every member is a User (see schema header):
 *  - minor / aging_parent  → a login-less "managed" User the operator owns, with an auto active
 *    operate grant.
 *  - consenting_adult      → a placeholder member with a *pending* grant; activated when the adult
 *    accepts their invite (consent.ts) and chooses what to share.
 * "self" is created with the household, not here.
 */
export async function memberRoutes(app: FastifyInstance) {
  app.post<{ Body: { displayName: string; relationship: string; memberType: string } }>(
    "/members",
    { preHandler: requireUser },
    async (req, reply) => {
      const operatorUserId = req.user!.id;
      const { displayName, relationship, memberType } = req.body ?? ({} as Record<string, string>);
      if (!displayName?.trim()) return reply.code(400).send({ error: "displayName required" });
      if (!MEMBER_TYPES.has(memberType)) return reply.code(400).send({ error: "invalid memberType" });

      const householdId = await ensureHousehold(operatorUserId);
      const managedMember = memberType !== "consenting_adult"; // adults bring their own login on accept

      const member = await prisma.user.create({
        data: { displayName: displayName.trim(), managed: true, managedByUserId: operatorUserId },
      });
      await prisma.householdMembership.create({
        data: { householdId, userId: member.id, relationship: relationship || "other", memberType },
      });
      await prisma.consentGrant.create({
        data: {
          granteeUserId: operatorUserId,
          subjectUserId: member.id,
          householdId,
          accessLevel: "operate",
          categories: JSON.stringify(["all"]),
          status: managedMember ? "active" : "pending",
        },
      });

      return reply.code(201).send({
        userId: member.id,
        displayName: member.displayName,
        relationship,
        memberType,
        managed: true,
        consent: managedMember ? "active" : "pending",
      });
    },
  );

  // One member's profile + the operator's consent over them. Scoped to the operator's household.
  app.get<{ Params: { id: string } }>("/members/:id", { preHandler: requireUser }, async (req, reply) => {
    const operatorUserId = req.user!.id;
    const householdId = await ensureHousehold(operatorUserId);
    const membership = await prisma.householdMembership.findFirst({
      where: { householdId, userId: req.params.id },
      include: { user: true },
    });
    if (!membership) return reply.code(404).send({ error: "not_found" });

    const self = membership.userId === operatorUserId;
    const grant = self
      ? null
      : await prisma.consentGrant.findFirst({
          where: { granteeUserId: operatorUserId, subjectUserId: membership.userId },
          orderBy: { createdAt: "desc" },
        });

    return {
      userId: membership.userId,
      displayName: membership.user.displayName ?? (self ? "Me" : null),
      dob: membership.user.dob,
      relationship: membership.relationship,
      memberType: membership.memberType,
      isOperator: membership.isOperator,
      managed: membership.user.managed,
      consent: self
        ? { status: "self", accessLevel: "operate", categories: ["all"] }
        : {
            status: grant?.status ?? "none",
            accessLevel: grant?.accessLevel ?? null,
            categories: grant ? parseCategories(grant.categories) : [],
          },
    };
  });

  // Edit member details (name/dob/relationship). Operator-only; managed members or self.
  app.patch<{ Params: { id: string }; Body: { displayName?: string; relationship?: string; dob?: string } }>(
    "/members/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const operatorUserId = req.user!.id;
      const householdId = await ensureHousehold(operatorUserId);
      const membership = await prisma.householdMembership.findFirst({
        where: { householdId, userId: req.params.id },
      });
      if (!membership) return reply.code(404).send({ error: "not_found" });

      if (req.body?.displayName || req.body?.dob) {
        await prisma.user.update({
          where: { id: req.params.id },
          data: {
            displayName: req.body.displayName ?? undefined,
            dob: req.body.dob ? new Date(req.body.dob) : undefined,
          },
        });
      }
      if (req.body?.relationship) {
        await prisma.householdMembership.update({
          where: { id: membership.id },
          data: { relationship: req.body.relationship },
        });
      }
      return reply.send({ ok: true });
    },
  );

  // Remove a member from the household: drop the membership + revoke the operator's grant. The
  // member's User/clinical rows are retained (not hard-deleted) to avoid orphaning records.
  app.delete<{ Params: { id: string } }>("/members/:id", { preHandler: requireUser }, async (req, reply) => {
    const operatorUserId = req.user!.id;
    if (req.params.id === operatorUserId) return reply.code(400).send({ error: "cannot_remove_self" });
    const householdId = await ensureHousehold(operatorUserId);
    const membership = await prisma.householdMembership.findFirst({ where: { householdId, userId: req.params.id } });
    if (!membership) return reply.code(404).send({ error: "not_found" });

    await prisma.householdMembership.delete({ where: { id: membership.id } });
    await prisma.consentGrant.updateMany({
      where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, status: { not: "revoked" } },
      data: { status: "revoked", revokedAt: new Date() },
    });
    await audit(operatorUserId, "member_removed", req.params.id);
    return reply.send({ ok: true });
  });
}
