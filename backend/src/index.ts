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
import { taskRoutes } from "./routes/tasks.js";
import { todayRoutes } from "./routes/today.js";
import { reminderRoutes } from "./routes/reminders.js";
import { medicationRoutes } from "./routes/medications.js";
import { notificationRoutes } from "./routes/notifications.js";
import { prepRoutes } from "./routes/prep.js";
import { askRoutes } from "./routes/ask.js";
import { deviceRoutes } from "./routes/devices.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { runSchedulerTick } from "./services/orchestrator.js";
import { runExtractionTick, runIngestionTick } from "./services/health-worker.js";
import { runReminderTick, autoGenerateReminders } from "./services/reminders.js";
import { runMedicationDoseTick, runMissedDoseTick, runRefillTick } from "./services/medications.js";
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
await app.register(askRoutes);
await app.register(deviceRoutes);
await app.register(preferenceRoutes);

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

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Klove backend on :${config.port}`);
    // Worker: advance scheduled/deferred sessions, reap stuck calls, and fire due reminders every 60s.
    setInterval(() => {
      runSchedulerTick().catch((err) => app.log.error({ err }, "scheduler tick failed"));
      runReminderTick().catch((err) => app.log.error({ err }, "reminder tick failed"));
      autoGenerateReminders().catch((err) => app.log.error({ err }, "auto-reminder gen failed"));
      reconcileConciergeJobs().catch((err) => app.log.error({ err }, "concierge reconcile failed"));
      runMedicationDoseTick().catch((err) => app.log.error({ err }, "med dose tick failed"));
      runMissedDoseTick().catch((err) => app.log.error({ err }, "missed dose tick failed"));
      runRefillTick().catch((err) => app.log.error({ err }, "refill tick failed"));
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
