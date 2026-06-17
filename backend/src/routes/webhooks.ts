import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config, enabled, isProduction } from "../config.js";
import { constructWebhookEvent } from "../services/stripe.js";
import { placeNextCall, recordCallResult } from "../services/orchestrator.js";
import type { CallStructuredData } from "../types.js";
import { gmailSource } from "../sources/gmail.js";
import { aggregatorSource } from "../sources/aggregator.js";
import { ingestArtifact } from "../services/ingestion.js";
import { syncConnection } from "../services/health-worker.js";
import { encryptToken } from "../services/crypto.js";
import { exchangeCodeForTokens, getGmailProfile } from "../services/google.js";

export async function webhookRoutes(app: FastifyInstance) {
  // ---- Stripe ----
  // Needs the raw body for signature verification; registered via a content-type parser below.
  app.post("/webhooks/stripe", async (req, reply) => {
    if (!enabled.stripe()) return reply.code(400).send({ error: "stripe_not_configured" });
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") return reply.code(400).send({ error: "missing_signature" });

    let event;
    try {
      event = constructWebhookEvent(req.rawBody as Buffer, sig);
    } catch (err) {
      app.log.error({ err }, "stripe signature verification failed");
      return reply.code(400).send({ error: "invalid_signature" });
    }

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as { metadata?: { sessionId?: string } };
      const sessionId = pi.metadata?.sessionId;
      if (sessionId) {
        await prisma.session.update({ where: { id: sessionId }, data: { status: "paid" } });
        void placeNextCall(sessionId);
      }
    }
    return reply.send({ received: true });
  });

  // ---- Vapi ----
  app.post("/webhooks/vapi", async (req, reply) => {
    // In production the shared secret is mandatory — fail closed if it's unset (and the boot guard
    // should already have refused to start). In dev it stays optional so the pipeline is exercisable.
    if (!config.vapi.webhookSecret) {
      if (isProduction) return reply.code(503).send({ error: "webhook_not_configured" });
    } else {
      const secret = req.headers["x-vapi-secret"];
      if (secret !== config.vapi.webhookSecret) return reply.code(401).send({ error: "unauthorized" });
    }

    const body = req.body as { message?: VapiMessage };
    const msg = body?.message;
    if (!msg) return reply.send({ received: true });

    if (msg.type === "status-update" && msg.call?.id) {
      // Reflect ringing/in-progress on the matching target without finalizing it.
      const t = await prisma.callTarget.findFirst({ where: { vapiCallId: msg.call.id } });
      if (t && t.status === "calling") app.log.info({ status: msg.status }, "vapi status-update");
    }

    if (msg.type === "end-of-call-report" && msg.call?.id) {
      const structured = msg.analysis?.structuredData as CallStructuredData | undefined;
      const durationSec =
        msg.durationSeconds ??
        (msg.startedAt && msg.endedAt
          ? Math.round((Date.parse(msg.endedAt) - Date.parse(msg.startedAt)) / 1000)
          : undefined);

      await recordCallResult({
        vapiCallId: msg.call.id,
        transcript: msg.artifact?.transcript ?? msg.transcript,
        summary: msg.analysis?.summary ?? msg.summary,
        structuredData: structured,
        recordingUrl: msg.artifact?.recordingUrl ?? msg.recordingUrl,
        endedReason: msg.endedReason,
        durationSec,
      });
    }

    return reply.send({ received: true });
  });

  // ---- Gmail (email source) ----
  // OAuth callback: exchange the code for tokens, store them on the connection, return to the app.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/webhooks/gmail/oauth", async (req, reply) => {
    if (!enabled.gmail()) return reply.code(400).send({ error: "gmail_not_configured" });
    if (req.query.error || !req.query.code || !req.query.state) {
      return reply.redirect("klove://gmail/error");
    }
    try {
      const { userId } = JSON.parse(Buffer.from(req.query.state, "base64url").toString("utf8")) as { userId: string };
      const tokens = await exchangeCodeForTokens(req.query.code);
      const profile = await getGmailProfile(tokens.access_token);

      // Attach tokens to the pending connection created in connect().
      const pending = await prisma.dataSourceConnection.findFirst({
        where: { userId, type: "gmail" },
        orderBy: { createdAt: "desc" },
      });
      const data = {
        status: "connected",
        externalAccountId: profile.emailAddress,
        accessTokenEnc: encryptToken(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token ? encryptToken(tokens.refresh_token) : undefined,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        cursor: JSON.stringify({ historyId: profile.historyId }),
      };
      const conn = pending
        ? await prisma.dataSourceConnection.update({ where: { id: pending.id }, data })
        : await prisma.dataSourceConnection.create({ data: { userId, type: "gmail", ...data } });
      // Kick off the first scan now (don't block the redirect) so records start flowing right after
      // consent instead of waiting for the next ingestion tick. The client re-syncs on return too.
      void syncConnection(conn).catch((err) => app.log.error({ err }, "gmail post-oauth scan failed"));
      return reply.redirect("klove://gmail/connected");
    } catch (err) {
      app.log.error({ err }, "gmail oauth exchange failed");
      return reply.redirect("klove://gmail/error");
    }
  });

  // Pub/Sub push: new mail available → pull and ingest.
  app.post("/webhooks/gmail/push", async (req, reply) => {
    if (!enabled.gmail()) return reply.code(400).send({ error: "gmail_not_configured" });
    try {
      const { userId, artifacts } = await gmailSource.handleWebhook!(req.body);
      if (userId) for (const a of artifacts) await ingestArtifact(userId, "gmail", a);
    } catch (err) {
      app.log.error({ err }, "gmail push handling failed");
    }
    return reply.send({ received: true });
  });

  // ---- Aggregator (health-records vendor) ----
  app.post("/webhooks/aggregator", async (req, reply) => {
    if (!enabled.aggregator()) return reply.code(400).send({ error: "aggregator_not_configured" });
    if (config.aggregator.webhookSecret) {
      const secret = req.headers["x-webhook-key"];
      if (secret !== config.aggregator.webhookSecret) return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const { userId, artifacts } = await aggregatorSource.handleWebhook!(req.body);
      if (userId) for (const a of artifacts) await ingestArtifact(userId, "aggregator", a);
    } catch (err) {
      app.log.error({ err }, "aggregator webhook handling failed");
    }
    return reply.send({ received: true });
  });
}

// Loose typing for the Vapi webhook payload (only the fields we read).
interface VapiMessage {
  type: string;
  status?: string;
  endedReason?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  durationSeconds?: number;
  startedAt?: string;
  endedAt?: string;
  call?: { id: string };
  artifact?: { transcript?: string; recordingUrl?: string };
  analysis?: { summary?: string; structuredData?: unknown };
}
