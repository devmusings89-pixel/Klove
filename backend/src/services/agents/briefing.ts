// Briefing specialist. Answers "what needs me / what's coming up" and "what should I ask at <visit>"
// over chat, reusing buildTodayBriefing (services/today-brief.ts) and buildBrief (services/prep.ts).
// Read-only — never proposes a state change. Works fully in mock mode (no LLM needed).

import { buildTodayBriefing } from "../today-brief.js";
import { buildBrief } from "../prep.js";
import { resolveMemberFromText, type AgentContext, type Subagent, type SubagentResult } from "./shared.js";

// Visit-prep intent: explicit ("prep", "questions to ask") or natural ("what should I bring up with
// them?", "what do I raise with the doctor?", "things to discuss at the appointment").
const PREP_RE =
  /\b(prep(are)?|questions?\b|what (should|do|can|would) i\s+(ask|bring up|raise|discuss|mention|cover|go over|talk about|tell)|bring up|things to (ask|raise|bring|discuss)|talk to .* about|discuss with)\b/i;

export const briefingAgent: Subagent = {
  name: "briefing",
  async run(ctx: AgentContext): Promise<SubagentResult> {
    const wantsPrep = PREP_RE.test(ctx.text);
    const briefing = await buildTodayBriefing(ctx.operatorUserId);

    if (wantsPrep) {
      const { member } = resolveMemberFromText(ctx.text, ctx.members);
      const subjectId = member?.id;
      const next = briefing.upcomingAppointments.find((a) => !subjectId || a.subjectUserId === subjectId);
      if (!next) {
        return { kind: "reply", text: "I don't see an upcoming appointment to prep for yet." };
      }
      const brief = await buildBrief(next.subjectUserId, next.id);
      const when = next.startsAt ? fmtDate(next.startsAt) : "soon";
      const lines = brief.questions.slice(0, 4).map((q, i) => `${i + 1}. ${q}`);
      return {
        kind: "reply",
        text: `For ${next.title}${next.provider ? ` with ${next.provider}` : ""} (${when}), here's what I'd ask:\n${lines.join("\n")}`,
      };
    }

    // Default: a concise Today briefing.
    const parts: string[] = [];
    if (briefing.needsYou.length) {
      parts.push(`🔴 Needs you (${briefing.needsYou.length}):`);
      for (const t of briefing.needsYou.slice(0, 5)) parts.push(`• ${t.title}${t.memberName !== self(ctx) ? ` — ${t.memberName}` : ""}`);
    }
    if (briefing.upcomingAppointments.length) {
      parts.push(`📅 Upcoming:`);
      for (const a of briefing.upcomingAppointments.slice(0, 5)) {
        const when = a.startsAt ? fmtDate(a.startsAt) : "TBD";
        parts.push(`• ${a.title}${a.provider ? ` with ${a.provider}` : ""} — ${when}`);
      }
    }
    if (briefing.waiting.length) parts.push(`⏳ Waiting on a provider: ${briefing.waiting.length}`);
    if (!parts.length) return { kind: "reply", text: "You're all clear — nothing needs you and no upcoming visits on file." };
    return { kind: "reply", text: parts.join("\n") };
  },
};

function self(ctx: AgentContext): string {
  return ctx.members[0]?.name ?? "you";
}

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
