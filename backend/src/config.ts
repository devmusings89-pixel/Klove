// Central env config. Fail loud on missing critical vars only in the contexts that need them.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

export const config = {
  port: num("PORT", 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8080",

  sessionPriceCents: num("SESSION_PRICE_CENTS", 500),
  // Concierge booking fee. 0 = free (operator-authorized, the default). When > 0 AND Stripe is
  // configured, /members/:id/book requires payment before Klove contacts the office.
  conciergePriceCents: num("CONCIERGE_PRICE_CENTS", 0),
  maxCallsPerSession: num("MAX_CALLS_PER_SESSION", 3),
  minutesCapPerSession: num("MINUTES_CAP_PER_SESSION", 60),
  // Off by default so dev/mock runs aren't blocked outside 9–5; turn on in prod.
  enforceBusinessHours: (process.env.ENFORCE_BUSINESS_HOURS ?? "false") === "true",

  // When true, Klove's concierge booking runs the REAL orchestrator (Vapi voice / web / email) —
  // it places live calls and outreach. Off by default; the booking is deterministically simulated
  // until you opt in. Set LIVE_BOOKING=true once you're ready to place real bookings.
  liveBooking: (process.env.LIVE_BOOKING ?? "false") === "true",

  vapi: {
    apiKey: process.env.VAPI_API_KEY ?? "",
    assistantId: process.env.VAPI_ASSISTANT_ID ?? "",
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ?? "",
    webhookSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "Klove <noreply@klove.app>",
  },

  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY ?? "",

  // Web-automation agent (Playwright + a pluggable LLM brain).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  webAgent: {
    // "anthropic" (Claude) or "openai-compatible" (Ollama / any OpenAI-compatible endpoint).
    provider: (process.env.WEB_AGENT_PROVIDER ?? "anthropic") as "anthropic" | "openai-compatible",
    baseUrl: process.env.WEB_AGENT_BASE_URL ?? "http://localhost:11434/v1", // default = local Ollama
    model: process.env.WEB_AGENT_MODEL ?? "", // resolved per-provider when blank
    apiKey: process.env.WEB_AGENT_API_KEY ?? "", // Ollama ignores; real OpenAI/etc. needs it
    maxSteps: num("WEB_AGENT_MAX_STEPS", 25),
  },

  apns: {
    keyId: process.env.APNS_KEY_ID ?? "",
    teamId: process.env.APNS_TEAM_ID ?? "",
    bundleId: process.env.APNS_BUNDLE_ID ?? "",
    keyPath: process.env.APNS_KEY_PATH ?? "",
  },

  // ---- Health-data ingestion ----

  // Supabase: HIPAA-compliant Postgres + Storage + Auth. Absent => local mock storage.
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "", // public/anon key (safe in clients)
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? "", // verify client JWTs
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET ?? "health-documents",
  },

  // Gmail / Google OAuth for the email source.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
    pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? "",
  },

  // Health-records aggregator (e.g. Metriport) for records HealthKit can't reach.
  aggregator: {
    apiKey: process.env.AGGREGATOR_API_KEY ?? "",
    webhookSecret: process.env.AGGREGATOR_WEBHOOK_SECRET ?? "",
    baseUrl: process.env.AGGREGATOR_BASE_URL ?? "",
  },

  // 32-byte key (base64/hex/utf8) for envelope-encrypting OAuth tokens at rest.
  encryptionKey: process.env.HEALTH_ENCRYPTION_KEY ?? "",
} as const;

/** True when a service is configured; lets the app run in mock mode while keys are absent. */
export const enabled = {
  vapi: () => Boolean(config.vapi.apiKey && config.vapi.assistantId && config.vapi.phoneNumberId),
  stripe: () => Boolean(config.stripe.secretKey),
  resend: () => Boolean(config.resend.apiKey),
  googlePlaces: () => Boolean(config.googlePlacesApiKey),
  // openai-compatible (Ollama) needs no key; anthropic needs ANTHROPIC_API_KEY.
  web: () => (config.webAgent.provider === "openai-compatible" ? true : Boolean(config.anthropicApiKey)),
  apns: () => Boolean(config.apns.keyId && config.apns.teamId && config.apns.bundleId && config.apns.keyPath),
  supabase: () => Boolean(config.supabase.url && config.supabase.serviceRoleKey),
  supabaseAuth: () => Boolean(config.supabase.jwtSecret),
  gmail: () => Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri),
  aggregator: () => Boolean(config.aggregator.apiKey && config.aggregator.baseUrl),
  // Health extraction reuses the Anthropic key already used by the web agent.
  healthExtraction: () => Boolean(config.anthropicApiKey),
};
