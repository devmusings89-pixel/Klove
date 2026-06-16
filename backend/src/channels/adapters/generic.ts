import { config } from "../../config.js";
import { getModelTurn, type LlmTool, type NeutralMsg } from "../llm.js";
import type { WebSession } from "../web-session.js";
import type { BookingContext, ChannelResult } from "../types.js";
import type { CallOutcome } from "../../types.js";
import type { SchedulerAdapter } from "./types.js";

/**
 * Generic adapter — the LLM tool-use agent. Handles any booking site we don't have a deterministic
 * platform adapter for. Reliable-ish but slower/pricier than a platform adapter, so it's last.
 */
export const genericAdapter: SchedulerAdapter = {
  name: "generic",
  matches() {
    return true; // catch-all — registered last
  },
  async run(session, ctx) {
    return runWebAgent(session, ctx, false);
  },
};

/** Read-only recon of a booking site — reports flow, Saturday availability, required fields. */
export async function reconWithSession(session: WebSession, ctx: BookingContext): Promise<ChannelResult> {
  return runWebAgent(session, ctx, true);
}

const SYSTEM_PROMPT = `You are booking a medical appointment on behalf of a patient by operating their doctor's office website in a real browser.

Patient details (use these; never invent anything you weren't given):
- Name: {{name}}
- Date of birth: {{dob}}
- Reason for visit: {{reason}}
- Insurance: {{insurance}}
- Patient status at this office (new or existing): {{patientStatus}}
- Preferred times: {{preferredTimes}}
- Acceptable window (auto-book if a slot falls within this): {{acceptableWindow}}
- Additional info the office may ask for: {{additionalInfo}}

Mode: {{mode}}{{bookLine}}

General operation:
- Call snapshot to see interactable elements (each has a "ref"); act with click/type/select using those refs; navigate to change pages.
- Use exact element refs from the MOST RECENT snapshot. After any click that changes the page, snapshot again before acting.
- Copy slot/date text EXACTLY as shown on the page; never invent or reformat dates, times, or confirmation numbers.
- If a required field asks for information you don't have (and must not invent), report outcome "info_needed" with it in missingInfo. NEVER enter payment card details, SSN, or full insurance member numbers you weren't given — treat those as missing info.
- If you get stuck (CAPTCHA, login wall, broken flow), report outcome "failed". You MUST call report exactly once when done.

If Mode is "gather" (you are COLLECTING availability — do NOT book anything):
- Fill the patient's details and advance to the list of available appointment times.
- List EVERY available slot, in the order they appear on the page (top to bottom), in offeredSlots — copy each label verbatim.
- In acceptableSlots, list (in the SAME order) only the slots that fall within the patient's acceptable window. If unsure whether a slot fits, include it.
- Do NOT click a slot or confirm anything. Report outcome "options_collected" with offeredSlots and acceptableSlots. If there is no availability, outcome "no_availability".

If Mode is "book" (you are BOOKING one specific slot):
- Fill any required patient details, advance to the times, then select the slot whose label matches {{chosenSlot}} exactly, click the confirm/book/submit button, and snapshot to read the confirmation.
- Report outcome "booked" with appointmentDateTime (the slot's label) and the confirmation number. If that exact slot is gone, report "options_collected" with the current offeredSlots + acceptableSlots.`;

const RECON_PROMPT = `You are doing READ-ONLY reconnaissance of a real dental office's online scheduler to find the earliest available SATURDAY appointment. Do not actually book.

ABSOLUTE RULES:
- DO NOT type into any field, and DO NOT click a final-commit button (submit / confirm / book this appointment / schedule appointment / request). Selecting a time slot to view it is fine; confirming the booking is NOT.
- It IS fine to click the funnel choices needed to REACH the calendar: "Book/Schedule", the patient-type matching {{patientStatus}} (e.g. New Patient vs Existing Patient), a general checkup/cleaning visit type, and "Any/First available" provider if offered.

Your job:
1. Advance through the funnel until you reach the date/time calendar.
2. On the calendar, repeatedly click the "next" / forward / ">" arrow to move week-by-week through upcoming dates. For EACH Saturday column, check whether it has ANY available time slots. Saturday availability can be MONTHS out (e.g. October), so DO NOT stop after a few empty weeks — keep clicking "next" and advancing until you find a Saturday that has open time slots, or until you have scanned roughly 6 months ahead. Note the date you've reached every few weeks so you can track progress.
3. Report the EARLIEST Saturday that has availability and the times offered that day. Only conclude there are no Saturdays if you scanned ~6 months and found none.

When done, call report once:
- outcome: "options_collected" if you found one or more bookable Saturdays; "no_availability" if Saturdays exist on the calendar but none are bookable, or the office offers no Saturdays; "failed" if you couldn't reach the calendar.
- offeredSlots: the earliest bookable Saturday's available times, copied verbatim (e.g. "Sat Jul 12, 9:00 AM"). Include the date.
- missingInfo: the patient fields the final booking form requires (if you saw the form).
- summary: 2-4 sentences: the funnel steps, whether Saturdays are offered, and the earliest bookable Saturday (with date) or why none.`;

const TOOLS: LlmTool[] = [
  { name: "snapshot", description: "Return the current page URL/title, visible text, and interactable elements with refs.", parameters: { type: "object", properties: {} } },
  { name: "navigate", description: "Navigate the browser to a URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "click", description: "Click the element with the given ref (from snapshot).", parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "type", description: "Type text into the input element with the given ref.", parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] } },
  { name: "select", description: "Choose an option (by label or value) in the select element with the given ref.", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
  {
    name: "report",
    description: "Report the final outcome. Call exactly once when finished.",
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["booked", "options_collected", "info_needed", "no_availability", "failed"] },
        appointmentDateTime: { type: "string" },
        confirmation: { type: "string" },
        offeredSlots: { type: "array", items: { type: "string" }, description: "All available slots, in page order." },
        acceptableSlots: { type: "array", items: { type: "string" }, description: "Subset of offeredSlots within the acceptable window, in page order." },
        missingInfo: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      required: ["outcome", "summary"],
    },
  },
];

async function runWebAgent(session: WebSession, ctx: BookingContext, recon: boolean): Promise<ChannelResult> {
  const { turn, label } = getModelTurn();
  const transcript: string[] = [`engine: ${label}${recon ? " (recon)" : ""}`];
  const website = await session.getPage().then((p) => p.url());

  const system = recon
    ? RECON_PROMPT.replace("{{patientStatus}}", ctx.patient.patientStatus || "new")
    : SYSTEM_PROMPT.replace("{{name}}", ctx.patient.name)
        .replace("{{dob}}", ctx.patient.dob)
        .replace("{{reason}}", ctx.patient.reason)
        .replace("{{insurance}}", ctx.patient.insurance || "not provided")
        .replace("{{patientStatus}}", ctx.patient.patientStatus || "unknown")
        .replace("{{preferredTimes}}", ctx.patient.preferredTimes || "any available time")
        .replace("{{acceptableWindow}}", ctx.patient.acceptableWindow || "the patient's preferred times only")
        .replace("{{additionalInfo}}", ctx.patient.additionalInfo || "none provided")
        .replace("{{mode}}", ctx.mode)
        .replace("{{chosenSlot}}", ctx.chosenSlot ?? "")
        .replace("{{bookLine}}", ctx.mode === "book" && ctx.chosenSlot ? `\nConfirm this exact slot: ${ctx.chosenSlot}` : "");

  const history: NeutralMsg[] = [
    {
      role: "user",
      content: recon
        ? `Recon the booking flow at ${website}. Start by calling snapshot. Observe only — never type or submit.`
        : `Book an appointment at ${website}. Start by calling snapshot.`,
    },
  ];

  for (let step = 0; step < config.webAgent.maxSteps; step++) {
    const { text, toolCalls } = await turn(system, history, TOOLS);
    history.push({ role: "assistant", content: text, toolCalls });

    if (toolCalls.length === 0) {
      history.push({ role: "user", content: "Continue. Use a tool, and call report when finished." });
      continue;
    }

    for (const tc of toolCalls) {
      if (tc.name === "report") return finalizeReport(tc.args, transcript);
      if (recon && tc.name === "type") {
        history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: "blocked: recon is read-only, do not type" });
        continue;
      }
      const out = await session.exec(tc.name, tc.args);
      transcript.push(`${tc.name}(${JSON.stringify(tc.args)}) -> ${out.slice(0, 200)}`);
      history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: out });
    }
  }

  return { outcome: "failed", summary: `${recon ? "Recon" : "Web agent"} hit the step limit without completing.`, transcript: transcript.join("\n") };
}

function finalizeReport(input: Record<string, unknown>, transcript: string[]): ChannelResult {
  return {
    outcome: (input.outcome as CallOutcome) ?? "failed",
    appointmentDateTime: (input.appointmentDateTime as string) ?? "",
    confirmation: (input.confirmation as string) ?? "",
    offeredSlots: (input.offeredSlots as string[]) ?? [],
    acceptableSlots: (input.acceptableSlots as string[]) ?? [],
    missingInfo: (input.missingInfo as string[]) ?? [],
    summary: (input.summary as string) ?? "",
    transcript: transcript.join("\n"),
  };
}
