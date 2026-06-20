// Shared contracts for the WhatsApp concierge subagents. The orchestrator (services/agent.ts) routes
// an inbound message to ONE specialist subagent, which either answers (read-only) or PROPOSES a
// state-changing action. Subagents never execute state changes themselves — the orchestrator owns the
// confirm-before-execute gate and re-checks consent at execution time.

import { resolveSubjectFor } from "../auth.js";

/** A member the operator can act on (self + active consent), as resolved by accessibleSubjects. */
export interface Member {
  id: string;
  name: string;
}

/** Everything a subagent needs to handle one inbound turn. */
export interface AgentContext {
  /** The WhatsApp-identified operator user. */
  operatorUserId: string;
  householdId: string;
  /** Members the operator can act on, for "book for Dad" resolution. members[0] is always self. */
  members: Member[];
  /** The latest inbound message text. */
  text: string;
  /** Prior conversation turns (oldest first), reconstructed from Message rows. */
  history: { role: "user" | "assistant"; content: string }[];
  /** Durable cross-session preferences/facts the agent remembers about this caregiver. */
  memory: string[];
  /** Compact, household-wide summary of in-flight + recently-resolved bookings (the office Klove is
   *  contacting or has booked), so the agent answers cross-flow questions consistently no matter which
   *  surface — app booking form, WhatsApp, or Ask Klove — started the booking. Empty string when none. */
  activity: string;
}

/**
 * A state-changing action a subagent proposes. The orchestrator restates it, stores it as the pending
 * action, and executes it only after the user confirms ("yes"). `execute` runs the real service call
 * and returns the user-facing result text; it MUST re-resolve consent itself (via resolveSubjectFor).
 */
export interface ProposedAction {
  /** Stable tool name, e.g. "book_appointment" — persisted so a resumed turn can re-dispatch. */
  tool: string;
  /** Validated args, persisted in AgentConversation.pendingAction. */
  args: Record<string, unknown>;
  /** Subject member this acts on (for the consent re-check + display). */
  subjectUserId: string;
  /** Human-readable confirmation prompt sent to the user. */
  restatement: string;
}

export type SubagentResult =
  | { kind: "reply"; text: string }
  | { kind: "propose"; action: ProposedAction };

export interface Subagent {
  name: "booking" | "healthqa" | "briefing";
  run(ctx: AgentContext): Promise<SubagentResult>;
}

/** The shared persona for every subagent's LLM prompt — a sharp, warm human concierge, not a bot. */
export const BASE_SYSTEM =
  "You are Klove, the family's personal health concierge — texting the caregiver on WhatsApp like a sharp, warm, " +
  "trusted human assistant they hired to run their family's health. Sound like a real person, never robotic or " +
  "templated.\n" +
  "How you work:\n" +
  "- Warm but efficient. This is a text thread — usually 1–3 sentences, no walls of text, no corporate filler.\n" +
  "- You already have their health context in front of you; USE it. Never re-ask for things you can see (their name, " +
  "their conditions, meds, upcoming visits) or things already said earlier in the conversation. Reference what you've " +
  "already discussed or done so it feels continuous.\n" +
  "- Be proactive: after you answer, anticipate the obvious next step and offer to take it (\"want me to book that?\", " +
  "\"I can add this to your questions for the visit\"). You're here to take work off their plate, not hand it back.\n" +
  "- Ground every health statement in the records provided. Never diagnose, never give medical or dosing advice — you " +
  "coordinate and inform, and you defer clinical judgment to their doctors. Do this naturally, not with stiff disclaimers.\n" +
  "- For anything that books, changes, or cancels something, propose it in one clear line and wait for a yes.\n" +
  "- If you're genuinely missing something you need, ask ONE concise question instead of guessing.";

// A reference to another person by relationship (not a name). If the text says "for my dad" and no
// household member matches, we should ask rather than silently acting as self / searching for "my dad".
const RELATION_RE = /\bfor (?:my )?(dad|mom|mum|mother|father|son|daughter|wife|husband|spouse|partner|kid|child|parent|brother|sister|grandm\w*|grandp\w*|aunt|uncle)\b/i;

/**
 * Best-effort: resolve which member a message refers to. Defaults to the operator (self). If the text
 * names another household member (e.g. "book Dad's cardiology"), match by display name. Returns
 * ambiguous=true (caller should ask) when the reference matches >1 member, or names a relative who
 * isn't in the household.
 */
export function resolveMemberFromText(text: string, members: Member[]): { member: Member | null; ambiguous: boolean } {
  const self = members[0] ?? null;
  const lower = text.toLowerCase();
  const named = members.filter((m) => {
    const n = m.name.trim().toLowerCase();
    return n.length >= 2 && n !== "member" && lower.includes(n);
  });
  if (named.length === 1) return { member: named[0], ambiguous: false };
  if (named.length > 1) return { member: null, ambiguous: true };
  // A "for my <relative>" reference that didn't match any member name → ask who it's for.
  if (RELATION_RE.test(text)) return { member: null, ambiguous: true };
  return { member: self, ambiguous: false };
}

/** Re-check consent for a subject before executing an action. Throws ConsentError when not permitted. */
export async function assertCanOperate(operatorUserId: string, subjectUserId: string): Promise<void> {
  await resolveSubjectFor(operatorUserId, subjectUserId, { need: "operate", category: "appointments" });
}
