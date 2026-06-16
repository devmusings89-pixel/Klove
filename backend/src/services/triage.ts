// "Ask Klove" triage (Klove). Routes an operator's free-text request: most are answered by AI
// grounded in the family health graph; the rest (a real call, coverage check, bulk import) escalate
// to the human concierge. ~70/30 AI/human, gated by consent. Mock mode answers deterministically.

import { runText, llmAvailable } from "./llm-tool.js";
import { buildSummary } from "./graph.js";

export interface AskResult {
  kind: "answer" | "escalated";
  answer: string;
  routedTo: "ai" | "concierge";
}

const ESCALATION_HINTS = ["call", "book", "schedule", "refill", "coverage", "insurance", "appointment", "fax", "records request"];

/** Heuristic: does this request need a human/agent action rather than just an answer? */
function looksActionable(text: string): boolean {
  const t = text.toLowerCase();
  return ESCALATION_HINTS.some((h) => t.includes(h));
}

interface MemberCtx {
  id: string;
  name: string;
}

/** Answer or escalate an operator request over the household they can access. */
export async function triageAsk(text: string, members: MemberCtx[]): Promise<AskResult> {
  const actionable = looksActionable(text);

  if (actionable) {
    return {
      kind: "escalated",
      routedTo: "concierge",
      answer:
        "I'll take it from here — I've routed this to your concierge to handle the call/scheduling and " +
        "will update you in Actions as it progresses.",
    };
  }

  // Informational: ground an answer in the members' summaries.
  if (!llmAvailable()) {
    const names = members.map((m) => m.name).join(", ") || "your family";
    return {
      kind: "answer",
      routedTo: "ai",
      answer: `Here's what I'm tracking for ${names}. Ask me about a specific person, condition, or what's due, and I'll pull it up.`,
    };
  }

  const summaries = await Promise.all(
    members.slice(0, 6).map(async (m) => ({ name: m.name, summary: await buildSummary(m.id) })),
  );
  const ctx = summaries
    .map((s) => `${s.name}: conditions=[${s.summary.activeConditions.join(", ")}] meds=[${s.summary.activeMedications.join(", ")}]`)
    .join("\n");

  let answer: string | null = null;
  try {
    answer = await runText({
      system:
        "You are Klove, a calm, competent health Chief of Staff. Answer the caregiver's question grounded ONLY in " +
        "the family context provided. Be concise and specific. Never diagnose or give medical advice — coordinate and " +
        "inform. If you don't have the data, say so plainly.",
      content: `Family context:\n${ctx}\n\nQuestion: ${text}`,
      maxTokens: 600,
    });
  } catch (err) {
    console.error("ask LLM failed:", (err as Error).message);
  }
  return { kind: "answer", routedTo: "ai", answer: (answer ?? "").trim() || "I don't have enough on file to answer that yet." };
}
