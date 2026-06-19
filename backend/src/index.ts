import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { config, enabled, isProduction } from "./config.js";
import { sessionRoutes } from "./routes/sessions.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { uploadRoutes } from "./routes/uploads.js";
import { healthRecordRoutes } from "./routes/health-records.js";
import { sourceRoutes } from "./routes/sources.js";
import { intakeRoutes } from "./routes/intake.js";
import { profileRoutes } from "./routes/profile.js";
import { householdRoutes } from "./routes/household.js";
import { memberRoutes } from "./routes/members.js";
import { consentRoutes } from "./routes/consent.js";
import { memberDataRoutes } from "./routes/member-data.js";
import { taskRoutes, resurfaceSnoozedTasks } from "./routes/tasks.js";
import { todayRoutes } from "./routes/today.js";
import { reminderRoutes } from "./routes/reminders.js";
import { medicationRoutes } from "./routes/medications.js";
import { notificationRoutes } from "./routes/notifications.js";
import { prepRoutes } from "./routes/prep.js";
import { providerRoutes } from "./routes/providers.js";
import { physicianRoutes } from "./routes/physicians.js";
import { askRoutes } from "./routes/ask.js";
import { deviceRoutes } from "./routes/devices.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { runSchedulerTick } from "./services/orchestrator.js";
import { runExtractionTick, runIngestionTick } from "./services/health-worker.js";
import { runReminderTick, autoGenerateReminders } from "./services/reminders.js";
import { runMedicationDoseTick, runMissedDoseTick, runRefillTick } from "./services/medications.js";
import { runProactiveOutreachTick } from "./services/proactive.js";
import { smsEnabled } from "./services/sms.js";
import { whatsappEnabled, whatsappTransport } from "./services/whatsapp.js";
import { startBaileys } from "./services/whatsapp-baileys.js";
import { reconcileConciergeJobs } from "./services/concierge.js";

// HIPAA: never log request/response bodies (they carry PHI) and redact identity headers. The
// request serializer emits only method+url; bodies are not serialized at all.
const app = Fastify({
  logger: {
    redact: ['req.headers.authorization', 'req.headers["x-user-email"]', "req.headers.cookie"],
    serializers: {
      req(req) {
        return { method: req.method, url: req.url };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  },
});

// Capture the raw body alongside the parsed JSON — Stripe webhook signature
// verification needs the exact bytes. Applies to all application/json requests.
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
  try {
    const json = body.length ? JSON.parse(body.toString("utf8")) : {};
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// Twilio webhooks (WhatsApp) POST application/x-www-form-urlencoded. Capture the raw bytes (for the
// X-Twilio-Signature check) and expose the params as a flat object on req.body.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (req, body, done) => {
  (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
  try {
    const params = new URLSearchParams(body.toString("utf8"));
    const obj: Record<string, string> = {};
    for (const [k, v] of params) obj[k] = v;
    done(null, obj);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// ---- CORS (hand-rolled; @fastify/cors not installed) ----
// Allowlist is config-driven (CORS_ORIGINS). In production an empty allowlist denies all browser
// origins; in dev (no allowlist) we reflect the request origin so local tooling works.
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    const allowed = config.corsOrigins.length
      ? config.corsOrigins.includes(origin)
      : !isProduction; // dev convenience only
    if (allowed) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,x-user-email");
    }
  }
  if (req.method === "OPTIONS") {
    reply.code(204).send();
  }
});

// ---- Rate limiting (minimal in-memory fixed-window; @fastify/rate-limit not installed) ----
// Sensitive routes (auth-adjacent, session creation, verification) get a tighter budget. Keyed by
// client IP. A single-process limiter is adequate for the current single-instance deployment; move
// to a shared store if scaled out.
interface Bucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, Bucket>();
const RATE_WINDOW_MS = 60_000;
function clientKey(req: FastifyRequest): string {
  return `${req.ip}:${req.routeOptions?.url ?? req.url}`;
}
function isSensitive(req: FastifyRequest): boolean {
  const url = req.url.split("?")[0];
  if (req.method === "POST" && url === "/sessions") return true;
  if (req.method === "POST" && /^\/sessions\/[^/]+\/verify$/.test(url)) return true;
  if (url.startsWith("/auth") || url.startsWith("/webhooks/gmail/oauth")) return true;
  return false;
}
app.addHook("onRequest", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  const limit = isSensitive(req) ? 10 : 120; // per IP per minute
  const key = clientKey(req);
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  b.count += 1;
  if (b.count > limit) {
    reply.header("Retry-After", Math.ceil((b.resetAt - now) / 1000));
    await reply.code(429).send({ error: "rate_limited" });
  }
});
// Opportunistically evict expired buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, RATE_WINDOW_MS).unref();

// Generic error handler: log the real error (scrubbed by the PHI-safe serializers) but never leak a
// stack/message to the client. Preserve explicit 4xx status codes set by routes/preHandlers.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  req.log.error({ err, statusCode: status }, "request error");
  const body =
    status === 500
      ? { error: "internal_error" }
      : { error: (err as { code?: string }).code ?? "request_error" };
  reply.code(status).send(body);
});

// Not-found handler: generic body, no echo of the requested path beyond what logging already records.
app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
  reply.code(404).send({ error: "not_found" });
});

app.get("/health", async () => ({
  ok: true,
  mode: {
    vapi: enabled.vapi() ? "live" : "mock",
    stripe: enabled.stripe() ? "live" : "mock",
    resend: enabled.resend() ? "live" : "mock",
    whatsapp: `${whatsappTransport()}:${whatsappEnabled() ? "live" : whatsappTransport() === "baileys" ? "connecting" : "mock"}`,
    googlePlaces: enabled.googlePlaces() ? "live" : "mock",
    web: enabled.web() ? `live:${config.webAgent.provider}` : "mock",
    storage: enabled.supabase() ? "live:supabase" : "mock:local",
    // Honest auth posture: live JWT, dev header-trust, or (prod w/o secret) explicitly disabled.
    auth: enabled.supabaseAuth() ? "live:supabase" : isProduction ? "disabled:prod-misconfigured" : "mock:header",
    healthExtraction: enabled.healthExtraction() ? "live" : "mock",
    gmail: enabled.gmail() ? "live" : "mock",
    aggregator: enabled.aggregator() ? "live" : "mock",
  },
}));

// Multipart uploads (health document upload). 25 MB cap per file.
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

await app.register(sessionRoutes);
await app.register(webhookRoutes);
await app.register(uploadRoutes);
await app.register(healthRecordRoutes);
await app.register(sourceRoutes);
await app.register(intakeRoutes);
await app.register(profileRoutes);
await app.register(householdRoutes);
await app.register(memberRoutes);
await app.register(consentRoutes);
await app.register(memberDataRoutes);
await app.register(taskRoutes);
await app.register(todayRoutes);
await app.register(reminderRoutes);
await app.register(medicationRoutes);
await app.register(notificationRoutes);
await app.register(prepRoutes);
await app.register(providerRoutes);
await app.register(physicianRoutes);
await app.register(askRoutes);
await app.register(deviceRoutes);
await app.register(preferenceRoutes);
await app.register(whatsappRoutes);

// Fail closed at boot in production: refuse to start if auth would degrade to header-trust, or if
// the Vapi webhook secret is unset (anyone could POST call results otherwise).
if (isProduction) {
  const missing: string[] = [];
  if (!enabled.supabaseAuth()) missing.push("SUPABASE_JWT_SECRET");
  if (!config.vapi.webhookSecret) missing.push("VAPI_WEBHOOK_SECRET");
  if (missing.length) {
    app.log.error(`Refusing to start in production: missing required secrets: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// "Nothing simulated" audit. Each entry is a subsystem that would run in mock/simulated mode given
// the current env, plus the env var(s) that take it live. With REQUIRE_LIVE=true the server refuses
// to boot while this list is non-empty; otherwise it logs a one-time warning banner at startup.
function simulatedSubsystems(): { name: string; fix: string }[] {
  const out: { name: string; fix: string }[] = [];
  if (!enabled.healthExtraction())
    out.push({ name: "AI extraction / analysis / Ask / intake / triage (returns deterministic sample data)", fix: "OPENROUTER_API_KEY (or ANTHROPIC_API_KEY)" });
  if (!config.liveBooking)
    out.push({ name: "Booking concierge (LIVE_BOOKING off — Klove can't place bookings, only logs a task)", fix: "LIVE_BOOKING=true" });
  else if (!enabled.vapi())
    out.push({ name: "Booking voice calls (live booking on, but Vapi unconfigured)", fix: "VAPI_API_KEY + VAPI_ASSISTANT_ID + VAPI_PHONE_NUMBER_ID" });
  if (!config.vapi.webhookSecret)
    out.push({ name: "Vapi call-result callbacks (unauthenticated — anyone could POST results)", fix: "VAPI_WEBHOOK_SECRET" });
  if (!enabled.googlePlaces())
    out.push({ name: "Office phone lookup (live booking falls back to simulated without contact info)", fix: "GOOGLE_PLACES_API_KEY" });
  if (!enabled.npiRegistry())
    out.push({ name: "Physician search (returns deterministic seeded specialists instead of the NPI registry)", fix: "PHYSICIAN_SEARCH_LIVE=true" });
  if (!enabled.stripe())
    out.push({ name: "Payments (mock-payment endpoint instead of Stripe)", fix: "STRIPE_SECRET_KEY" });
  if (!enabled.resend())
    out.push({ name: "Email sending (logged, not delivered)", fix: "RESEND_API_KEY" });
  if (!smsEnabled())
    out.push({ name: "SMS sending (logged, not delivered)", fix: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER" });
  if (whatsappTransport() === "twilio" && !whatsappEnabled())
    out.push({ name: "WhatsApp sending (Twilio, logged not delivered)", fix: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM" });
  if (!enabled.apns())
    out.push({ name: "Push notifications (no-op)", fix: "APNS_KEY_ID + APNS_TEAM_ID + APNS_BUNDLE_ID + APNS_KEY_PATH" });
  if (!enabled.supabase())
    out.push({ name: "Document storage (local mock store instead of Supabase Storage)", fix: "SUPABASE_SERVICE_ROLE_KEY" });
  if (!enabled.supabaseAuth())
    out.push({ name: "Auth (dev header-trust — does NOT verify Supabase JWTs)", fix: "SUPABASE_JWT_SECRET" });
  if (!enabled.gmail())
    out.push({ name: "Gmail email source", fix: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REDIRECT_URI" });
  if (!enabled.aggregator())
    out.push({ name: "Records aggregator source (Metriport)", fix: "AGGREGATOR_API_KEY" });
  if (!config.encryptionKey)
    out.push({ name: "OAuth-token encryption at rest", fix: "HEALTH_ENCRYPTION_KEY" });
  return out;
}

const simulated = simulatedSubsystems();
if (simulated.length === 0) {
  app.log.info("Live mode: no simulated subsystems.");
} else {
  const banner = simulated.map((s) => `  • ${s.name}\n      → set ${s.fix}`).join("\n");
  if (config.requireLive) {
    app.log.error(`REQUIRE_LIVE is set but ${simulated.length} subsystem(s) are still simulated:\n${banner}`);
    process.exit(1);
  }
  app.log.warn(`${simulated.length} subsystem(s) running SIMULATED/mock (set REQUIRE_LIVE=true to enforce live-only):\n${banner}`);
}

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Klove backend on :${config.port}`);
    // WhatsApp via Baileys: open the socket (prints a QR to pair on first run). Twilio uses the webhook.
    if (whatsappTransport() === "baileys") {
      startBaileys().catch((err) => app.log.error({ err }, "baileys start failed"));
    }
    // Worker: advance scheduled/deferred sessions, reap stuck calls, and fire due reminders every 60s.
    setInterval(() => {
      runSchedulerTick().catch((err) => app.log.error({ err }, "scheduler tick failed"));
      runReminderTick().catch((err) => app.log.error({ err }, "reminder tick failed"));
      resurfaceSnoozedTasks().catch((err) => app.log.error({ err }, "snooze resurface failed"));
      autoGenerateReminders().catch((err) => app.log.error({ err }, "auto-reminder gen failed"));
      reconcileConciergeJobs().catch((err) => app.log.error({ err }, "concierge reconcile failed"));
      runMedicationDoseTick().catch((err) => app.log.error({ err }, "med dose tick failed"));
      runMissedDoseTick().catch((err) => app.log.error({ err }, "missed dose tick failed"));
      runRefillTick().catch((err) => app.log.error({ err }, "refill tick failed"));
      runProactiveOutreachTick().catch((err) => app.log.error({ err }, "proactive outreach tick failed"));
    }, 60_000);
    // Health pipeline workers: poll pollable sources + drain the extraction queue.
    setInterval(() => {
      runIngestionTick().catch((err) => app.log.error({ err }, "ingestion tick failed"));
      runExtractionTick().catch((err) => app.log.error({ err }, "extraction tick failed"));
    }, 15_000);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
