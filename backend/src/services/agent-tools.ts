// The agent's tools — thin wrappers over EXISTING services. Read tools run inside the loop and feed a
// summary (+ optional UI card) back to the model; act tools never run in the loop — the model calling one
// STOPS the loop and yields a ProposedAction the orchestrator confirms + executes (services/agent.ts).
//
// Cards are the structured payloads the iOS chat renders inline (physician lists, a booking recap, etc.),
// so Ask Klove SHOWS results instead of only describing them.

import type { LlmTool } from "../channels/llm.js";
import type { AgentContext, Member, ProposedAction } from "./agents/shared.js";
import { searchPhysicians, type PhysicianResult } from "./physician-search.js";
import { physicianDetails } from "./physician-detail.js";
import { healthQaAgent } from "./agents/healthqa.js";
import { briefingAgent } from "./agents/briefing.js";

// ---- Cards (mirrored on iOS) ----

export interface BookingRecap {
  reason: string;
  provider?: string;
  memberName: string;
  phone?: string;
  website?: string;
  preferredTimes?: string;
  insurance?: string;
}

export type AgentCard =
  | { type: "physician_list"; resolvedSpecialty: string | null; memberInsurance: string[]; results: PhysicianResult[] }
  | { type: "booking_recap"; recap: BookingRecap }
  | { type: "booking_status"; sessionId: string; provider?: string; reason?: string }
  | { type: "prep_list"; title: string; questions: string[] }
  | { type: "text"; text: string };

export interface ReadResult {
  summary: string; // what the model sees as the tool result
  card?: AgentCard; // what the client renders
}

interface ReadTool {
  kind: "read";
  spec: LlmTool;
  run(ctx: AgentContext, args: Record<string, unknown>): Promise<ReadResult>;
}
interface ActTool {
  kind: "act";
  spec: LlmTool;
  build(ctx: AgentContext, args: Record<string, unknown>): Promise<{ action: ProposedAction; card?: AgentCard }>;
}
export type AgentTool = ReadTool | ActTool;

const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

/** Resolve which member an arg refers to by name; defaults to the operator (members[0] = self). */
function resolveSubject(ctx: AgentContext, memberName?: string): Member {
  const self = ctx.members[0];
  const name = memberName?.trim().toLowerCase();
  if (name) {
    const m = ctx.members.find((x) => x.name.trim().toLowerCase().includes(name) || name.includes(x.name.trim().toLowerCase()));
    if (m) return m;
  }
  return self;
}

// ---- Read tools ----

const searchPhysiciansTool: ReadTool = {
  kind: "read",
  spec: {
    name: "search_physicians",
    description:
      "Find and rank the best specialists for a medical condition near a location, with Google ratings and " +
      "in-network status against the member's insurance. Use whenever the user wants to find, compare, or pick a doctor/specialist.",
    parameters: {
      type: "object",
      properties: {
        condition: { type: "string", description: "The condition, symptom, or specialty in the user's words (e.g. 'migraine', 'botox for migraines', 'dermatologist')." },
        location: { type: "string", description: "City/area or ZIP to search near (e.g. 'Seattle, WA'). Omit if the user didn't give one." },
        radius_miles: { type: "number", description: "Search radius in miles (default 20). Only meaningful with a location." },
        member: { type: "string", description: "Family member's name to search for; omit for the user themselves." },
      },
      required: ["condition"],
    },
  },
  async run(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const out = await searchPhysicians({
      householdId: ctx.householdId,
      subjectUserId: subject.id,
      condition: String(args.condition ?? "").trim(),
      location: str(args.location),
      radiusMiles: typeof args.radius_miles === "number" ? args.radius_miles : undefined,
      limit: 8,
    });
    const card: AgentCard = {
      type: "physician_list",
      resolvedSpecialty: out.resolvedSpecialty,
      memberInsurance: out.memberInsurance,
      results: out.results,
    };
    const lines = out.results
      .slice(0, 6)
      .map((r, i) => {
        const rating = r.rating != null ? `${r.rating}★(${r.reviewCount ?? 0})` : "no rating";
        const dist = r.distanceMiles != null ? `, ${r.distanceMiles}mi` : "";
        // Individuals (NPI / a credential like MD/DO) are bookable doctors; the rest are practices/clinics.
        const kind = r.npi || r.credential ? "DOCTOR" : "practice";
        return `${i + 1}. [${kind}] ${r.name} — ${r.taxonomyDesc ?? r.specialty}; ${rating}${dist}; ${r.networkStatus}; phone:${r.phone ?? "n/a"}; website:${r.website ?? "n/a"}`;
      })
      .join("\n");
    const summary =
      `Specialty: ${out.resolvedSpecialty ?? "unclear"}${out.resolvedSubspecialty ? ` / ${out.resolvedSubspecialty}` : ""}. ` +
      `Member insurance on file: ${out.memberInsurance.join(", ") || "none"}.\n` +
      (out.results.length ? `Candidates (shown to the user as cards):\n${lines}` : "No specialists found.") +
      `\nPick the best [DOCTOR] and recommend that one by name. The [DOCTOR]/[practice] tags are for YOUR reasoning only — do NOT tell the user about them or say results are "practices vs individuals"; just recommend a specific doctor naturally.` +
      `\nWhen you call book_appointment, pass BOTH phone and website when shown — the office's online booking form is the preferred channel, so never drop the website.`;
    return { summary, card };
  },
};

const physicianDetailsTool: ReadTool = {
  kind: "read",
  spec: {
    name: "physician_details",
    description: "Get a specific provider's patient reviews and the insurance they accept (scraped from their website). Use to dig into one option.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Provider/clinic name." },
        address: { type: "string", description: "Their address, if known." },
        website: { type: "string", description: "Their website, if known." },
        member: { type: "string", description: "Family member name; omit for the user." },
      },
      required: ["name"],
    },
  },
  async run(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const d = await physicianDetails({ subjectUserId: subject.id, name: String(args.name ?? ""), address: str(args.address), website: str(args.website) });
    const summary =
      `Network: ${d.networkStatus} (member: ${d.memberInsurance.join(", ") || "none"}). ` +
      `Accepted carriers: ${d.acceptedCarriers.join(", ") || "not listed"}. ${d.insuranceNote ?? ""}\n` +
      (d.reviews.length ? `Reviews: ${d.reviews.slice(0, 3).map((r: string) => `"${r.slice(0, 160)}"`).join(" | ")}` : "No reviews found.");
    return { summary };
  },
};

const healthLookupTool: ReadTool = {
  kind: "read",
  spec: {
    name: "health_lookup",
    description: "Answer a question grounded in the family's health records (conditions, medications, lab results, trends, upcoming visits). Read-only.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The health question to answer from records." } },
      required: ["question"],
    },
  },
  async run(ctx, args) {
    const res = await healthQaAgent.run({ ...ctx, text: String(args.question ?? ctx.text) });
    return { summary: res.kind === "reply" ? res.text : "No records-based answer available." };
  },
};

const briefingTool: ReadTool = {
  kind: "read",
  spec: {
    name: "get_briefing",
    description: "Get the caregiver's current to-do summary (what needs them, what's upcoming/waiting) or questions to prep for an upcoming visit.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "What they want, e.g. 'what's due', 'prep questions for Dad's cardiology'." } },
      required: ["request"],
    },
  },
  async run(ctx, args) {
    const res = await briefingAgent.run({ ...ctx, text: String(args.request ?? ctx.text) });
    return { summary: res.kind === "reply" ? res.text : "Nothing to brief right now." };
  },
};

// ---- Act tools (propose → confirm → execute) ----

const bookAppointmentTool: ActTool = {
  kind: "act",
  spec: {
    name: "book_appointment",
    description:
      "Propose booking a medical appointment. Call this ONLY after you and the user have settled on a specific provider " +
      "(name + ideally phone). The user will confirm before anything is booked.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Visit type/specialty as a short noun phrase (e.g. 'dermatologist', 'migraine consult')." },
        provider: { type: "string", description: "The chosen provider — prefer a SPECIFIC physician's name (e.g. 'Dr. James Petrin'), not just a clinic, unless the user agreed to let a practice assign one." },
        phone: { type: "string", description: "Office phone, if known." },
        website: { type: "string", description: "Office booking website, if known." },
        preferred_times: { type: "string", description: "Timing the USER stated or their remembered preference (e.g. 'weekday mornings'). Do NOT invent one — if you don't know their availability, ask first and omit this." },
        insurance: { type: "string", description: "Insurance carrier/plan to use, if the user specified." },
        specialty: { type: "string", description: "Normalized specialty if known." },
        member: { type: "string", description: "Family member name; omit for the user." },
      },
      required: ["reason"],
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const reason = String(args.reason ?? "appointment");
    const provider = str(args.provider);
    const card: AgentCard = {
      type: "booking_recap",
      recap: {
        reason,
        provider,
        memberName: subject.name,
        phone: str(args.phone),
        website: str(args.website),
        preferredTimes: str(args.preferred_times),
        insurance: str(args.insurance),
      },
    };
    return {
      action: {
        tool: "book_appointment",
        args: {
          reason,
          provider,
          phone: str(args.phone),
          website: str(args.website),
          preferredTimes: str(args.preferred_times),
          insurance: str(args.insurance),
          specialty: str(args.specialty),
        },
        subjectUserId: subject.id,
        restatement: `Book ${reason}${provider ? ` with ${provider}` : ""} for ${subject.name}?`,
      },
      card,
    };
  },
};

const setReminderTool: ActTool = {
  kind: "act",
  spec: {
    name: "set_reminder",
    description: "Propose creating a reminder/to-do for the caregiver (e.g. 'remind me to refill Dad's metformin Friday').",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What to be reminded about." },
        when: { type: "string", description: "When, in the user's words (e.g. 'Friday', 'next week')." },
        member: { type: "string", description: "Family member this concerns; omit for the user." },
      },
      required: ["title"],
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const title = String(args.title ?? "Reminder");
    const when = str(args.when);
    return {
      action: {
        tool: "set_reminder",
        args: { title, when },
        subjectUserId: subject.id,
        restatement: `Add a reminder${when ? ` for ${when}` : ""}: "${title}"${subject.id !== ctx.members[0]?.id ? ` (${subject.name})` : ""}?`,
      },
    };
  },
};

const saveInsuranceTool: ActTool = {
  kind: "act",
  spec: {
    name: "save_insurance",
    description: "Propose saving an insurance card to a member's wallet (so future bookings + in-network checks use it).",
    parameters: {
      type: "object",
      properties: {
        carrier: { type: "string", description: "Carrier, e.g. 'Aetna', 'Blue Cross'." },
        plan_name: { type: "string", description: "Plan name if given, e.g. 'PPO'." },
        member_id: { type: "string", description: "Member/subscriber ID if given." },
        member: { type: "string", description: "Whose insurance; omit for the user." },
      },
      required: ["carrier"],
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const carrier = String(args.carrier ?? "");
    return {
      action: {
        tool: "save_insurance",
        args: { carrier, planName: str(args.plan_name), memberId: str(args.member_id) },
        subjectUserId: subject.id,
        restatement: `Save ${carrier}${args.plan_name ? ` ${args.plan_name}` : ""} as ${subject.name}'s insurance?`,
      },
    };
  },
};

const updateProfileTool: ActTool = {
  kind: "act",
  spec: {
    name: "update_profile",
    description: "Propose updating a member's profile details (name, date of birth, phone).",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string" },
        dob: { type: "string", description: "Date of birth as yyyy-mm-dd." },
        phone: { type: "string" },
        member: { type: "string", description: "Whose profile; omit for the user." },
      },
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const fields = [str(args.full_name) && "name", str(args.dob) && "date of birth", str(args.phone) && "phone"].filter(Boolean);
    return {
      action: {
        tool: "update_profile",
        args: { fullName: str(args.full_name), dob: str(args.dob), phone: str(args.phone) },
        subjectUserId: subject.id,
        restatement: `Update ${subject.name}'s ${fields.join(", ") || "profile"}?`,
      },
    };
  },
};

const saveProviderTool: ActTool = {
  kind: "act",
  spec: {
    name: "save_provider",
    description: "Propose saving a provider/office to the family's directory for quick future booking.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        website: { type: "string" },
        specialty: { type: "string" },
        member: { type: "string", description: "Scope to a member; omit for household-wide." },
      },
      required: ["name"],
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    const name = String(args.name ?? "");
    return {
      action: {
        tool: "save_provider",
        args: { name, phone: str(args.phone), website: str(args.website), specialty: str(args.specialty), memberId: args.member ? subject.id : null },
        subjectUserId: subject.id,
        restatement: `Save ${name} to your providers?`,
      },
    };
  },
};

const cancelBookingTool: ActTool = {
  kind: "act",
  spec: {
    name: "cancel_booking",
    description:
      "Propose stopping and closing out an in-flight booking for a member (the user wants to cancel, " +
      "abandon, stop the retries, or close it out). Call this whenever they ask to stop/cancel a booking — " +
      "do NOT just say it's done.",
    parameters: {
      type: "object",
      properties: { member: { type: "string", description: "Family member whose booking to stop; omit for the user." } },
    },
  },
  async build(ctx, args) {
    const subject = resolveSubject(ctx, str(args.member));
    return {
      action: {
        tool: "cancel_booking",
        args: {},
        subjectUserId: subject.id,
        restatement: `Stop and close out the booking${subject.id !== ctx.members[0]?.id ? ` for ${subject.name}` : ""}?`,
      },
    };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  searchPhysiciansTool,
  physicianDetailsTool,
  healthLookupTool,
  briefingTool,
  bookAppointmentTool,
  cancelBookingTool,
  setReminderTool,
  saveInsuranceTool,
  updateProfileTool,
  saveProviderTool,
];

const BY_NAME = new Map<string, AgentTool>(AGENT_TOOLS.map((t) => [t.spec.name, t]));
export function getTool(name: string): AgentTool | undefined {
  return BY_NAME.get(name);
}
export function toolSpecs(): LlmTool[] {
  return AGENT_TOOLS.map((t) => t.spec);
}
