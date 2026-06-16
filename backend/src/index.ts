import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config, enabled } from "./config.js";
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
import { notificationRoutes } from "./routes/notifications.js";
import { prepRoutes } from "./routes/prep.js";
import { askRoutes } from "./routes/ask.js";
import { deviceRoutes } from "./routes/devices.js";
import { runSchedulerTick } from "./services/orchestrator.js";
import { runExtractionTick, runIngestionTick } from "./services/health-worker.js";
import { runReminderTick } from "./services/reminders.js";
import { reconcileConciergeJobs } from "./services/concierge.js";

const app = Fastify({ logger: true });

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

app.get("/health", async () => ({
  ok: true,
  mode: {
    vapi: enabled.vapi() ? "live" : "mock",
    stripe: enabled.stripe() ? "live" : "mock",
    resend: enabled.resend() ? "live" : "mock",
    googlePlaces: enabled.googlePlaces() ? "live" : "mock",
    web: enabled.web() ? `live:${config.webAgent.provider}` : "mock",
    storage: enabled.supabase() ? "live:supabase" : "mock:local",
    auth: enabled.supabaseAuth() ? "live:supabase" : "mock:header",
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
await app.register(notificationRoutes);
await app.register(prepRoutes);
await app.register(askRoutes);
await app.register(deviceRoutes);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Klove backend on :${config.port}`);
    // Worker: advance scheduled/deferred sessions, reap stuck calls, and fire due reminders every 60s.
    setInterval(() => {
      runSchedulerTick().catch((err) => app.log.error({ err }, "scheduler tick failed"));
      runReminderTick().catch((err) => app.log.error({ err }, "reminder tick failed"));
      reconcileConciergeJobs().catch((err) => app.log.error({ err }, "concierge reconcile failed"));
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
