// Booking specialist. Turns a chat request ("book a dermatologist", "book Dad's cardiology follow-up")
// into a PROPOSED book_appointment action, and turns a reply to a "choose a time" prompt into a
// PROPOSED choose_appointment_time action. It never executes — it returns a proposal the orchestrator
// confirms and runs. Uses the LLM to extract structured args when available, with a keyword fallback.

import { prisma } from "../../db.js";
import { runTool } from "../llm-tool.js";
import { fromJson } from "../json.js";
import { searchOffices } from "../lookup.js";
import { BASE_SYSTEM, resolveMemberFromText, type AgentContext, type Subagent, type SubagentResult } from "./shared.js";

const BOOK_TOOL = {
  name: "book_appointment",
  description:
    "Propose booking a medical appointment on the member's behalf. Pull apart what the user said into " +
    "distinct fields — do NOT put the whole sentence in `reason`.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "The visit type or specialty ONLY, as a short noun phrase — e.g. 'dermatologist', 'annual physical', " +
          "'cardiology follow-up', 'dental cleaning'. Strip verbs and timing: 'I need to see a cardiologist next week' → 'cardiologist'.",
      },
      provider: { type: "string", description: "A specific office or doctor name if the user named one (e.g. 'Dr. Lee', 'ABC Dermatology'); omit otherwise." },
      preferred_times: { type: "string", description: "Any timing the user mentioned, e.g. 'next week', 'weekday mornings', 'after 3pm'; omit if none." },
    },
    required: ["reason"],
  } as Record<string, unknown>,
};

interface BookArgs {
  reason?: string;
  provider?: string;
  preferred_times?: string;
}

/** Does this message look like a reply picking one of an offered set of slots? */
function pickMatch(text: string, options: string[]): string | null {
  const lower = text.toLowerCase().trim();
  // Exact-ish: an option whose text is contained in the message (or vice versa).
  for (const opt of options) {
    const o = opt.toLowerCase();
    if (lower.includes(o) || o.includes(lower)) return opt;
  }
  // Ordinal: "the first one", "option 2", "#3".
  const ord = /\b(?:option\s*|#)?(\d+)\b/.exec(lower) ?? /\b(first|second|third|fourth|fifth)\b/.exec(lower);
  if (ord) {
    const words = ["first", "second", "third", "fourth", "fifth"];
    const idx = /^\d+$/.test(ord[1]) ? Number(ord[1]) - 1 : words.indexOf(ord[1]);
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  return null;
}

export const bookingAgent: Subagent = {
  name: "booking",
  async run(ctx: AgentContext): Promise<SubagentResult> {
    const { member, ambiguous } = resolveMemberFromText(ctx.text, ctx.members);
    if (ambiguous || !member) {
      const names = ctx.members.map((m) => m.name).join(", ");
      return {
        kind: "reply",
        text: `Who's this for? I can only book for people set up in your household: ${names}. (To add someone, set them up in the Klove app first.)`,
      };
    }

    // First: is the user replying to an open "choose a time" task for this member?
    const choosing = await prisma.task.findFirst({
      where: { subjectUserId: member.id, state: "needs_you", kind: "choose_time", conciergeJobId: { not: null } },
      orderBy: { updatedAt: "desc" },
    });
    if (choosing) {
      const options = fromJson<string[]>(choosing.options, []);
      const picked = pickMatch(ctx.text, options);
      if (picked) {
        return {
          kind: "propose",
          action: {
            tool: "choose_appointment_time",
            args: { taskId: choosing.id, slot: picked },
            subjectUserId: member.id,
            restatement: `Lock in ${picked} for ${choosing.title.replace(/^Pick a time:\s*/, "")}? Reply YES to confirm.`,
          },
        };
      }
      if (options.length) {
        return {
          kind: "reply",
          text: `For "${choosing.title.replace(/^Pick a time:\s*/, "")}", these times are available:\n${options
            .map((o, i) => `${i + 1}. ${o}`)
            .join("\n")}\nReply with the one you want.`,
        };
      }
    }

    // Otherwise: extract a new booking request. Use a FORCED tool call so the model always returns
    // clean structured fields (reason/provider/preferred_times) — avoids the fragile regex fallback
    // mangling idioms like "get me in with an endocrinologist". Recent history is included so a
    // modify-the-request follow-up ("actually make it mornings") still resolves the specialty.
    const recent = ctx.history.slice(-4).map((m) => `${m.role === "user" ? "User" : "Klove"}: ${m.content}`).join("\n");
    const prefs = ctx.memory.length
      ? `\n\nStanding preferences to apply if the user didn't override them (e.g. fill preferred_times from a known time preference, use a preferred office as provider): ${ctx.memory.join("; ")}`
      : "";
    const args =
      (await runTool<BookArgs>({
        system: `${BASE_SYSTEM}\nExtract the booking details from the user's LATEST request into the tool fields. If the user didn't specify timing but a standing preference covers it, set preferred_times from that preference.`,
        content: `${recent ? `Recent conversation:\n${recent}\n\n` : ""}Latest request: ${ctx.text}${prefs}`,
        tool: BOOK_TOOL,
        maxTokens: 300,
      }).catch(() => null)) ?? {};
    // Normalize as a backstop (strips lead-ins/verbs/articles) for the no-LLM path or a stray echo.
    const reason = stripBookingVerb((args.reason ?? "").trim() || ctx.text) || stripBookingVerb(ctx.text);
    if (!reason) return { kind: "reply", text: "What would you like to book? (e.g. 'a dermatologist', 'a dental cleaning')" };

    const provider = args.provider?.trim();
    const preferred = args.preferred_times?.trim();

    // Look up the actual doctor/office BEFORE proposing, so we confirm a real place Klove can reach
    // and then book it live — never a fabricated hold. Search by the named provider if given, else by
    // specialty + the member's location.
    const location = await memberLocation(member.id, ctx.operatorUserId);
    const base = provider || reason;
    const query = location ? `${base} near ${location}` : base;
    const matches = await searchOffices(query);
    if (!matches.length) {
      return {
        kind: "reply",
        text: `I couldn't find an office for "${base}". What's the office name, or a city/area to search near?`,
      };
    }

    const top = matches[0];
    const forWhom = member.id === ctx.members[0]?.id ? "you" : member.name;
    const where = [top.displayName, top.address].filter(Boolean).join(" — ");
    const alt = matches.length > 1 ? " (not it? name the office and I'll use that)" : "";
    return {
      kind: "propose",
      action: {
        tool: "book_appointment",
        args: {
          reason,
          provider: top.displayName,
          phone: top.phone ?? undefined,
          website: top.website ?? undefined,
          preferredTimes: preferred || undefined,
        },
        subjectUserId: member.id,
        restatement: `I found ${where}${top.phone ? `, ${top.phone}` : ""}. Book ${reason} there for ${forWhom}${preferred ? ` (${preferred})` : ""}? Reply YES to confirm.${alt}`,
      },
    };
  },
};

/** The member's saved address (falls back to the operator's) to bias an office search by location. */
async function memberLocation(memberId: string, operatorId: string): Promise<string | null> {
  const m = await prisma.profile.findFirst({ where: { userId: memberId }, orderBy: { isPrimary: "desc" }, select: { address: true } });
  if (m?.address?.trim()) return m.address.trim();
  if (operatorId !== memberId) {
    const o = await prisma.profile.findFirst({ where: { userId: operatorId }, orderBy: { isPrimary: "desc" }, select: { address: true } });
    if (o?.address?.trim()) return o.address.trim();
  }
  return null;
}

// Strip leading filler / booking lead-ins / articles so a bare specialty remains. Applied greedily to
// both LLM output and the raw message: "ok book me an endocrinologist" → "endocrinologist".
const LEAD_INS: RegExp[] = [
  /^(ok(ay)?|hey|hi|so|well|yeah|yep|sure|alright|right|please|thanks?)\b[\s,]*/i,
  /^(can|could|would|will)\s+you\s+/i,
  /^i\s+(?:would\s+like|'?d\s+like|want|need|wanna)\s+to\s+/i,
  /^i\s+(?:want|need)\s+/i,
  /^let'?s\s+/i,
  /^(book|schedule|set\s*up|make|get|find|see)\s+/i,
  /^me\s+/i,
  /^(?:in|up)\s+(?:with|to\s+see)\s+/i, // "...get me IN WITH an endocrinologist", "set me UP WITH a derm"
  /^(an?|the|my)\s+/i,
  /^(?:appointment|visit|booking)\s+(?:with|for|at|to\s+see)\s+/i,
  /^(?:appointment|visit|booking)\s+/i,
  /^(?:with|to\s+see)\s+/i,
];

function stripBookingVerb(text: string): string {
  let s = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEAD_INS) {
      const next = s.replace(re, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}
