// Cross-session memory for the concierge agent. A human assistant remembers your standing
// preferences ("I like mornings", "use my Aetna", "always Dr. Lee") without being told to. We do the
// same: after each turn we extract durable preferences/facts from the user's message and persist them
// on the per-user AgentConversation row, then load them into context on every future turn.

import { prisma } from "../db.js";
import { runTool } from "./llm-tool.js";
import { fromJson, toJson } from "./json.js";

interface MemoryItem {
  text: string;
  createdAt: string;
}

const MAX_ITEMS = 25;

/** The caregiver's remembered standing preferences/facts (most recent last). */
export async function loadMemory(userId: string): Promise<string[]> {
  const convo = await prisma.agentConversation.findUnique({ where: { userId }, select: { memoryJson: true } });
  return fromJson<MemoryItem[]>(convo?.memoryJson ?? null, []).map((i) => i.text);
}

const MEMORY_TOOL = {
  name: "save_preferences",
  description:
    "Record any DURABLE personal preferences or stable facts the user just stated that a concierge should remember " +
    "across FUTURE conversations.",
  input_schema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: { type: "string" },
        description:
          "Short standalone facts to remember, e.g. 'Prefers morning appointments', 'Uses Aetna insurance', " +
          "'Preferred pharmacy: CVS on Main St', 'Avoid Fridays', 'Address them as Jordan'. Return an EMPTY list if the " +
          "message has no durable preference — do not save one-off requests, questions, greetings, or clinical/medical values.",
      },
    },
    required: ["facts"],
  } as Record<string, unknown>,
};

/**
 * Extract durable preferences from one user message and merge them into the user's memory. No-op when
 * no LLM is configured or nothing durable was said. Safe to call fire-and-forget.
 */
export async function rememberFromTurn(userId: string, householdId: string, userText: string, existing: string[]): Promise<void> {
  const extracted = await runTool<{ facts?: string[] }>({
    system:
      "You maintain a family health concierge's long-term memory about a caregiver. From the user's message, extract " +
      "ONLY durable preferences or stable facts worth remembering across future conversations: scheduling preferences, " +
      "preferred providers/offices/pharmacies, insurance choices, how they want to be addressed, standing constraints. " +
      "Do NOT save one-off requests, questions, greetings, or clinical/medical values. Empty list if nothing durable.\n" +
      `Already known (do not duplicate): ${existing.join("; ") || "none"}`,
    content: userText,
    tool: MEMORY_TOOL,
    maxTokens: 200,
  }).catch(() => null);

  const facts = (extracted?.facts ?? []).map((f) => f.trim()).filter(Boolean);
  if (!facts.length) return;

  const lowerExisting = new Set(existing.map((e) => e.toLowerCase()));
  const fresh = facts.filter((f) => !lowerExisting.has(f.toLowerCase()));
  if (!fresh.length) return;

  const convo = await prisma.agentConversation.findUnique({ where: { userId }, select: { memoryJson: true } });
  const items = fromJson<MemoryItem[]>(convo?.memoryJson ?? null, []);
  const now = new Date().toISOString();
  for (const f of fresh) items.push({ text: f, createdAt: now });
  const trimmed = items.slice(-MAX_ITEMS);
  await prisma.agentConversation.upsert({
    where: { userId },
    create: { userId, householdId, memoryJson: toJson(trimmed) },
    update: { memoryJson: toJson(trimmed) },
  });
}
