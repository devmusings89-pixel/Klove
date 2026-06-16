// Appointment preparation (Klove hero flow). Assembles a one-page brief from the member's graph
// and drafts personalized questions to bring to the visit. Conservative and non-diagnostic: the
// questions are discussion prompts the operator edits, never medical advice.

import Anthropic from "@anthropic-ai/sdk";
import { runTool, llmAvailable } from "./llm-tool.js";
import { prisma } from "../db.js";
import { buildSummary, buildTimeline, type GraphSummary, type TimelineEntry } from "./graph.js";

export interface AppointmentBrief {
  appointment: { id: string | null; title: string; provider: string | null; startsAt: string | null } | null;
  summary: GraphSummary;
  recentEvents: TimelineEntry[];
  questions: string[];
}

const QUESTIONS_TOOL: Anthropic.Tool = {
  name: "suggest_questions",
  description:
    "Suggest concise, personalized questions the patient (or their caregiver) should consider asking at an " +
    "upcoming appointment, grounded in their records. Discussion prompts only — never diagnose or advise treatment.",
  input_schema: {
    type: "object",
    properties: { questions: { type: "array", items: { type: "string" } } },
    required: ["questions"],
  },
};

/** Deterministic fallback questions (mock mode / no LLM) grounded in the member's records. */
function fallbackQuestions(summary: GraphSummary, providerTitle: string): string[] {
  const qs: string[] = [];
  for (const c of summary.activeConditions.slice(0, 3)) {
    qs.push(`How is my ${c.toLowerCase()} trending, and should we adjust anything?`);
  }
  if (summary.activeMedications.length) {
    qs.push(`Are my current medications (${summary.activeMedications.slice(0, 3).join(", ")}) still the right ones?`);
  }
  qs.push(`Given my recent results, is any follow-up or screening due before ${providerTitle || "my next visit"}?`);
  qs.push("Is there anything in my history we should keep a closer eye on?");
  return qs.slice(0, 5);
}

async function llmQuestions(summary: GraphSummary, apptTitle: string): Promise<string[]> {
  const ctx = [
    `Upcoming appointment: ${apptTitle}`,
    `Active conditions: ${summary.activeConditions.join(", ") || "none recorded"}`,
    `Active medications: ${summary.activeMedications.join(", ") || "none recorded"}`,
    `Record counts: ${JSON.stringify(summary.counts)}`,
  ].join("\n");

  const out = await runTool<{ questions?: string[] }>({
    system:
      "You help a caregiver prepare for a medical appointment. Suggest grounded, specific questions to ask. " +
      "Be conservative; never diagnose or recommend treatment. Output 4-6 short questions.",
    content: `Patient context:\n\n${ctx}\n\nSuggest questions to bring to this visit.`,
    tool: { name: QUESTIONS_TOOL.name, description: QUESTIONS_TOOL.description ?? "", input_schema: QUESTIONS_TOOL.input_schema as Record<string, unknown> },
    maxTokens: 1000,
  });
  return (out?.questions ?? []).slice(0, 6);
}

/** Assemble the one-page brief for a member's appointment (or a general brief if none given). */
export async function buildBrief(userId: string, appointmentId?: string): Promise<AppointmentBrief> {
  const appointment = appointmentId
    ? await prisma.appointment.findFirst({ where: { id: appointmentId, userId } })
    : null;

  const [summary, timeline] = await Promise.all([buildSummary(userId), buildTimeline(userId)]);
  const apptTitle = appointment?.title ?? "your upcoming visit";

  // Reuse already-edited questions if present; otherwise generate.
  let questions: string[] = [];
  const saved = appointment?.notes ? safeParseQuestions(appointment.notes) : null;
  if (saved && saved.length) {
    questions = saved;
  } else if (llmAvailable()) {
    try {
      questions = await llmQuestions(summary, apptTitle);
    } catch {
      questions = [];
    }
  }
  if (!questions.length) questions = fallbackQuestions(summary, appointment?.provider ?? "");

  return {
    appointment: appointment
      ? { id: appointment.id, title: appointment.title, provider: appointment.provider, startsAt: iso(appointment.startsAt) }
      : null,
    summary,
    recentEvents: timeline.slice(0, 5),
    questions,
  };
}

/** Persist operator-edited questions onto the appointment (stored in notes as JSON). */
export async function saveQuestions(userId: string, appointmentId: string, questions: string[]): Promise<void> {
  await prisma.appointment.updateMany({
    where: { id: appointmentId, userId },
    data: { notes: JSON.stringify({ questions }) },
  });
}

function safeParseQuestions(notes: string): string[] | null {
  try {
    const parsed = JSON.parse(notes) as { questions?: string[] };
    return Array.isArray(parsed.questions) ? parsed.questions : null;
  } catch {
    return null;
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
