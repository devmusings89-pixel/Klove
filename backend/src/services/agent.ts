// WhatsApp concierge orchestrator. Owns the deterministic safety machinery — identity, the
// confirm-before-execute gate, consent re-checks, and conversation state — and delegates reasoning to
// one of three specialist subagents (booking / healthqa / briefing). Subagents PROPOSE state changes;
// only this module executes them, and only after the user confirms. See services/agents/*.
//
// Turn content lives in Message (channel="whatsapp"); the pending action lives in AgentConversation.

import type { AgentConversation } from "@prisma/client";
import { prisma } from "../db.js";
import { runText, llmAvailable } from "./llm-tool.js";
import { isConsentError } from "./auth.js";
import { ensureHousehold, accessibleSubjects } from "./household.js";
import { bookAppointment } from "./concierge.js";
import { placeBookingCallback } from "./orchestrator.js";
import { fromJson, toJson } from "./json.js";
import { loadMemory, rememberFromTurn } from "./agent-memory.js";
import { bookingAgent } from "./agents/booking.js";
import { healthQaAgent } from "./agents/healthqa.js";
import { briefingAgent } from "./agents/briefing.js";
import { assertCanOperate, BASE_SYSTEM, type AgentContext, type ProposedAction, type Subagent, type SubagentResult } from "./agents/shared.js";
import { runAgentLoop } from "./agent-loop.js";
import type { AgentCard } from "./agent-tools.js";
import { addInsurance, upsertProfile } from "./profiles.js";
import { upsertProvider } from "./providers.js";

const PENDING_TTL_MS = 30 * 60_000; // a proposed action awaiting "yes" expires after 30 min
const HISTORY_TURNS = 20;

interface InboundUser {
  id: string;
  whatsappVerified: boolean;
}

/** Resolve the Klove user a WhatsApp number belongs to, or null. Stamps the inbound timestamp. */
export async function resolveUserByWhatsapp(e164: string): Promise<{ id: string; whatsappVerified: boolean } | null> {
  const user = await prisma.user.findUnique({ where: { whatsappPhone: e164 }, select: { id: true, whatsappVerified: true } });
  if (user) await prisma.user.update({ where: { id: user.id }, data: { lastWhatsappInboundAt: new Date() } });
  return user;
}

// Natural confirmations / cancellations a person actually texts back to a proposal.
const YES_RE = /^\s*(y|ya|yes|yep|yeah|yup|yup\b|sure|ok|okay|kk?|confirm(ed)?|do it|go ahead|go for it|please do|pls do|sounds good|sg|let'?s do it|book it|that works|works for me|works|perfect|great|yes please|absolutely|👍|✅|🙏)\b/i;
const NO_RE = /^\s*(n|no|nope|nah|cancel|stop|don'?t|never\s?mind|forget it|not now|hold off|skip( it)?|leave it|maybe later|👎)\b/i;
function isAffirmative(text: string): boolean {
  return YES_RE.test(text);
}
function isNegative(text: string): boolean {
  return NO_RE.test(text);
}

/**
 * Handle one inbound WhatsApp message and return the agent's reply text (the webhook sends it). This
 * is the single entry point; it is synchronous end-to-end so the reply reflects any action taken.
 */
export async function handleInboundMessage(user: InboundUser, rawText: string): Promise<string> {
  const text = rawText.trim();
  if (!text) return "I didn't catch that — what can I help with?";

  // ---- Onboarding / opt-in: an unverified known number must confirm before the agent acts. ----
  if (!user.whatsappVerified) {
    if (isAffirmative(text)) {
      await prisma.user.update({ where: { id: user.id }, data: { whatsappVerified: true } });
      return "You're connected ✅ I'm Klove, your family's health concierge. Text me to book a visit, ask about a lab or medication, or get your day's summary.";
    }
    return "Reply YES to connect this number to your Klove account.";
  }

  const householdId = await ensureHousehold(user.id);
  const members = await accessibleSubjects(user.id);
  const convo = await getOrCreateConversation(user.id, householdId);
  const [history, memory, activity] = await Promise.all([
    loadHistory(householdId, user.id),
    loadMemory(user.id),
    loadBookingActivity(householdId, members),
  ]);
  await saveMessage(householdId, user.id, "in", text);

  // ---- Confirm-before-execute gate (deterministic, pre-LLM). ----
  const pending = readPending(convo);
  if (pending) {
    await clearPending(convo.id); // executing, cancelling, or superseding — the old proposal is spent
    if (isAffirmative(text)) {
      const reply = await executeAction(user.id, pending);
      await saveMessage(householdId, user.id, "out", reply);
      return reply;
    }
    if (isNegative(text)) {
      const reply = "Okay, cancelled. Anything else?";
      await saveMessage(householdId, user.id, "out", reply);
      return reply;
    }
    // Otherwise the message supersedes the proposal — fall through and treat it as a new request.
  }

  // ---- Route to a specialist subagent. ----
  const ctx: AgentContext = { operatorUserId: user.id, householdId, members, text, history, memory, activity };
  let reply: string;
  let route: Route | null = null;
  try {
    const routed = await routeAndRun(ctx);
    route = routed.route;
    if (routed.result.kind === "propose") {
      await storePending(convo.id, routed.result.action);
      reply = routed.result.action.restatement;
    } else {
      reply = routed.result.text;
    }
  } catch (err) {
    console.error("agent subagent failed:", (err as Error).message);
    reply = "Sorry — I hit a snag handling that. Could you rephrase?";
  }
  await saveMessage(householdId, user.id, "out", reply);
  // Learn any durable preferences from this turn (fire-and-forget). The note path already stored them.
  if (route !== "note") void rememberFromTurn(user.id, householdId, text, memory).catch((e) => console.error("memory write failed", e));
  return reply;
}

/** Classify an inbound message and run the matching specialist. Returns the route so the caller can
 *  skip the redundant post-turn memory write on a note (which already stored synchronously). */
async function routeAndRun(ctx: AgentContext): Promise<{ route: Route; result: SubagentResult }> {
  const route = await classify(ctx.text, ctx.history);
  if (route === "note") return { route, result: await handleNote(ctx) };
  const agent: Subagent = route === "booking" ? bookingAgent : route === "briefing" ? briefingAgent : healthQaAgent;
  return { route, result: await agent.run(ctx) };
}

/**
 * The user stated a standing preference/instruction. Store it synchronously (so the acknowledgment
 * reflects exactly what we saved), then confirm warmly in their own framing. If nothing durable was
 * actually said, fall back to a normal answer rather than a false "got it".
 */
async function handleNote(ctx: AgentContext): Promise<SubagentResult> {
  const before = ctx.memory;
  await rememberFromTurn(ctx.operatorUserId, ctx.householdId, ctx.text, before).catch((e) => console.error("note memory write failed", e));
  const after = await loadMemory(ctx.operatorUserId);
  const added = after.filter((a) => !before.some((b) => b.toLowerCase() === a.toLowerCase()));
  if (!added.length) return healthQaAgent.run(ctx); // not actually a durable note — answer normally

  const ack = await runText({
    system: `${BASE_SYSTEM}\nThe user just told you something to remember for the future. In ONE short, warm line, confirm you've got it, reflecting what you understood in natural second-person language. Only add a brief follow-up offer if it's genuinely natural.`,
    content: `User said: "${ctx.text}"\nYou've saved: ${added.join("; ")}`,
    maxTokens: 80,
  }).catch(() => null);
  return { kind: "reply", text: ack?.trim() || `Got it — I'll remember that. 👍` };
}

export interface AskResult {
  kind: "answer" | "escalated";
  routedTo: "ai" | "concierge";
  answer: string;
  taskId?: string;
  /** Structured payloads for the chat to render (physician lists, booking recap, etc.). */
  cards?: AgentCard[];
  /** Set when the agent is awaiting confirmation for a state-changing action (Confirm card). */
  proposal?: { restatement: string; tool: string };
}

/**
 * The in-app "Ask Klove" entry point — a tool-using AGENT. It runs a multi-step tool loop (search,
 * records, briefing…) and either replies (with cards) or proposes a state-changing action, which it
 * stores as the pending action and surfaces as a Confirm card — it does NOT auto-execute. A typed
 * "yes"/"no" against a pending proposal resolves it (mirrors the WhatsApp gate). Falls back to the
 * legacy single-subagent router when no tool-capable LLM is configured. Consent is enforced in
 * executeAction, exactly as for WhatsApp.
 */
export async function askKlove(operatorUserId: string, text: string): Promise<AskResult> {
  const householdId = await ensureHousehold(operatorUserId);
  const members = await accessibleSubjects(operatorUserId);
  const trimmed = text.trim();
  const convo = await getOrCreateConversation(operatorUserId, householdId);

  // ---- Confirm-before-execute gate: a pending proposal + yes/no resolves it. ----
  const pending = readPending(convo);
  if (pending) {
    if (isAffirmative(trimmed)) {
      await clearPending(convo.id);
      return runPending(operatorUserId, pending);
    }
    if (isNegative(trimmed)) {
      await clearPending(convo.id);
      return { kind: "answer", routedTo: "ai", answer: "Okay, cancelled. Anything else?" };
    }
    await clearPending(convo.id); // a new request supersedes the old proposal
  }

  const [memory, history, activity] = await Promise.all([
    loadMemory(operatorUserId),
    loadAskHistory(operatorUserId),
    loadBookingActivity(householdId, members),
  ]);
  const ctx: AgentContext = { operatorUserId, householdId, members, text: trimmed, history, memory, activity };

  // ---- Agentic tool loop (preferred). ----
  const loop = await runAgentLoop(ctx).catch((err) => {
    console.error("agent loop failed:", (err as Error).message);
    return null;
  });
  if (loop) {
    void rememberFromTurn(operatorUserId, householdId, trimmed, memory).catch((e) => console.error("memory write failed", e));
    if (loop.proposal) {
      await storePending(convo.id, loop.proposal);
      return {
        kind: "answer",
        routedTo: "ai",
        answer: loop.reply,
        cards: loop.cards.length ? loop.cards : undefined,
        proposal: { restatement: loop.proposal.restatement, tool: loop.proposal.tool },
      };
    }
    return { kind: "answer", routedTo: "ai", answer: loop.reply, cards: loop.cards.length ? loop.cards : undefined };
  }

  // ---- Fallback: legacy single-subagent router (no tool-capable LLM). ----
  let routed;
  try {
    routed = await routeAndRun(ctx);
  } catch (err) {
    console.error("askKlove failed:", (err as Error).message);
    return { kind: "answer", routedTo: "ai", answer: "Sorry — I couldn't process that just now. Try rephrasing?" };
  }
  if (routed.route !== "note") void rememberFromTurn(operatorUserId, householdId, trimmed, memory).catch((e) => console.error("memory write failed", e));
  if (routed.result.kind === "reply") {
    return { kind: "answer", routedTo: "ai", answer: routed.result.text };
  }
  // Legacy actionable path stays auto-execute (no loop = no card UI to confirm against).
  return runPending(operatorUserId, routed.result.action);
}

/** Execute a confirmed/pending action and shape the AskResult (used by the gate + /ask/confirm). */
async function runPending(operatorUserId: string, action: ProposedAction): Promise<AskResult> {
  const answer = await executeAction(operatorUserId, action, "app");
  const task = await prisma.task.findFirst({
    where: { subjectUserId: action.subjectUserId, kind: { in: ["book", "choose_time", "reminder"] } },
    orderBy: { createdAt: "desc" },
  });
  // For a live booking, attach a status card so the chat shows the call progressing in real time.
  const cards: AgentCard[] = [];
  if (action.tool === "book_appointment" && task?.conciergeJobId) {
    cards.push({ type: "booking_status", sessionId: task.conciergeJobId, provider: optStr(action.args.provider), reason: optStr(action.args.reason) });
  }
  return { kind: "escalated", routedTo: "concierge", answer, taskId: task?.id ?? undefined, cards: cards.length ? cards : undefined };
}

/** Confirm the pending in-app proposal (the Confirm button → POST /ask/confirm). */
export async function askConfirm(operatorUserId: string): Promise<AskResult> {
  const householdId = await ensureHousehold(operatorUserId);
  const convo = await getOrCreateConversation(operatorUserId, householdId);
  const pending = readPending(convo);
  if (!pending) return { kind: "answer", routedTo: "ai", answer: "There's nothing to confirm right now." };
  await clearPending(convo.id);
  return runPending(operatorUserId, pending);
}

/** Dismiss the pending in-app proposal (the Edit/cancel path). */
export async function askCancel(operatorUserId: string): Promise<void> {
  const householdId = await ensureHousehold(operatorUserId);
  const convo = await getOrCreateConversation(operatorUserId, householdId);
  await clearPending(convo.id);
}

// ---- Action execution (the ONLY place state changes happen; re-checks consent + audits). ----

async function executeAction(operatorUserId: string, action: ProposedAction, originChannel: "app" | "whatsapp" = "whatsapp"): Promise<string> {
  try {
    await assertCanOperate(operatorUserId, action.subjectUserId);
  } catch (err) {
    if (isConsentError(err)) return "I can't act for that family member — you don't have permission set up for them.";
    throw err;
  }
  const householdId = await ensureHousehold(operatorUserId);

  switch (action.tool) {
    case "book_appointment": {
      const reason = String(action.args.reason ?? "Appointment");
      const str = (v: unknown) => (v ? String(v) : undefined);
      const outcome = await bookAppointment(operatorUserId, action.subjectUserId, householdId, {
        reason,
        provider: str(action.args.provider),
        preferredTimes: str(action.args.preferredTimes),
        phone: str(action.args.phone),
        website: str(action.args.website),
        insurance: str(action.args.insurance),
        memberId: str(action.args.memberId),
        dob: str(action.args.dob),
        specialty: str(action.args.specialty),
        originChannel,
      });
      const provider = str(action.args.provider);
      await audit(operatorUserId, action.subjectUserId, "booking_authorized", `WhatsApp booking: ${reason}`);
      if (outcome.status === "in_progress") {
        return `On it — I'm calling ${provider ?? "the office"} now to book ${reason}. You'll see live progress below, and I'll confirm here the moment it's booked. If they don't pick up, I'll flag it in your Actions with their number so we can finish it.`;
      }
      // needs_info: couldn't reach an office — no fake hold; the task tracks the follow-up.
      return `I couldn't reach an office to book ${reason} automatically — I've added it to your Actions so we can finish it (add a phone/website or pick a provider).`;
    }
    case "choose_appointment_time": {
      const taskId = String(action.args.taskId ?? "");
      const slot = String(action.args.slot ?? "");
      const task = taskId ? await prisma.task.findUnique({ where: { id: taskId } }) : null;
      if (!task || !task.conciergeJobId) return "That booking request has expired — want me to start it again?";
      const offered = fromJson<string[]>(task.options, []);
      if (!offered.includes(slot)) return "That time isn't on the offer list anymore — reply with one of the listed times.";
      const target = await prisma.callTarget.findFirst({ where: { sessionId: task.conciergeJobId, status: "awaiting_choice" } });
      if (!target) return "That slot is no longer open — the office may have updated availability.";
      await prisma.task.update({
        where: { id: task.id },
        data: { state: "waiting", kind: "book", detail: `Booking ${slot}…`, title: task.title.replace(/^Pick a time:\s*/, "Booking: ") },
      });
      void placeBookingCallback(target.id, slot);
      await audit(operatorUserId, task.subjectUserId, "booking_authorized", `WhatsApp chose slot: ${slot}`);
      return `Great — locking in ${slot}. I'll confirm here as soon as it's booked.`;
    }
    case "set_reminder": {
      const title = String(action.args.title ?? "Reminder");
      const when = optStr(action.args.when);
      await prisma.task.create({
        data: { subjectUserId: action.subjectUserId, householdId, title, kind: "reminder", state: "needs_you", detail: when, originChannel },
      });
      await audit(operatorUserId, action.subjectUserId, "reminder_created", title);
      return `Done — I've added a reminder${when ? ` for ${when}` : ""}: "${title}".`;
    }
    case "save_insurance": {
      const carrier = String(action.args.carrier ?? "");
      await addInsurance(action.subjectUserId, { carrier, planName: optStr(action.args.planName), memberId: optStr(action.args.memberId) });
      await audit(operatorUserId, action.subjectUserId, "insurance_saved", carrier);
      return `Saved ${carrier} to the insurance wallet — I'll use it for bookings and coverage checks.`;
    }
    case "update_profile": {
      await upsertProfile(action.subjectUserId, { fullName: optStr(action.args.fullName), dob: optStr(action.args.dob), phone: optStr(action.args.phone) });
      await audit(operatorUserId, action.subjectUserId, "profile_updated", "profile fields");
      return `Updated the profile. 👍`;
    }
    case "cancel_booking": {
      const { cancelActiveBooking } = await import("./concierge.js");
      const res = await cancelActiveBooking(action.subjectUserId, householdId);
      await audit(operatorUserId, action.subjectUserId, "booking_cancelled", res.title ?? "booking");
      if (res.cancelled === 0) return "I don't see an active booking to stop right now — nothing to close out.";
      return `Done — I've stopped that booking and closed it out${res.title ? ` (${res.title.replace(/^(Booking|Cancelled|Pick a time): /, "")})` : ""}. Nothing more will be attempted.`;
    }
    case "save_provider": {
      const name = String(action.args.name ?? "");
      await upsertProvider({
        householdId,
        subjectUserId: action.args.memberId ? String(action.args.memberId) : null,
        name,
        phone: optStr(action.args.phone),
        website: optStr(action.args.website),
        specialty: optStr(action.args.specialty),
        source: "manual",
      });
      await audit(operatorUserId, action.subjectUserId, "provider_saved", name);
      return `Saved ${name} to your providers.`;
    }
    default:
      return "I'm not able to do that one yet.";
  }
}

const optStr = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

async function audit(actorUserId: string, subjectUserId: string, action: string, detail: string): Promise<void> {
  await prisma.auditEvent.create({ data: { actorUserId, subjectUserId, action, detail } }).catch((e) => console.error("audit write failed", e));
}

// ---- Intent routing ----

type Route = "booking" | "healthqa" | "briefing" | "note";

const BOOKING_KW = ["book", "appointment", "schedule", "reschedul", "cancel", "slot", "dentist", "doctor", "dermatolog", "checkup", "check-up", "visit"];
const BRIEFING_KW = ["today", "upcoming", "summary", "needs", "prep", "prepare", "what should i ask", "remind", "due", "agenda", "brief", "my day"];
// A pure preference / instruction / FYI to remember (no question, no action request).
const NOTE_RE = /\b(just so you know|for (future|the future|next time)|fyi|note:|remember (that|this)|keep in mind|from now on|going forward|i (prefer|always|usually|like|hate|don'?t (want|like))|call me|i'?m on .* insurance|my insurance is|use my)\b/i;

function keywordClassify(text: string): Route {
  const t = text.toLowerCase();
  if (BOOKING_KW.some((k) => t.includes(k))) return "booking";
  if (NOTE_RE.test(t) && !text.includes("?")) return "note";
  if (BRIEFING_KW.some((k) => t.includes(k))) return "briefing";
  return "healthqa";
}

const CLASSIFY_SYSTEM =
  "You route a family health concierge's WhatsApp messages. Classify the LATEST user message into exactly one label:\n" +
  "- booking: book, schedule, reschedule, cancel, or pick a time for an appointment\n" +
  "- briefing: their to-do summary, what's coming up, or questions to ask at a visit\n" +
  "- healthqa: an informational question about someone's health records (labs, meds, conditions, trends)\n" +
  "- note: they're just stating a standing preference, instruction, or FYI for you to REMEMBER (e.g. 'I prefer " +
  "mornings', 'always use my Aetna', 'call me Sam', 'avoid Fridays') — NOT asking a question or requesting an action\n" +
  "Use the recent conversation to resolve short or elliptical follow-ups: 'is that improving?', 'what about my " +
  "cholesterol?', 'and mom's?' usually continue the SAME topic as the previous turns. 'yes'/'do it' continue whatever " +
  "was just proposed. If a message both states a preference AND asks/requests something, prefer booking/healthqa/briefing " +
  "(the preference still gets remembered separately). Reply with ONLY the single label word.";

/** Route an inbound message. Keyword first; refine with a context-aware LLM call when configured. */
export async function classify(text: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<Route> {
  const kw = keywordClassify(text);
  if (!llmAvailable()) return kw;
  try {
    const recent = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Klove"}: ${m.content}`).join("\n");
    const content = recent ? `Recent conversation:\n${recent}\n\nLatest user message: ${text}\n\nLabel:` : `User message: ${text}\n\nLabel:`;
    const out = await runText({ system: CLASSIFY_SYSTEM, content, maxTokens: 8 });
    const n = (out ?? "").toLowerCase();
    if (n.includes("book")) return "booking";
    if (n.includes("brief")) return "briefing";
    if (n.includes("note")) return "note";
    if (n.includes("health")) return "healthqa";
  } catch (err) {
    console.error("classify LLM failed:", (err as Error).message);
  }
  return kw;
}

// ---- Conversation state ----

async function getOrCreateConversation(userId: string, householdId: string): Promise<AgentConversation> {
  return prisma.agentConversation.upsert({
    where: { userId },
    create: { userId, householdId },
    update: { lastTurnAt: new Date() },
  });
}

function readPending(convo: AgentConversation): ProposedAction | null {
  if (!convo.pendingAction) return null;
  if (convo.pendingExpiresAt && convo.pendingExpiresAt.getTime() < Date.now()) return null;
  return fromJson<ProposedAction | null>(convo.pendingAction, null);
}

async function storePending(convoId: string, action: ProposedAction): Promise<void> {
  await prisma.agentConversation.update({
    where: { id: convoId },
    data: { pendingAction: toJson(action), pendingExpiresAt: new Date(Date.now() + PENDING_TTL_MS) },
  });
}

async function clearPending(convoId: string): Promise<void> {
  await prisma.agentConversation.update({ where: { id: convoId }, data: { pendingAction: null, pendingExpiresAt: null } });
}

/** Prior WhatsApp turns (oldest first), reconstructed from Message rows. Excludes the current inbound. */
async function loadHistory(householdId: string, userId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await prisma.message.findMany({
    where: { householdId, subjectUserId: userId, channel: "whatsapp" },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
  });
  return rows
    .reverse()
    .map((m) => ({ role: m.direction === "in" ? ("user" as const) : ("assistant" as const), content: m.body }));
}

async function saveMessage(householdId: string, userId: string, direction: "in" | "out", body: string): Promise<void> {
  await prisma.message.create({ data: { householdId, subjectUserId: userId, direction, channel: "whatsapp", body } });
}

/**
 * Prior in-app "Ask Klove" turns (oldest first), reconstructed from the Request rows /ask already
 * persists (text = the user's ask, responseJson = the AskResult). Without this the in-app agent ran
 * stateless and forgot its own previous answer ("How did you select that center?" → "I haven't selected
 * any center yet"). The current turn's Request is written AFTER askKlove returns, so this is prior turns
 * only — exactly the history we want.
 */
async function loadAskHistory(operatorUserId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await prisma.request.findMany({
    where: { operatorUserId, kind: "ask" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { text: true, responseJson: true },
  });
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of rows.reverse()) {
    if (r.text?.trim()) turns.push({ role: "user", content: r.text.trim() });
    const answer = fromJson<{ answer?: string } | null>(r.responseJson, null)?.answer?.trim();
    if (answer) turns.push({ role: "assistant", content: answer });
  }
  return turns;
}

/**
 * A compact, household-wide summary of in-flight + recently-resolved bookings (the office Klove is
 * contacting, or has booked), so the agent answers cross-flow questions ("what office am I booking
 * with?", "how did you pick that center?") consistently — whether the booking started in the app's
 * booking form, on WhatsApp, or via Ask Klove. The chosen office for an in-flight booking lives on the
 * linked Session's first CallTarget (no Appointment exists until the call confirms); a booked one is in
 * Task.bookingJson. Only tasks for members the operator can see are included (respects consent).
 */
export async function loadBookingActivity(
  householdId: string,
  members: { id: string; name: string }[],
): Promise<string> {
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const tasks = await prisma.task.findMany({
    where: { householdId, kind: { in: ["book", "choose_time"] }, subjectUserId: { in: [...nameById.keys()] } },
    orderBy: { updatedAt: "desc" },
    take: 6,
  });
  if (!tasks.length) return "";

  // Resolve the chosen office for in-flight tasks via the linked Session's first CallTarget.
  const jobIds = tasks.map((t) => t.conciergeJobId).filter((x): x is string => Boolean(x));
  const sessions = jobIds.length
    ? await prisma.session.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, targets: { orderBy: { order: "asc" }, take: 1, select: { officeName: true } } },
      })
    : [];
  const officeByJob = new Map(sessions.map((s) => [s.id, s.targets[0]?.officeName ?? null]));

  const lines = tasks.map((t) => {
    const who = nameById.get(t.subjectUserId) ?? "a family member";
    const booking = fromJson<{ provider?: string; whenText?: string; confirmation?: string } | null>(t.bookingJson, null);
    const office = booking?.provider ?? (t.conciergeJobId ? officeByJob.get(t.conciergeJobId) ?? null : null);
    const state =
      t.state === "handled" ? "booked" :
      t.kind === "choose_time" ? "waiting on you to pick a time" :
      t.state === "waiting" ? "in progress — Klove is contacting the office" :
      "needs you to finish";
    const officeText = office ? ` with ${office}` : "";
    const when = booking?.whenText ? `, ${booking.whenText}` : "";
    const conf = booking?.confirmation ? ` (confirmation ${booking.confirmation})` : "";
    return `- "${t.title}" for ${who}${officeText}${when} — ${state}${conf}`;
  });
  return lines.join("\n");
}
