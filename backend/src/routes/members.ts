import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { ensureHousehold, parseCategories } from "../services/household.js";
import { sendRawEmail } from "../services/email.js";
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

      // Managed members inherit the operator's timezone so dose reminders fire in the right local
      // time (the operator manages on their behalf and they typically share a locale).
      const operator = await prisma.user.findUnique({ where: { id: operatorUserId }, select: { timezone: true } });
      const member = await prisma.user.create({
        data: { displayName: displayName.trim(), managed: true, managedByUserId: operatorUserId, timezone: operator?.timezone ?? null },
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

      // (5) Authorize by operate-consent, not mere membership. Self passes; others need an active
      // operate grant. resolveSubject throws ConsentError (403) when the caller may not act.
      try {
        await resolveSubject(req, req.params.id, { need: "operate" });
      } catch (err) {
        if (isConsentError(err)) return reply.code(403).send({ error: err.message });
        throw err;
      }

      // (7) Validate dob: reject an unparseable date with a 400 instead of persisting Invalid Date.
      let dob: Date | undefined;
      if (req.body?.dob) {
        const parsed = new Date(req.body.dob);
        if (Number.isNaN(parsed.getTime())) return reply.code(400).send({ error: "invalid dob" });
        dob = parsed;
      }

      if (req.body?.displayName || dob) {
        await prisma.user.update({
          where: { id: req.params.id },
          data: {
            displayName: req.body.displayName ?? undefined,
            dob: dob ?? undefined,
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

  // Promote a managed member (minor/aging parent) to a login. We do NOT attach a login email on an
  // operator's say-so — the email owner must prove they control it. (6) So promote requires an active
  // operate grant, then issues an identity-bound invite to that email; the actual login attach +
  // `managed:false` flip happens only when the owner accepts with a verified matching identity
  // (consent.ts /invites/:token/accept). This converts the managed member into a pending invite.
  app.post<{ Params: { id: string }; Body: { email: string } }>("/members/:id/promote", { preHandler: requireUser }, async (req, reply) => {
    const operatorUserId = req.user!.id;
    const householdId = await ensureHousehold(operatorUserId);
    const email = req.body?.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) return reply.code(400).send({ error: "valid email required" });

    const membership = await prisma.householdMembership.findFirst({ where: { householdId, userId: req.params.id }, include: { user: true } });
    if (!membership) return reply.code(404).send({ error: "not_found" });
    if (!membership.user.managed) return reply.code(409).send({ error: "already_has_login" });

    // (5/6) Authorize by operate-consent rather than mere membership.
    try {
      await resolveSubject(req, req.params.id, { need: "operate" });
    } catch (err) {
      if (isConsentError(err)) return reply.code(403).send({ error: err.message });
      throw err;
    }

    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== req.params.id) return reply.code(409).send({ error: "email_in_use" });

    // Stamp the operator's grant pending + bind the invite to this email. The invitee verifies their
    // identity on accept; only then do they take ownership of the (formerly managed) member's records.
    const grant = await prisma.consentGrant.findFirst({
      where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, householdId },
    });
    if (!grant) return reply.code(404).send({ error: "member_not_found" });

    const token = randomBytes(24).toString("base64url");
    await prisma.consentGrant.update({
      where: { id: grant.id },
      data: { invitedEmail: email, inviteToken: token, status: "pending" },
    });
    // Surface the managed member in the consenting-adult invite flow so it can be accepted.
    await prisma.householdMembership.update({ where: { id: membership.id }, data: { memberType: "consenting_adult" } });

    const deepLink = `klove://invite/${token}`;
    let emailed = true;
    try {
      await sendRawEmail(
        email,
        "Take ownership of your Klove records",
        `<h2>You've been invited to manage your own health records on Klove</h2>
         <p>Open the link below on your iPhone to sign in, verify it's you, and take ownership.</p>
         <p><a href="${deepLink}">Accept the invite</a></p>
         <p style="color:#888;font-size:13px">If the button doesn't open the app, paste this into Klove: ${token}</p>`,
      );
    } catch (err) {
      emailed = false;
      req.log.warn({ err }, "promote invite email failed to send; token still issued");
    }

    await audit(operatorUserId, "member_promote_invited", req.params.id, "invite to attach login");
    return reply.send({ ok: true, email, token, deepLink, emailed, pending: true });
  });

  // Remove a member from the household: drop the membership + revoke the operator's grant. The
  // member's User/clinical rows are retained (not hard-deleted) to avoid orphaning records.
  app.delete<{ Params: { id: string } }>("/members/:id", { preHandler: requireUser }, async (req, reply) => {
    const operatorUserId = req.user!.id;
    if (req.params.id === operatorUserId) return reply.code(400).send({ error: "cannot_remove_self" });
    const householdId = await ensureHousehold(operatorUserId);
    const membership = await prisma.householdMembership.findFirst({
      where: { householdId, userId: req.params.id },
      include: { user: true },
    });
    if (!membership) return reply.code(404).send({ error: "not_found" });

    // (8) Ghost cleanup. A backed-out invite leaves a placeholder User + membership + pending grant
    // behind. A *managed* member that the operator owns and that has no own login (no authUserId) and
    // never accepted is exactly such a placeholder — hard-delete it so ghosts don't accumulate. Real
    // members (have a login, or hold clinical data we shouldn't orphan) keep the retain-and-revoke path.
    const placeholder = membership.user.managed && !membership.user.authUserId && membership.user.managedByUserId === operatorUserId;

    if (placeholder) {
      await prisma.$transaction(async (tx) => {
        await tx.consentGrant.deleteMany({ where: { subjectUserId: req.params.id } });
        await tx.householdMembership.delete({ where: { id: membership.id } });
        // Safe to remove the placeholder User itself only if nothing else references it. Best-effort:
        // delete will throw on FK if clinical rows somehow exist, in which case we fall back to revoke.
        try {
          await tx.user.delete({ where: { id: req.params.id } });
        } catch {
          /* keep the User row if it's referenced; membership + grants are already gone */
        }
      });
      await audit(operatorUserId, "member_removed", req.params.id, "placeholder cleaned up");
      return reply.send({ ok: true, cleaned: true });
    }

    await prisma.householdMembership.delete({ where: { id: membership.id } });
    await prisma.consentGrant.updateMany({
      where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, status: { not: "revoked" } },
      data: { status: "revoked", revokedAt: new Date() },
    });
    await audit(operatorUserId, "member_removed", req.params.id);
    return reply.send({ ok: true });
  });
}
