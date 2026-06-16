import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../services/auth.js";
import { ensureHousehold, parseCategories } from "../services/household.js";
import { sendRawEmail } from "../services/email.js";
import { audit } from "../services/audit.js";

const VALID_CATEGORIES = new Set(["all", "records", "apple_health", "appointments"]);

/**
 * Consent & invites (Klove). A consenting adult is added as a member with a *pending* grant; the
 * operator invites them by link, and on accept the invitee links their own login and chooses what
 * to share. Consent is legible and revocable from either side.
 */
export async function consentRoutes(app: FastifyInstance) {
  // Invite a consenting adult: stamp the pending grant with a token + email, "send" the link.
  app.post<{ Params: { id: string }; Body: { email: string } }>(
    "/members/:id/invite",
    { preHandler: requireUser },
    async (req, reply) => {
      const operatorUserId = req.user!.id;
      const householdId = await ensureHousehold(operatorUserId);
      const email = req.body?.email?.trim();
      if (!email) return reply.code(400).send({ error: "email required" });

      const grant = await prisma.consentGrant.findFirst({
        where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, householdId },
      });
      if (!grant) return reply.code(404).send({ error: "member_not_found" });

      const token = randomBytes(24).toString("base64url");
      await prisma.consentGrant.update({
        where: { id: grant.id },
        data: { invitedEmail: email, inviteToken: token, status: "pending" },
      });

      const link = `${config.publicBaseUrl}/invites/${token}`;
      const deepLink = `klove://invite/${token}`;
      // Email is convenience; the token/deep link is the source of truth. Never let a send failure
      // (bad address, provider hiccup) block creating the invite.
      let emailed = true;
      try {
        await sendRawEmail(
          email,
          "You're invited to Klove",
          `<h2>Join your family on Klove</h2>
           <p>Klove is helping coordinate your family's healthcare. Open the link below on your iPhone to
           install Klove and choose exactly what you'd like to share.</p>
           <p><a href="${deepLink}">Accept the invite</a></p>
           <p style="color:#888;font-size:13px">If the button doesn't open the app, paste this into Klove: ${token}</p>`,
        );
      } catch (err) {
        emailed = false;
        req.log.warn({ err }, "invite email failed to send; token still issued");
      }

      return reply.send({ ok: true, token, link, deepLink, emailed });
    },
  );

  // The invitee accepts: link their login to the placeholder member and set what they share.
  app.post<{ Params: { token: string }; Body: { categories?: string[]; accessLevel?: string } }>(
    "/invites/:token/accept",
    { preHandler: requireUser },
    async (req, reply) => {
      const inviteeUserId = req.user!.id;
      const grant = await prisma.consentGrant.findUnique({ where: { inviteToken: req.params.token } });
      if (!grant || grant.status !== "pending") return reply.code(404).send({ error: "invalid_or_used_invite" });
      if (grant.subjectUserId === inviteeUserId) return reply.code(409).send({ error: "cannot_invite_self" });

      const categories = (req.body?.categories ?? ["all"]).filter((c) => VALID_CATEGORIES.has(c));
      const accessLevel = req.body?.accessLevel ?? grant.accessLevel;
      const placeholderId = grant.subjectUserId;

      await prisma.$transaction(async (tx) => {
        // Repoint the household membership from the placeholder to the real invitee.
        const membership = await tx.householdMembership.findFirst({
          where: { householdId: grant.householdId ?? undefined, userId: placeholderId },
        });
        if (membership) {
          await tx.householdMembership.update({ where: { id: membership.id }, data: { userId: inviteeUserId } });
        }
        // Carry over the display name if the invitee doesn't have one.
        const placeholder = await tx.user.findUnique({ where: { id: placeholderId } });
        const invitee = await tx.user.findUnique({ where: { id: inviteeUserId } });
        if (placeholder?.displayName && !invitee?.displayName) {
          await tx.user.update({ where: { id: inviteeUserId }, data: { displayName: placeholder.displayName } });
        }
        // Activate the grant against the real user with the chosen scope.
        await tx.consentGrant.update({
          where: { id: grant.id },
          data: {
            subjectUserId: inviteeUserId,
            status: "active",
            accessLevel,
            categories: JSON.stringify(categories.length ? categories : ["all"]),
            acceptedAt: new Date(),
            inviteToken: null,
          },
        });
        // The placeholder held no clinical data (just created on add) — remove it.
        if (placeholder?.managed) await tx.user.delete({ where: { id: placeholderId } });
      });

      // Give the invitee their own self-view household too.
      await ensureHousehold(inviteeUserId);
      await audit(inviteeUserId, "consent_granted", inviteeUserId, `accept invite · ${accessLevel} · ${categories.join(",")}`);
      return reply.send({ ok: true, subjectUserId: inviteeUserId, accessLevel, categories });
    },
  );

  // Read the operator's consent over a member.
  app.get<{ Params: { id: string } }>("/members/:id/consent", { preHandler: requireUser }, async (req, reply) => {
    const grant = await prisma.consentGrant.findFirst({
      where: { granteeUserId: req.user!.id, subjectUserId: req.params.id },
      orderBy: { createdAt: "desc" },
    });
    if (!grant) return reply.code(404).send({ error: "not_found" });
    return {
      status: grant.status,
      accessLevel: grant.accessLevel,
      categories: parseCategories(grant.categories),
      acceptedAt: grant.acceptedAt,
    };
  });

  // Change scope (operator narrows, or the subject adjusts what they share).
  app.patch<{ Params: { id: string }; Body: { accessLevel?: string; categories?: string[] } }>(
    "/members/:id/consent",
    { preHandler: requireUser },
    async (req, reply) => {
      const callerId = req.user!.id;
      // The caller may be the operator (grantee) or the member themselves (subject).
      const grant = await prisma.consentGrant.findFirst({
        where: {
          subjectUserId: req.params.id,
          OR: [{ granteeUserId: callerId }, { subjectUserId: callerId }],
        },
        orderBy: { createdAt: "desc" },
      });
      if (!grant) return reply.code(404).send({ error: "not_found" });

      const categories = req.body?.categories?.filter((c) => VALID_CATEGORIES.has(c));
      const updated = await prisma.consentGrant.update({
        where: { id: grant.id },
        data: {
          accessLevel: req.body?.accessLevel ?? undefined,
          categories: categories?.length ? JSON.stringify(categories) : undefined,
        },
      });
      return reply.send({ status: updated.status, accessLevel: updated.accessLevel, categories: parseCategories(updated.categories) });
    },
  );

  // Revoke access (either side). Disconnect-anytime is a legal requirement.
  app.post<{ Params: { id: string } }>("/members/:id/revoke", { preHandler: requireUser }, async (req, reply) => {
    const callerId = req.user!.id;
    const grant = await prisma.consentGrant.findFirst({
      where: {
        subjectUserId: req.params.id,
        OR: [{ granteeUserId: callerId }, { subjectUserId: callerId }],
      },
      orderBy: { createdAt: "desc" },
    });
    if (!grant) return reply.code(404).send({ error: "not_found" });
    await prisma.consentGrant.update({ where: { id: grant.id }, data: { status: "revoked", revokedAt: new Date() } });
    await audit(callerId, "consent_revoked", req.params.id);
    return reply.send({ ok: true });
  });
}
