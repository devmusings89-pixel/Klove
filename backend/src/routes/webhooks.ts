import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { config, enabled, isProduction } from "../config.js";
import { constructWebhookEvent } from "../services/stripe.js";
import { placeNextCall, recordCallResult, ACTIVE_CALL_STATES } from "../services/orchestrator.js";
import { reconcileConciergeJobs } from "../services/concierge.js";
import type { CallStructuredData } from "../types.js";
import { gmailSource } from "../sources/gmail.js";
import { aggregatorSource } from "../sources/aggregator.js";
import { ingestArtifact } from "../services/ingestion.js";
import { syncConnection } from "../services/health-worker.js";
import { encryptToken } from "../services/crypto.js";
import { exchangeCodeForTokens, getGmailProfile } from "../services/google.js";
import { verifyTwilioSignature, twilioAuthConfigured } from "../services/whatsapp.js";
import { toE164 } from "../services/phone.js";
import { handleWhatsAppInbound } from "../services/whatsapp-inbound.js";
import { downloadTwilioMedia } from "../services/whatsapp-media.js";

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
      // Refine an active call's status so the live "theater" can show dialing → ringing → on-call
      // instead of a single opaque "calling". Only refine a still-active target — never overwrite a
      // finalized status (booked/failed/awaiting_*), which the end-of-call-report owns.
      const t = await prisma.callTarget.findFirst({ where: { vapiCallId: msg.call.id } });
      const mapped = mapVapiCallStatus(msg.status);
      if (t && ACTIVE_CALL_STATES.includes(t.status) && mapped && mapped !== t.status) {
        await prisma.callTarget.update({ where: { id: t.id }, data: { status: mapped } });
        app.log.info({ from: t.status, to: mapped }, "vapi status-update");
      }
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
      // Reflect the outcome immediately instead of waiting for the 60s reconcile tick: turn a
      // just-booked concierge job into a confirmed appointment + handled task right now.
      void reconcileConciergeJobs().catch((e) => app.log.error({ err: e }, "reconcile after call failed"));
    }

    return reply.send({ received: true });
  });

  // ---- WhatsApp (concierge agent inbound) ----
  // Twilio POSTs form-encoded inbound messages here. We verify the X-Twilio-Signature, resolve the
  // user by phone, hand the text to the concierge agent, and reply over REST (the agent loop can
  // outlast Twilio's webhook timeout). The webhook itself returns an empty TwiML <Response/> at once.
  app.post("/webhooks/whatsapp", async (req, reply) => {
    const xml = (body = "") => reply.header("content-type", "text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);

    // Signature verification: mandatory in production; optional in dev (no auth token configured).
    if (twilioAuthConfigured()) {
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      const url = `${config.publicBaseUrl}/webhooks/whatsapp`;
      if (!verifyTwilioSignature(url, (req.body as Record<string, string>) ?? {}, sig)) {
        return reply.code(403).send({ error: "invalid_signature" });
      }
    } else if (isProduction) {
      return reply.code(503).send({ error: "webhook_not_configured" });
    }

    const body = (req.body ?? {}) as Record<string, string>;
    const from = toE164((body.From ?? "").replace(/^whatsapp:/, ""));
    const text = (body.Body ?? "").trim();
    if (!from) return xml();

    // Collect any media (Twilio gives authed URLs), then run the shared inbound handler out-of-band so
    // the webhook returns fast (the agent loop can outlast Twilio's webhook timeout).
    const numMedia = Number(body.NumMedia ?? "0") || 0;
    const mediaUrls: { url: string; contentType: string }[] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = body[`MediaUrl${i}`];
      if (url) mediaUrls.push({ url, contentType: body[`MediaContentType${i}`] ?? "application/octet-stream" });
    }

    void (async () => {
      const media = mediaUrls.length ? await downloadTwilioMedia(mediaUrls) : [];
      await handleWhatsAppInbound(from, text, media);
    })().catch((err) => app.log.error({ err }, "whatsapp inbound failed"));
    return xml();
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

/**
 * Map a Vapi call status-update to our refined in-flight CallTarget status. Returns null for
 * statuses we don't surface (queued/forwarding/ended) — those leave the target as-is.
 */
function mapVapiCallStatus(status?: string): "ringing" | "in_call" | null {
  switch (status) {
    case "ringing":
      return "ringing";
    case "in-progress":
      return "in_call";
    default:
      return null;
  }
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
