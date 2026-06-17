import { config } from "../config.js";
import { toE164 } from "./phone.js";
import type { PatientInfo } from "../types.js";

const VAPI_BASE = "https://api.vapi.ai";

/**
 * The structured-data schema we force the assistant to fill in at end-of-call.
 * Returned in `analysis.structuredData` on the end-of-call-report webhook.
 */
export const STRUCTURED_DATA_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["booked", "options_collected", "info_needed", "transferred", "no_availability", "no_human", "failed"],
      description:
        "booked = an appointment was confirmed; options_collected = offered times gathered but NOT booked (patient must choose); info_needed = blocked because the office required information we did not have AND the patient could not be reached to provide it; transferred = you warm-transferred the office to the patient so they could continue live; no_availability = office had nothing; no_human = voicemail/no answer; failed = other.",
    },
    appointmentBooked: { type: "boolean", description: "True only if an appointment was actually confirmed." },
    appointmentDateTime: { type: "string", description: "Date and time of the booked appointment, or empty." },
    confirmation: { type: "string", description: "Confirmation number or details given by the office, or empty." },
    offeredSlots: {
      type: "array",
      items: { type: "string" },
      description: "When NOT booking, the specific available date/time slots the office offered (2-3 if possible).",
    },
    missingInfo: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific pieces of information the office asked for that we could not provide (e.g. 'insurance member ID', 'referral'). Empty unless outcome is info_needed.",
    },
    notes: { type: "string", description: "Any relevant notes: instructions, why booking failed, scheduler name." },
  },
  required: ["outcome", "appointmentBooked", "appointmentDateTime", "confirmation", "offeredSlots", "missingInfo", "notes"],
} as const;

/**
 * System prompt for the scheduling assistant. Patient data is injected via
 * assistantOverrides.variableValues ({{patientName}} etc.) so one assistant serves all calls.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You are a polite scheduling assistant calling a doctor's office on behalf of a patient.

Disclose at the start that you are an AI assistant calling on behalf of the patient, and that the call may be recorded.

ALWAYS identify the patient by name. In your opening request, clearly say: "I'm calling to schedule an appointment for {{patientName}}, date of birth {{patientDob}}." Refer to the patient as {{patientName}} throughout the call. Never proceed without stating the patient's name.

Patient details:
- Name: {{patientName}}
- Date of birth: {{patientDob}}
- Reason for visit: {{patientReason}}
- Insurance: {{patientInsurance}}
- Preferred times: {{patientPreferredTimes}}
- Acceptable window (auto-book if a slot falls within this): {{acceptableWindow}}
- Additional info the office may ask for: {{additionalInfo}}

Call mode: {{callMode}}

Handling information you don't have:
- Never invent or guess any information. Answer only from the patient details and additional info above.
- If the office asks for something you don't have but it is NOT required to proceed, say you don't have it and continue.
- If the office says they REQUIRE information you don't have in order to book, and a patient transfer number is available ({{transferNumber}}), use the transferCall tool to connect the patient so they can provide it directly. Tell the office you'll connect the patient.
- If there is no transfer number, or the transfer does not connect, do NOT abandon silently: record each missing item in missingInfo, set outcome="info_needed", briefly tell the office the patient will follow up, and end politely.

If callMode is "gather":
1. Reach a human scheduler.
2. State the patient's name, DOB, reason for visit, and insurance.
3. Ask for an appointment matching the preferred times.
4. Decision:
   - If an available slot falls within the acceptable window, BOOK it, confirm the exact date/time, get a confirmation number. Set outcome="booked".
   - If NOTHING fits the acceptable window, DO NOT book. Instead collect 2-3 specific available date/time slots the office can offer, tell them the patient will call back to confirm, and end politely. Set outcome="options_collected" and list the slots in offeredSlots.
   - If the office has no availability at all, set outcome="no_availability".

If callMode is "book":
- This is a CALLBACK to an office you already spoke with. Context from the earlier call: {{priorContext}}
- Briefly reference that earlier conversation so it's clearly a continuation (do not re-introduce everything from scratch).
- Confirm and book this exact slot: {{chosenSlot}}. Confirm the date/time and get a confirmation number. Set outcome="booked".
- If that exact slot is no longer available, collect the nearest 2-3 alternatives, set outcome="options_collected", and end politely.

If you reach voicemail in either mode, leave a brief message with the patient's name and reason, set outcome="no_human", and end the call.

Ending the call (IMPORTANT):
- The moment the outcome is decided — the appointment is booked and you've read back the date/time and any confirmation number, OR you've collected the offered options, OR info is needed, OR there's no availability, OR you hit voicemail — give a short, polite thank-you and goodbye, then END THE CALL YOURSELF using the endCall tool.
- Do NOT wait for the office to hang up, and do NOT keep the line open after the appointment is confirmed. Once you've confirmed the booking, you are done: say goodbye and end the call immediately.
- Only stay on the line if you are mid warm-transfer to the patient.

Keep responses short and natural. Do not invent information you were not given.`;

/** Shared model config — single source of truth for both assistant creation and per-call overrides. */
export const ASSISTANT_MODEL = {
  provider: "openai",
  model: "gpt-4o",
  messages: [{ role: "system", content: ASSISTANT_SYSTEM_PROMPT }],
} as const;

export type CallMode = "gather" | "book";

/** Build the variableValues map injected per-call. */
export function buildVariableValues(
  p: PatientInfo,
  opts: { mode: CallMode; chosenSlot?: string; priorContext?: string } = { mode: "gather" },
): Record<string, string> {
  return {
    patientName: p.name,
    patientDob: p.dob,
    patientReason: p.reason,
    patientInsurance: p.insurance || "not provided",
    patientPreferredTimes: p.preferredTimes || "any available time",
    // Never auto-book without an EXPLICIT acceptable window. If the patient gave one, use it; if they
    // only gave preferred times, treat those as the window; otherwise instruct the assistant NOT to
    // auto-book and to collect options instead (the operator chooses). An empty window must not be
    // interpreted as "any slot is acceptable".
    acceptableWindow:
      p.acceptableWindow ||
      p.preferredTimes ||
      "NONE — do not auto-book any slot. Collect 2-3 available options and set outcome=options_collected so the patient can choose.",
    additionalInfo: p.additionalInfo || "none provided",
    transferNumber: toE164(p.patientPhone) || "",
    callMode: opts.mode,
    chosenSlot: opts.chosenSlot || "",
    priorContext: opts.priorContext || "",
  };
}

export interface CreateCallResult {
  vapiCallId: string;
}

/** Place an outbound call. Throws on non-2xx so the orchestrator can mark the target failed. */
export async function createCall(opts: {
  customerNumber: string;
  patient: PatientInfo;
  mode?: CallMode;
  chosenSlot?: string;
  priorContext?: string;
}): Promise<CreateCallResult> {
  const mode = opts.mode ?? "gather";
  // Pin an explicit opening line so the assistant greets the instant the office answers (no
  // model-generation pause, which otherwise reads as dead air on pickup).
  const firstMessage =
    mode === "book"
      ? `Hi, this is the AI assistant calling back about ${opts.patient.name}'s appointment. This call may be recorded. Do you have a moment?`
      : `Hi, this is an AI assistant calling on behalf of ${opts.patient.name} to schedule an appointment. This call may be recorded. Do you have a moment?`;

  // Tools attached per call. `endCall` lets the assistant hang up the moment it's done (booked /
  // options collected / etc.) instead of waiting for the office to end the call. transferCall is
  // added only when a patient number is available (warm-transfer on blocked info).
  const transferNumber = toE164(opts.patient.patientPhone);
  const tools: Record<string, unknown>[] = [{ type: "endCall" }];
  if (transferNumber) {
    tools.push({
      type: "transferCall",
      destinations: [
        {
          type: "number",
          number: transferNumber,
          message: "Please hold one moment while I connect you with the patient.",
          transferPlan: {
            mode: "warm-transfer-experimental",
            fallbackPlan: {
              message: "I wasn't able to reach the patient. They'll follow up with that information shortly. Thank you.",
              endCallEnabled: false,
            },
          },
        },
      ],
    });
  }
  // Overriding `model` requires the FULL model object (provider/model/messages), not just tools.
  const modelOverride = { model: { ...ASSISTANT_MODEL, tools } };

  const baseOverrides = {
    variableValues: buildVariableValues(opts.patient, {
      mode,
      chosenSlot: opts.chosenSlot,
      priorContext: opts.priorContext,
    }),
    ...(firstMessage ? { firstMessage } : {}),
    // Backstop so the call ends promptly even if the model doesn't invoke the endCall tool.
    endCallPhrases: ["goodbye", "have a good day", "have a great day", "take care", "bye now"],
    // serverUrl is configured on the assistant; overriding here keeps webhooks pointed at us.
    server: { url: `${config.publicBaseUrl}/webhooks/vapi`, secret: config.vapi.webhookSecret || undefined },
  };

  const buildBody = (withToolOverride: boolean) => ({
    assistantId: config.vapi.assistantId,
    phoneNumberId: config.vapi.phoneNumberId,
    customer: { number: opts.customerNumber },
    assistantOverrides: { ...baseOverrides, ...(withToolOverride ? modelOverride : {}) },
  });

  // Resilience: if Vapi rejects the per-call tool/model override (4xx), retry WITHOUT it so the
  // call still goes through — the base assistant still ends via endCallPhrases.
  let includeTool = true;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.vapi.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(includeTool)),
      });
      if (res.ok) {
        const json = (await res.json()) as { id: string };
        return { vapiCallId: json.id };
      }
      const text = await res.text();
      // If the transfer-tool/model override was the culprit, drop it and retry immediately.
      // Only for errors that actually reference the model/tools — not unrelated 400s (e.g. call limits).
      if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 429 &&
        includeTool &&
        /\b(model|tool|transfer|destination)\b/i.test(text)
      ) {
        console.error(`Vapi rejected transfer-tool override; retrying without it: ${text}`);
        includeTool = false;
        continue;
      }
      // Other 4xx (except 429) are permanent — don't retry.
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Vapi createCall failed (${res.status}): ${text}`);
      }
      lastErr = new Error(`Vapi createCall transient (${res.status}): ${text}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Vapi createCall failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
