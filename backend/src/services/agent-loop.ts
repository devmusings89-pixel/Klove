// The agentic brain: a multi-step tool loop. The model gathers via read tools (search, records, briefing),
// chaining as needed, then either replies or calls an ACT tool — which stops the loop and yields a
// ProposedAction the orchestrator confirms + executes. Cards gathered along the way render in the chat.
//
// Built on getModelTurn() (channels/llm.ts) — the same provider-neutral, tool-result-capable loop driver
// proven for web booking. Returns null when no LLM is configured, so callers fall back to the legacy
// single-subagent router and tests stay hermetic.

import { getModelTurn, type NeutralMsg } from "../channels/llm.js";
import { enabled } from "../config.js";
import { BASE_SYSTEM, type AgentContext, type ProposedAction } from "./agents/shared.js";
import { getTool, toolSpecs, type AgentCard } from "./agent-tools.js";

const MAX_STEPS = 6;

export interface AgentLoopResult {
  reply: string;
  cards: AgentCard[];
  proposal?: ProposedAction;
}

/** True when a tool-capable LLM is configured for the loop (mirrors the web agent's provider). */
export function agentLoopAvailable(): boolean {
  return enabled.web();
}

function buildSystem(ctx: AgentContext): string {
  const members = ctx.members.map((m, i) => `- ${m.name}${i === 0 ? " (the user — default subject)" : ""} [id:${m.id}]`).join("\n");
  const memory = ctx.memory.length ? `\n\nWhat you remember about them:\n${ctx.memory.map((m) => `- ${m}`).join("\n")}` : "";
  const activity = ctx.activity ? `\n\nIn-flight / recent bookings:\n${ctx.activity}` : "";
  return (
    BASE_SYSTEM +
    "\n\nYou are in the Klove APP (not WhatsApp) and you have TOOLS. Work like an agent:\n" +
    "- Use read tools (search_physicians, physician_details, health_lookup, get_briefing) to gather what you need — chain them as required, don't ask the user for things a tool can find.\n" +
    "- When you surface specialists, the user already SEES them as cards. Lead with a confident, warm recommendation of the single best SPECIFIC doctor for their need and offer to book — 2–3 sentences, like a friend who knows a great doctor.\n" +
    "- Results are tagged [DOCTOR] (a named individual you can book) or [practice] FOR YOUR REASONING ONLY. NEVER mention these tags, never say 'these are practices not individuals', never explain your search or the data — it sounds robotic. Just name the doctor you'd pick. Prefer a [DOCTOR]; book a [practice] only if the user says to let the office assign one.\n" +
    "- To book, remind, or save anything, call the matching ACT tool (book_appointment, set_reminder, save_insurance, update_profile, save_provider). This does NOT execute — it shows a confirmation card the user taps to approve. Only call it once you have the specifics (e.g. a chosen provider with a name).\n" +
    "- TIMING: never invent a day or time (no 'a weekend', no 'next Tuesday' unless they said it). If you know the member's scheduling preference (see what you remember below), use it and say so. Otherwise ASK which times work for them before proposing the booking — one short question.\n" +
    "- Never invent providers, ratings, records, or appointment times — use only what tools return or what the user told you.\n" +
    "- To stop/cancel/abandon a booking (or 'close it out', 'stop the retries'), call cancel_booking. NEVER claim you booked, cancelled, closed, saved, or changed anything unless the matching act tool ran and was confirmed — if you can't do it with a tool, say so plainly. Your words must match what actually happened.\n\n" +
    `Family members you can act for:\n${members}${memory}${activity}`
  );
}

export async function runAgentLoop(ctx: AgentContext): Promise<AgentLoopResult | null> {
  if (!agentLoopAvailable()) return null;
  const { turn } = getModelTurn();
  const system = buildSystem(ctx);
  const tools = toolSpecs();
  const history: NeutralMsg[] = [
    ...ctx.history.map((h): NeutralMsg => (h.role === "assistant" ? { role: "assistant", content: h.content, toolCalls: [] } : { role: "user", content: h.content })),
    { role: "user", content: ctx.text },
  ];
  const cards: AgentCard[] = [];
  let lastText = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    let text: string;
    let toolCalls;
    try {
      ({ text, toolCalls } = await turn(system, history, tools));
    } catch (err) {
      console.error("agent loop turn failed:", (err as Error).message);
      return cards.length || lastText ? { reply: lastText || "Here's what I found.", cards } : null;
    }
    lastText = text || lastText;
    history.push({ role: "assistant", content: text, toolCalls });

    if (toolCalls.length === 0) return { reply: text || "How can I help?", cards };

    for (const tc of toolCalls) {
      const tool = getTool(tc.name);
      if (!tool) {
        history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: `Unknown tool: ${tc.name}.` });
        continue;
      }
      if (tool.kind === "act") {
        // Act tools stop the loop and yield a proposal for the confirm gate — they never execute here.
        const { action, card } = await tool.build(ctx, tc.args);
        if (card) cards.push(card);
        return { reply: (text || action.restatement).trim(), cards, proposal: action };
      }
      try {
        const { summary, card } = await tool.run(ctx, tc.args);
        if (card) cards.push(card);
        history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: summary });
      } catch (err) {
        history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: `Tool error: ${(err as Error).message}` });
      }
    }
  }
  return { reply: lastText || "Here's what I found.", cards };
}
