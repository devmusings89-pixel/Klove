/**
 * One-time setup: create the Klove scheduling assistant in your Vapi account.
 * Reuses the system prompt + structured-data schema from src/services/vapi.ts so the
 * live assistant and the code never drift.
 *
 * Run:  VAPI_API_KEY=xxx PUBLIC_BASE_URL=https://<ngrok>.ngrok.app npm run create-assistant
 * Then copy the printed id into VAPI_ASSISTANT_ID in your .env.
 */
import { ASSISTANT_MODEL, STRUCTURED_DATA_SCHEMA } from "../src/services/vapi.js";

const apiKey = process.env.VAPI_API_KEY;
const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
if (!apiKey) {
  console.error("Set VAPI_API_KEY (your Vapi private key).");
  process.exit(1);
}

const assistant = {
  name: "Klove Scheduling Agent",
  firstMessage:
    "Hi, this is an AI assistant calling on behalf of a patient to schedule an appointment. This call may be recorded. Do you have a moment?",
  transcriber: { provider: "deepgram", model: "nova-2", language: "en" },
  // The endCall tool lets the assistant hang up itself once the booking outcome is decided (it does
  // not wait for the office). The transferCall tool is injected per call (via assistantOverrides)
  // with the real patient number — Vapi rejects a Liquid template here as it validates E.164 at save.
  model: { ...ASSISTANT_MODEL, tools: [{ type: "endCall" }] },
  // Backstop in case the model doesn't invoke the tool.
  endCallPhrases: ["goodbye", "have a good day", "have a great day", "take care", "bye now"],
  voice: { provider: "vapi", voiceId: "Elliot" },
  // Force structured outcome + summary at end of call → arrives in end-of-call-report webhook.
  analysisPlan: {
    structuredDataPlan: { enabled: true, schema: STRUCTURED_DATA_SCHEMA },
    summaryPlan: { enabled: true },
    successEvaluationPlan: { enabled: true },
  },
  // Default webhook target (per-call override in createCall also points here).
  server: { url: `${baseUrl}/webhooks/vapi` },
};

// If VAPI_ASSISTANT_ID is set, UPDATE that assistant in place (PATCH); otherwise create one.
const existingId = process.env.VAPI_ASSISTANT_ID;
const url = existingId ? `https://api.vapi.ai/assistant/${existingId}` : "https://api.vapi.ai/assistant";
const method = existingId ? "PATCH" : "POST";

const res = await fetch(url, {
  method,
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(assistant),
});

if (!res.ok) {
  console.error(`Failed (${res.status}):`, await res.text());
  process.exit(1);
}
const json = (await res.json()) as { id: string };
if (existingId) {
  console.log(`\n✅ Assistant updated in place (${json.id}). Prompt + structured schema are now current.`);
} else {
  console.log("\n✅ Assistant created.");
  console.log("   VAPI_ASSISTANT_ID=" + json.id);
  console.log("\nNext: also set VAPI_PHONE_NUMBER_ID (from a Vapi phone number), then restart the backend.");
}
