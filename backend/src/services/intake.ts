// Natural-language booking intake: turn a phrase like "book me a dentist visit" into a structured
// BookingDraft via Claude forced tool-use (mirrors extraction.ts). The booking ENGINE is unchanged —
// a confirmed draft maps to the existing CreateSessionRequest. Mock mode (no key) parses deterministically.

import Anthropic from "@anthropic-ai/sdk";
import type { Appointment } from "@prisma/client";
import { config, enabled } from "../config.js";

/** A reusable provider pulled from the user's past appointments (so they never re-enter it). */
export interface ProviderCandidate {
  officeName: string;
  phoneNumber?: string;
  website?: string;
  location?: string;
  lastSeen?: string; // ISO date of the most recent visit with this provider
  source: "appointment";
}

/** The structured booking task the assistant builds up over the conversation. */
export interface BookingDraft {
  reason?: string; // "dental cleaning"
  specialty?: string; // "dentist"
  providerHint?: string; // a provider named in the phrase ("Dr. Lin")
  location?: string; // city/area to search if no known provider
  preferredTimes?: string; // free text ("Saturday mornings")
  acceptableWindow?: string; // auto-book window ("any Saturday")
  urgency?: "routine" | "soon" | "urgent";
  patientName?: string;
  assistantMessage: string; // friendly line to show the user this turn
  nextQuestion?: string; // the one thing to ask next (empty when ready)
  missingSlots: SlotKey[]; // computed server-side
  providerCandidates: ProviderCandidate[]; // computed server-side from past appointments
  readyToBook: boolean; // computed server-side
}

export type SlotKey = "what" | "where" | "when";

const INTENT_TOOL: Anthropic.Tool = {
  name: "book_intent",
  description:
    "Extract a medical-appointment booking request from the user's message and the conversation so far. " +
    "Only fill fields the user actually stated or clearly implied — never invent a provider, date, or time. " +
    "For timing, capture the user's words as a window (e.g. 'Saturday mornings'); do NOT guess a specific date.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Reason for the visit, e.g. 'dental cleaning', 'rash on arm'." },
      specialty: { type: "string", description: "Provider type, e.g. 'dentist', 'dermatologist', 'primary care'." },
      providerHint: { type: "string", description: "A specific provider/office the user named, if any." },
      location: { type: "string", description: "City/area to search if the user has no known provider." },
      preferredTimes: { type: "string", description: "Preferred times in the user's own words." },
      acceptableWindow: { type: "string", description: "Window the user is OK auto-booking within, if stated." },
      urgency: { type: "string", enum: ["routine", "soon", "urgent"] },
      patientName: { type: "string", description: "Who the visit is for, if named (e.g. a family member)." },
      assistantMessage: { type: "string", description: "One short, warm sentence acknowledging the request." },
      nextQuestion: { type: "string", description: "The single most useful question to ask next, if something is missing." },
    },
    required: ["assistantMessage"],
  },
};

const SYSTEM =
  "You are Klove's booking concierge. Be warm and concise. Your job is to turn the user's request into a " +
  "structured booking task, asking for at most ONE missing thing at a time. Extract aggressively from what they " +
  "said; ask only when something required is genuinely missing. Required to book: (1) what kind of visit, and " +
  "(2) which provider or where to look. Timing is optional (default flexible). Never invent providers or dates.";

/**
 * Parse a natural-language request into a BookingDraft. `priorDraft` carries the conversation's
 * accumulated slots so each turn refines rather than restarts. `appointments` are the user's recent
 * visits, used to (a) hint the model and (b) build reusable provider candidates.
 */
export async function parseBookingIntent(
  text: string,
  appointments: Appointment[],
  priorDraft?: Partial<BookingDraft>,
): Promise<BookingDraft> {
  const raw = enabled.healthExtraction()
    ? await llmParse(text, appointments, priorDraft)
    : mockParse(text, priorDraft);

  // Merge onto the prior draft so earlier-captured slots persist across turns.
  const merged: Partial<BookingDraft> = {
    reason: raw.reason ?? priorDraft?.reason,
    specialty: raw.specialty ?? priorDraft?.specialty,
    providerHint: raw.providerHint ?? priorDraft?.providerHint,
    location: raw.location ?? priorDraft?.location,
    preferredTimes: raw.preferredTimes ?? priorDraft?.preferredTimes,
    acceptableWindow: raw.acceptableWindow ?? priorDraft?.acceptableWindow,
    urgency: raw.urgency ?? priorDraft?.urgency,
    patientName: raw.patientName ?? priorDraft?.patientName,
    assistantMessage: raw.assistantMessage ?? "Got it.",
    nextQuestion: raw.nextQuestion,
  };

  const providerCandidates = matchProviders(merged, appointments);
  const missingSlots = computeMissing(merged, providerCandidates);
  const readyToBook = missingSlots.length === 0;

  return {
    ...merged,
    assistantMessage: merged.assistantMessage ?? "Got it.",
    missingSlots,
    providerCandidates,
    readyToBook,
    // Once we have everything, drop any clarifying question and invite confirmation.
    nextQuestion: readyToBook ? undefined : merged.nextQuestion ?? questionFor(missingSlots[0]),
  };
}

/** Required slots: what kind of visit + a provider/place. Timing is optional. */
function computeMissing(d: Partial<BookingDraft>, candidates: ProviderCandidate[]): SlotKey[] {
  const missing: SlotKey[] = [];
  if (!d.reason && !d.specialty) missing.push("what");
  if (candidates.length === 0 && !d.providerHint && !d.location) missing.push("where");
  return missing;
}

function questionFor(slot: SlotKey | undefined): string | undefined {
  switch (slot) {
    case "what": return "What kind of visit do you need?";
    case "where": return "Do you have a doctor in mind, or what area should I search?";
    case "when": return "Any preferred days or times?";
    default: return undefined;
  }
}

// ---- Provider candidates from past appointments ----

const SPECIALTY_KEYWORDS: Record<string, RegExp> = {
  dentist: /dent|dds|dmd|orthodon|hygien|teeth|tooth/i,
  dermatologist: /derm|skin/i,
  "primary care": /primary|family medicine|internist|internal medicine|gp|pcp/i,
  cardiologist: /cardio|heart/i,
  "eye doctor": /optom|ophthal|eye|vision/i,
  "ob-gyn": /ob.?gyn|obstetric|gynec/i,
  pediatrician: /pediatr|child/i,
  endocrinologist: /endocrin|diabet|thyroid/i,
};

/** Find up to 3 distinct past providers relevant to the draft (most recent first). */
function matchProviders(d: Partial<BookingDraft>, appointments: Appointment[]): ProviderCandidate[] {
  const terms = [d.specialty, d.reason, d.providerHint].filter(Boolean).join(" ").toLowerCase();
  if (!terms.trim()) return [];
  const specialtyRe = d.specialty ? SPECIALTY_KEYWORDS[d.specialty.toLowerCase()] : undefined;
  const words = terms.split(/\s+/).filter((w) => w.length > 3);

  const scored = appointments
    .filter((a) => a.provider) // need a name to rebook
    .map((a) => {
      const hay = `${a.title} ${a.provider ?? ""} ${a.location ?? ""}`.toLowerCase();
      let score = 0;
      if (specialtyRe && specialtyRe.test(hay)) score += 3;
      for (const w of words) if (hay.includes(w)) score += 1;
      return { a, score };
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || dateDesc(x.a, y.a));

  const seen = new Set<string>();
  const out: ProviderCandidate[] = [];
  for (const { a } of scored) {
    const key = (a.provider ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      officeName: a.provider!,
      // WS2 adds providerPhone/providerWebsite/providerAddress to Appointment; read defensively.
      phoneNumber: (a as { providerPhone?: string }).providerPhone ?? undefined,
      website: (a as { providerWebsite?: string }).providerWebsite ?? undefined,
      location: a.location ?? undefined,
      lastSeen: a.startsAt?.toISOString(),
      source: "appointment",
    });
    if (out.length >= 3) break;
  }
  return out;
}

function dateDesc(x: Appointment, y: Appointment): number {
  return (y.startsAt?.getTime() ?? 0) - (x.startsAt?.getTime() ?? 0);
}

// ---- LLM parse (Claude forced tool-use) ----

type RawDraft = Pick<BookingDraft, "reason" | "specialty" | "providerHint" | "location" | "preferredTimes" | "acceptableWindow" | "urgency" | "patientName" | "assistantMessage" | "nextQuestion">;

async function llmParse(text: string, appointments: Appointment[], prior?: Partial<BookingDraft>): Promise<RawDraft> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const known = appointments
    .filter((a) => a.provider)
    .slice(0, 10)
    .map((a) => `- ${a.provider}${a.location ? ` (${a.location})` : ""}: ${a.title}`)
    .join("\n");
  const context = [
    prior && Object.keys(prior).length ? `Draft so far: ${JSON.stringify(prior)}` : "",
    known ? `The user's known providers from past visits:\n${known}` : "The user has no saved providers yet.",
    `User says: "${text}"`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const resp = await client.messages.create({
    model: config.webAgent.model || "claude-opus-4-8",
    max_tokens: 1024,
    system: SYSTEM,
    tools: [INTENT_TOOL],
    tool_choice: { type: "tool", name: "book_intent" },
    messages: [{ role: "user", content: context }],
  });
  for (const block of resp.content) {
    if (block.type === "tool_use" && block.name === "book_intent") return block.input as RawDraft;
  }
  return { assistantMessage: "Got it — tell me a bit more about the visit you need." };
}

// ---- Mock parse (no API key) — deterministic keyword heuristics so the flow runs in dev ----

function mockParse(text: string, prior?: Partial<BookingDraft>): RawDraft {
  const t = text.toLowerCase();
  const out: RawDraft = { ...(prior as RawDraft), assistantMessage: "Got it." };

  for (const [specialty, re] of Object.entries(SPECIALTY_KEYWORDS)) {
    if (re.test(t)) { out.specialty = specialty; break; }
  }
  if (/clean|checkup|check-up|routine/.test(t)) out.reason = out.reason ?? "routine checkup/cleaning";
  if (/\b(pain|ache|hurt|urgent|emergency|asap)\b/.test(t)) out.urgency = "urgent";
  if (/saturday|sunday|weekend/.test(t)) out.preferredTimes = "weekends";
  if (/morning/.test(t)) out.preferredTimes = [out.preferredTimes, "mornings"].filter(Boolean).join(", ");
  if (/evening|after work|after \d/.test(t)) out.preferredTimes = [out.preferredTimes, "evenings"].filter(Boolean).join(", ");
  const near = t.match(/near ([a-z\s]+)|in ([a-z\s]+)/);
  if (near) out.location = (near[1] || near[2] || "").trim();

  out.assistantMessage = out.specialty
    ? `Sure — let's book you ${aOrAn(out.specialty)} visit.`
    : "Happy to help you book a visit.";
  return out;
}

const aOrAn = (s: string) => `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`;
