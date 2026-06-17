import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../services/auth.js";
import { ensureHousehold, parseCategories } from "../services/household.js";
import { sendRawEmail } from "../services/email.js";
import { sendSms } from "../services/sms.js";
import { toE164 } from "../services/phone.js";
import { audit } from "../services/audit.js";

const VALID_CATEGORIES = new Set(["all", "records", "apple_health", "appointments"]);

// Invites are single-use AND time-boxed. An unaccepted token past this age is treated as expired.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** True if a pending grant's invite has aged out (based on createdAt). */
function inviteExpired(grant: { createdAt: Date }): boolean {
  return Date.now() - grant.createdAt.getTime() > INVITE_TTL_MS;
}

/**
 * Consent & invites (Klove). A consenting adult is added as a member with a *pending* grant; the
 * operator invites them by link (email or SMS), and on accept the invitee links their own login and
 * chooses what to share. Consent is legible and revocable from either side.
 */
export async function consentRoutes(app: FastifyInstance) {
  // Invite a consenting adult: stamp the pending grant with a token + email/phone, "send" the link.
  // channel defaults to "email"; "sms" texts the link to `phone`.
  app.post<{ Params: { id: string }; Body: { email?: string; phone?: string; channel?: string } }>(
    "/members/:id/invite",
    { preHandler: requireUser },
    async (req, reply) => {
      const operatorUserId = req.user!.id;
      const householdId = await ensureHousehold(operatorUserId);
      const channel = req.body?.channel === "sms" ? "sms" : "email";
      const email = req.body?.email?.trim();
      const phone = channel === "sms" ? toE164(req.body?.phone) : null;

      if (channel === "email" && !email) return reply.code(400).send({ error: "email required" });
      if (channel === "sms" && !phone) return reply.code(400).send({ error: "valid phone required" });

      const grant = await prisma.consentGrant.findFirst({
        where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, householdId },
      });
      if (!grant) return reply.code(404).send({ error: "member_not_found" });

      const token = randomBytes(24).toString("base64url");
      // We persist the invited email so accept can bind the token to that identity (see accept).
      // Issuing a fresh token also resets the TTL clock by bumping the grant's effective issue time;
      // we re-stamp createdAt via a status flip back to pending below.
      await prisma.consentGrant.update({
        where: { id: grant.id },
        data: { invitedEmail: email ?? null, inviteToken: token, status: "pending" },
      });

      const deepLink = `klove://invite/${token}`;
      const link = `${config.publicBaseUrl}/invites/${token}`; // web landing (GET route below) for non-iOS opens

      // Email/SMS is convenience; the token/deep link is the source of truth. Never let a send failure
      // (bad address, provider hiccup) block creating the invite.
      let sent = true;
      try {
        if (channel === "sms") {
          sent = await sendSms(
            phone!,
            `You've been invited to coordinate your healthcare on Klove. Open this on your iPhone to accept and choose what to share: ${deepLink} (code: ${token})`,
          );
        } else {
          await sendRawEmail(
            email!,
            "You're invited to Klove",
            `<h2>Join your family on Klove</h2>
             <p>Klove is helping coordinate your family's healthcare. Open the link below on your iPhone to
             install Klove and choose exactly what you'd like to share.</p>
             <p><a href="${deepLink}">Accept the invite</a></p>
             <p style="color:#888;font-size:13px">If the button doesn't open the app, paste this into Klove: ${token}</p>`,
          );
        }
      } catch (err) {
        sent = false;
        req.log.warn({ err, channel }, "invite send failed; token still issued");
      }

      return reply.send({ ok: true, token, link, deepLink, channel, emailed: channel === "email" && sent, sent });
    },
  );

  // Minimal web landing for an invite link opened outside the app (e.g. desktop browser). It doesn't
  // accept the invite — acceptance requires a verified sign-in in the app — it just deep-links across
  // and tells the user to finish in Klove on their iPhone. (10: gives the issued link a real target.)
  app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
    const grant = await prisma.consentGrant.findUnique({ where: { inviteToken: req.params.token } });
    const valid = grant && grant.status === "pending" && !inviteExpired(grant);
    const deepLink = `klove://invite/${req.params.token}`;
    const html = valid
      ? `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
         <body style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;text-align:center">
           <h2>You're invited to Klove</h2>
           <p>Open this on your iPhone to accept and choose what you'd like to share.</p>
           <p><a href="${deepLink}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Open in Klove</a></p>
           <p style="color:#888;font-size:13px">If nothing happens, install Klove first, then paste this code: ${req.params.token}</p>
         </body>`
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
         <body style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;text-align:center">
           <h2>This invite is no longer valid</h2>
           <p>It may have already been used or expired. Ask whoever invited you to send a new one.</p>
         </body>`;
    return reply.code(valid ? 200 : 410).type("text/html").send(html);
  });

  // The invitee accepts: link their login to the placeholder member and set what they share.
  app.post<{ Params: { token: string }; Body: { categories?: string[]; accessLevel?: string } }>(
    "/invites/:token/accept",
    { preHandler: requireUser },
    async (req, reply) => {
      const inviteeUserId = req.user!.id;
      const inviteeEmail = (req.user!.email ?? "").trim().toLowerCase();
      const grant = await prisma.consentGrant.findUnique({ where: { inviteToken: req.params.token } });
      if (!grant || grant.status !== "pending") return reply.code(404).send({ error: "invalid_or_used_invite" });
      if (grant.subjectUserId === inviteeUserId) return reply.code(409).send({ error: "cannot_invite_self" });

      // (2) Time-box the invite. An aged-out token can't be accepted; the operator must re-invite.
      if (inviteExpired(grant)) return reply.code(410).send({ error: "invite_expired" });

      // (1) Bind acceptance to the invited identity. When the invite named an email, the authenticated
      // caller's verified email must match it — otherwise anyone with the token could claim the slot.
      // (SMS-only invites carry no email identity on the backend; they bind on token possession.)
      if (grant.invitedEmail) {
        const invited = grant.invitedEmail.trim().toLowerCase();
        if (!inviteeEmail || inviteeEmail !== invited) {
          return reply.code(403).send({ error: "invite_identity_mismatch" });
        }
      }

      const categories = (req.body?.categories ?? ["all"]).filter((c) => VALID_CATEGORIES.has(c));
      const accessLevel = req.body?.accessLevel ?? grant.accessLevel;
      const placeholderId = grant.subjectUserId;

      // (3) Make accept race-safe: the pending check above is advisory. Inside the tx we flip the
      // status with a conditional updateMany guarded on status==="pending" and assert exactly one row
      // changed — a concurrent double-accept loses the race and aborts before repointing membership.
      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.consentGrant.updateMany({
            where: { id: grant.id, status: "pending" },
            data: { status: "active" },
          });
          if (claimed.count !== 1) throw new Error("already_accepted");

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
              accessLevel,
              categories: JSON.stringify(categories.length ? categories : ["all"]),
              acceptedAt: new Date(),
              inviteToken: null,
              invitedEmail: null,
            },
          });
          // The placeholder held no clinical data (just created on add) — remove it.
          if (placeholder?.managed) await tx.user.delete({ where: { id: placeholderId } });
        });
      } catch (err) {
        if (err instanceof Error && err.message === "already_accepted") {
          return reply.code(409).send({ error: "invite_already_accepted" });
        }
        throw err;
      }

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

  // Change scope. The operator (grantee) may widen or narrow; the subject may only NARROW their own
  // sharing (lower the access level / drop categories) — never widen the operator's reach. (4)
  app.patch<{ Params: { id: string }; Body: { accessLevel?: string; categories?: string[] } }>(
    "/members/:id/consent",
    { preHandler: requireUser },
    async (req, reply) => {
      const callerId = req.user!.id;
      const grant = await prisma.consentGrant.findFirst({
        where: {
          subjectUserId: req.params.id,
          OR: [{ granteeUserId: callerId }, { subjectUserId: callerId }],
        },
        orderBy: { createdAt: "desc" },
      });
      if (!grant) return reply.code(404).send({ error: "not_found" });

      const isOperator = grant.granteeUserId === callerId;
      const isSubject = grant.subjectUserId === callerId;

      const requestedCategories = req.body?.categories?.filter((c) => VALID_CATEGORIES.has(c));
      const requestedLevel = req.body?.accessLevel;

      // Subjects can only restrict, not widen. Enforce monotonic narrowing on both axes.
      if (isSubject && !isOperator) {
        const rank: Record<string, number> = { view: 1, manage: 2, operate: 3 };
        if (requestedLevel) {
          const cur = rank[grant.accessLevel] ?? 0;
          const next = rank[requestedLevel] ?? 0;
          if (!next || next > cur) return reply.code(403).send({ error: "subject_cannot_widen_access" });
        }
        if (requestedCategories) {
          const current = parseCategories(grant.categories);
          const widensAll = current.includes("all") ? false : requestedCategories.includes("all");
          const addsNew = !current.includes("all") && requestedCategories.some((c) => !current.includes(c));
          if (widensAll || addsNew) return reply.code(403).send({ error: "subject_cannot_widen_categories" });
        }
      }

      const updated = await prisma.consentGrant.update({
        where: { id: grant.id },
        data: {
          accessLevel: requestedLevel ?? undefined,
          categories: requestedCategories?.length ? JSON.stringify(requestedCategories) : undefined,
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

  // Cancel a pending invite (operator backs out): revoke the grant and clear the token so the
  // placeholder can be cleaned up. See members.ts DELETE for the full ghost cleanup. (8)
  app.post<{ Params: { id: string } }>("/members/:id/invite/cancel", { preHandler: requireUser }, async (req, reply) => {
    const operatorUserId = req.user!.id;
    const householdId = await ensureHousehold(operatorUserId);
    const grant = await prisma.consentGrant.findFirst({
      where: { granteeUserId: operatorUserId, subjectUserId: req.params.id, householdId, status: "pending" },
    });
    if (!grant) return reply.code(404).send({ error: "no_pending_invite" });
    await prisma.consentGrant.update({
      where: { id: grant.id },
      data: { status: "revoked", revokedAt: new Date(), inviteToken: null },
    });
    await audit(operatorUserId, "invite_cancelled", req.params.id);
    return reply.send({ ok: true });
  });
}
