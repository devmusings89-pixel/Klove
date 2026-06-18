// Health Q&A specialist. Answers the caregiver's informational questions grounded in the family
// health graph — same posture as services/triage.ts and routes/ask.ts: concise, specific, never
// diagnostic. Read-only: it never proposes a state change. Falls back to a deterministic reply when
// no LLM is configured.

import { prisma } from "../../db.js";
import { runText, llmAvailable } from "../llm-tool.js";
import { buildSummary } from "../graph.js";
import { BASE_SYSTEM, type AgentContext, type Member, type Subagent, type SubagentResult } from "./shared.js";

export const healthQaAgent: Subagent = {
  name: "healthqa",
  async run(ctx: AgentContext): Promise<SubagentResult> {
    if (!llmAvailable()) {
      const names = ctx.members.map((m) => m.name).join(", ") || "your family";
      return {
        kind: "reply",
        text: `I'm tracking health records for ${names}. Ask me about a specific person, condition, lab, or what's due and I'll pull it up.`,
      };
    }

    // Ground the answer in each accessible member's conditions, meds, AND recent lab/vital results
    // (cap members + rows to keep the prompt tight). Without the results the agent wrongly claims it
    // has no lab data for questions like "how's my blood sugar / cholesterol".
    const context = (await Promise.all(ctx.members.slice(0, 4).map(memberContext))).join("\n");
    const prefs = ctx.memory.length ? `\n\nRemembered about them: ${ctx.memory.join("; ")}` : "";

    let answer: string | null = null;
    try {
      answer = await runText({
        system:
          `${BASE_SYSTEM}\nAnswer the caregiver's question using ONLY the records below. When they ask about a lab or vital, ` +
          `state the most recent value, whether it's flagged out of range, and the direction of any trend across the dates shown. ` +
          `Keep it to a couple of sentences. If the records genuinely don't contain it, say so plainly.`,
        content: `Records:\n${context}\n\nConversation so far:\n${formatHistory(ctx.history)}${prefs}\n\nQuestion: ${ctx.text}`,
        maxTokens: 500,
      });
    } catch (err) {
      console.error("healthqa LLM failed:", (err as Error).message);
    }
    return {
      kind: "reply",
      text: (answer ?? "").trim() || "I don't have enough on file to answer that yet.",
    };
  },
};

/** A compact, grounded context for a member: conditions, meds, recent results, and upcoming visits —
 *  enough for the agent to answer AND proactively tie an answer to the next appointment. */
async function memberContext(m: Member): Promise<string> {
  const [summary, obs, appts] = await Promise.all([
    buildSummary(m.id),
    prisma.observation.findMany({
      where: { userId: m.id },
      orderBy: { effectiveAt: "desc" },
      take: 14,
      select: { display: true, valueNum: true, valueString: true, unit: true, abnormalFlag: true, effectiveAt: true },
    }),
    prisma.appointment.findMany({
      where: { userId: m.id, status: "scheduled", startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      take: 3,
      select: { title: true, provider: true, startsAt: true },
    }),
  ]);
  const results = obs.map((o) => {
    const val = o.valueNum != null ? `${o.valueNum}${o.unit ? ` ${o.unit}` : ""}` : o.valueString ?? "";
    const flag = o.abnormalFlag && o.abnormalFlag !== "N" ? ` [${o.abnormalFlag}]` : "";
    const date = o.effectiveAt ? ` (${o.effectiveAt.toISOString().slice(0, 10)})` : "";
    return `${o.display} ${val}${flag}${date}`.trim();
  });
  // Format dates in local time (matching the briefing) so the agent never quotes an off-by-one
  // UTC date for an evening appointment.
  const visits = appts.map((a) => {
    const when = a.startsAt ? ` on ${a.startsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : "";
    return `${a.title}${a.provider ? ` w/ ${a.provider}` : ""}${when}`;
  });
  return (
    `${m.name}: conditions=[${summary.activeConditions.join(", ") || "none"}]; ` +
    `meds=[${summary.activeMedications.join(", ") || "none"}]; ` +
    `recent results: ${results.join("; ") || "none on file"}; ` +
    `upcoming visits: ${visits.join("; ") || "none scheduled"}`
  );
}

function formatHistory(history: { role: "user" | "assistant"; content: string }[]): string {
  if (!history.length) return "(none)";
  return history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Caregiver" : "Klove"}: ${m.content}`)
    .join("\n");
}
