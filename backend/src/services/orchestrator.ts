import { prisma } from "../db.js";
import { fromJson, toJson } from "./json.js";
import { isWithinBusinessHours } from "./scheduler.js";
import { routeAndAttempt, getChannel } from "../channels/registry.js";
import type { BookingContext, ChannelResult, ChannelType } from "../channels/types.js";
import type { CallStructuredData, CallOutcome, PatientInfo } from "../types.js";

const EMPTY_PATIENT: PatientInfo = {
  name: "",
  dob: "",
  reason: "",
  insurance: "",
  preferredTimes: "",
  acceptableWindow: "",
  additionalInfo: "",
  patientPhone: "",
  patientEmail: "",
  patientStatus: "",
};

/** Total call minutes already consumed by a session — enforces the per-session minutes cap. */
async function minutesUsed(sessionId: string): Promise<number> {
  const results = await prisma.callResult.findMany({
    where: { callTarget: { sessionId } },
    select: { durationSec: true },
  });
  const sec = results.reduce((acc, r) => acc + (r.durationSec ?? 0), 0);
  return sec / 60;
}

/**
 * Begin (or advance) a paid session: route the next pending office through the best channel.
 * Sequential — one office in flight at a time. Async channels (voice) finish via webhook.
 */
export async function placeNextCall(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { targets: { orderBy: { order: "asc" } } },
  });
  if (!session) return;
  if (!["paid", "scheduling", "in_progress"].includes(session.status)) return;

  // Don't start a second attempt while one is in flight (worker + webhook can both call this).
  if (session.targets.some((t) => t.status === "calling")) return;

  // A warm transfer means the patient is live with that office — never start another call over it.
  if (session.targets.some((t) => t.status === "transferred")) {
    return finalizeOrAwaitChoice(sessionId);
  }

  // Stop early if a previous office already booked and stopWhenBooked is set.
  if (session.stopWhenBooked && session.targets.some((t) => t.status === "booked")) {
    return finalizeOrAwaitChoice(sessionId);
  }

  // Enforce the minutes cap.
  if ((await minutesUsed(sessionId)) >= session.minutesCap) return finalizeOrAwaitChoice(sessionId);

  const next = session.targets.find((t) => t.status === "pending");
  if (!next) return finalizeOrAwaitChoice(sessionId);

  // Defer to the worker if outside business hours (gates all channels for now; off by default).
  if (!isWithinBusinessHours(next.timezone)) {
    if (session.status !== "scheduling") {
      await prisma.session.update({ where: { id: sessionId }, data: { status: "scheduling" } });
    }
    return;
  }

  const patient = fromJson<PatientInfo>(session.patientInfo, EMPTY_PATIENT);
  await prisma.session.update({ where: { id: sessionId }, data: { status: "in_progress" } });
  // Mark in-flight before routing so the worker tick can't double-enter a synchronous (web) run.
  await prisma.callTarget.update({ where: { id: next.id }, data: { status: "calling", calledAt: new Date() } });

  const ctx: BookingContext = { target: next, session, patient, mode: "gather" };
  const route = await routeAndAttempt(ctx);

  if (route.pending) return; // async channel (voice) placed; webhook will advance
  if (route.result) {
    await recordChannelResult(next.id, route.channel, "gather", route.result);
    return;
  }
  // Nothing could start — mark failed and move on.
  await prisma.callTarget.update({ where: { id: next.id }, data: { status: "failed", channel: route.channel } });
  await placeNextCall(sessionId);
}

/**
 * Worker tick: advance any active session and reap stuck in-flight attempts (missed webhook).
 */
const STUCK_CALL_TIMEOUT_MS = 15 * 60 * 1000;

export async function runSchedulerTick(): Promise<void> {
  const active = await prisma.session.findMany({
    where: { status: { in: ["paid", "scheduling", "in_progress"] } },
    include: { targets: true },
  });

  for (const session of active) {
    const stuck = session.targets.find(
      (t) =>
        t.status === "calling" &&
        t.calledAt != null &&
        Date.now() - t.calledAt.getTime() > STUCK_CALL_TIMEOUT_MS,
    );
    if (stuck) {
      await prisma.callTarget.update({ where: { id: stuck.id }, data: { status: "no_answer" } });
    }
    await placeNextCall(session.id);
  }
}

/** Map a normalized outcome to a CallTarget status. */
function statusForOutcome(outcome: CallOutcome | undefined, opts: { hasOptions: boolean; hasInfo: boolean; endedReason?: string }): string {
  if (outcome === "booked") return "booked";
  if (outcome === "transferred") return "transferred"; // agent patched the office to the patient, who took over
  if (outcome === "verification_needed") return "awaiting_verification"; // web channel: patient must enter a one-time code
  if (outcome === "request_sent") return "requested"; // email channel: office will follow up
  if (outcome === "options_collected" && opts.hasOptions) return "awaiting_choice";
  if (outcome === "info_needed" && opts.hasInfo) return "awaiting_info";
  if (outcome === "no_human" || opts.endedReason?.includes("voicemail")) return "voicemail";
  if (opts.endedReason?.includes("no-answer")) return "no_answer";
  return "failed";
}

/** Persist a finished attempt's result on the target + a CallResult row. */
async function persistResult(args: {
  targetId: string;
  channel: ChannelType;
  phase: "gather" | "book";
  structured: CallStructuredData;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  endedReason?: string;
  durationSec?: number;
  existingOfferedSlots?: string | null;
  existingMissingInfo?: string | null;
}): Promise<void> {
  const sd = args.structured;
  const hasOptions = (sd.offeredSlots?.length ?? 0) > 0;
  const hasInfo = (sd.missingInfo?.length ?? 0) > 0;
  const status = statusForOutcome(sd.outcome, { hasOptions, hasInfo, endedReason: args.endedReason });

  await prisma.callResult.create({
    data: {
      callTargetId: args.targetId,
      phase: args.phase,
      channel: args.channel,
      transcript: args.transcript,
      summary: args.summary,
      structuredData: toJson(sd),
      recordingUrl: args.recordingUrl,
      endedReason: args.endedReason,
      durationSec: args.durationSec,
    },
  });
  await prisma.callTarget.update({
    where: { id: args.targetId },
    data: {
      status,
      channel: args.channel,
      offeredSlots: status === "awaiting_choice" ? toJson(sd.offeredSlots) : args.existingOfferedSlots ?? undefined,
      missingInfo: status === "awaiting_info" ? toJson(sd.missingInfo) : args.existingMissingInfo ?? undefined,
    },
  });
}

/** Record a synchronous channel result (web, mock voice) and advance the session. */
export async function recordChannelResult(
  targetId: string,
  channel: ChannelType,
  phase: "gather" | "book",
  result: ChannelResult,
): Promise<void> {
  const target = await prisma.callTarget.findUnique({ where: { id: targetId } });
  if (!target) return;
  const structured = toStructured(result);
  await persistResult({
    targetId,
    channel,
    phase,
    structured,
    transcript: result.transcript,
    summary: result.summary,
    recordingUrl: result.recordingUrl,
    durationSec: result.durationSec,
    existingOfferedSlots: target.offeredSlots,
    existingMissingInfo: target.missingInfo,
  });

  // Verification wall: the scheduler needs a one-time code the patient must read from email/SMS.
  // The browser session is held alive; store its token and pause for the patient.
  if (result.outcome === "verification_needed") {
    await prisma.callTarget.update({
      where: { id: targetId },
      data: { status: "awaiting_verification", channel, verificationId: result.verificationId, verificationContact: result.verificationContact },
    });
    return awaitVerification(target.sessionId);
  }

  // Deterministic auto-book: when a gather found slots within the acceptable window, WE pick the
  // FIRST one (page order) and book it — the model never chooses which slot.
  if (phase === "gather" && result.outcome === "options_collected" && (result.acceptableSlots?.length ?? 0) > 0) {
    return placeBookingCallback(targetId, result.acceptableSlots![0]);
  }

  await placeNextCall(target.sessionId);
}

/** Record a finished Vapi call (from the webhook) and advance the session. */
export async function recordCallResult(opts: {
  vapiCallId: string;
  transcript?: string;
  summary?: string;
  structuredData?: CallStructuredData;
  recordingUrl?: string;
  endedReason?: string;
  durationSec?: number;
}): Promise<void> {
  const target = await prisma.callTarget.findFirst({ where: { vapiCallId: opts.vapiCallId } });
  if (!target) return;

  const sd: CallStructuredData = opts.structuredData ?? {
    outcome: "failed",
    appointmentBooked: false,
    appointmentDateTime: "",
    confirmation: "",
    offeredSlots: [],
    missingInfo: [],
    notes: "",
  };
  // A successful warm transfer ends the call as "assistant-forwarded-call". The patient is now live
  // with the office, so this office is done from the AI's side — override to the "transferred"
  // outcome regardless of what the (pre-transfer) analysis guessed.
  if (opts.endedReason === "assistant-forwarded-call") {
    sd.outcome = "transferred";
    sd.missingInfo = [];
  }
  const phase = target.chosenSlot ? "book" : "gather";
  await persistResult({
    targetId: target.id,
    channel: (target.channel as ChannelType) ?? "voice",
    phase,
    structured: sd,
    transcript: opts.transcript,
    summary: opts.summary,
    recordingUrl: opts.recordingUrl,
    endedReason: opts.endedReason,
    durationSec: opts.durationSec,
    existingOfferedSlots: target.offeredSlots,
    existingMissingInfo: target.missingInfo,
  });
  await placeNextCall(target.sessionId);
}

/** Convert a normalized ChannelResult into the CallStructuredData shape stored/serialized. */
function toStructured(r: ChannelResult): CallStructuredData {
  return {
    outcome: r.outcome,
    appointmentBooked: r.outcome === "booked",
    appointmentDateTime: r.appointmentDateTime ?? "",
    confirmation: r.confirmation ?? "",
    offeredSlots: r.offeredSlots ?? [],
    missingInfo: r.missingInfo ?? [],
    notes: r.summary ?? "",
  };
}

/**
 * Terminal decision once no office attempt is pending:
 * booked → complete; else options collected → awaiting_choice; else info needed → awaiting_info;
 * else complete.
 */
export async function finalizeOrAwaitChoice(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { targets: true } });
  if (!session || session.status === "completed") return;

  if (session.targets.some((t) => t.status === "booked")) return completeSession(sessionId);

  // A warm transfer handed the call to the patient live — that office is done; wrap up the session.
  if (session.targets.some((t) => t.status === "transferred")) return completeSession(sessionId);

  if (session.targets.some((t) => t.status === "awaiting_verification")) return awaitVerification(sessionId);

  if (session.targets.some((t) => t.status === "awaiting_choice")) {
    if (session.status !== "awaiting_choice") {
      await prisma.session.update({ where: { id: sessionId }, data: { status: "awaiting_choice" } });
      const { sendChoiceRequestEmail } = await import("./email.js");
      await sendChoiceRequestEmail(sessionId).catch((e) => console.error("choice email failed", e));
      const { notifyChoiceNeeded } = await import("./push.js");
      await notifyChoiceNeeded(sessionId, "choice").catch((e) => console.error("choice push failed", e));
    }
    return;
  }

  if (session.targets.some((t) => t.status === "awaiting_info")) {
    if (session.status !== "awaiting_info") {
      await prisma.session.update({ where: { id: sessionId }, data: { status: "awaiting_info" } });
      const { sendInfoRequestEmail } = await import("./email.js");
      await sendInfoRequestEmail(sessionId).catch((e) => console.error("info email failed", e));
      const { notifyChoiceNeeded } = await import("./push.js");
      await notifyChoiceNeeded(sessionId, "info").catch((e) => console.error("info push failed", e));
    }
    return;
  }

  return completeSession(sessionId);
}

/** Booking callback after the patient picks a slot — re-uses the channel that gathered the options. */
export async function placeBookingCallback(targetId: string, slot: string): Promise<void> {
  const target = await prisma.callTarget.findUnique({
    where: { id: targetId },
    include: { session: true, results: { orderBy: { createdAt: "desc" } } },
  });
  if (!target) return;

  if ((await minutesUsed(target.sessionId)) >= target.session.minutesCap) {
    await prisma.callTarget.update({ where: { id: targetId }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(target.sessionId);
  }

  const patient = fromJson<PatientInfo>(target.session.patientInfo, EMPTY_PATIENT);
  const gather = target.results.find((r) => r.phase === "gather") ?? target.results[0];
  const offered = fromJson<string[]>(target.offeredSlots, []);
  const priorContext = [
    gather?.summary ? `Summary: ${gather.summary}` : "",
    offered.length ? `They offered: ${offered.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  await prisma.callTarget.update({ where: { id: targetId }, data: { chosenSlot: slot } });
  await prisma.session.update({ where: { id: target.sessionId }, data: { status: "in_progress" } });

  const fresh = await prisma.callTarget.findUnique({ where: { id: targetId } });
  await runCallback(target.sessionId, fresh!, target.session, patient, "book", slot, priorContext);
}

/** Info callback after the patient supplies required info — re-uses the gathering channel. */
export async function placeInfoCallback(targetId: string, answers: string): Promise<void> {
  const target = await prisma.callTarget.findUnique({
    where: { id: targetId },
    include: { session: true, results: { orderBy: { createdAt: "desc" } } },
  });
  if (!target) return;

  if ((await minutesUsed(target.sessionId)) >= target.session.minutesCap) {
    await prisma.callTarget.update({ where: { id: targetId }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(target.sessionId);
  }

  const patient = fromJson<PatientInfo>(target.session.patientInfo, EMPTY_PATIENT);
  patient.additionalInfo = [patient.additionalInfo, `PROVIDED: ${answers}`].filter(Boolean).join(" | ");

  const prior = target.results[0];
  const missing = fromJson<string[]>(target.missingInfo, []);
  const priorContext = [
    prior?.summary ? `Summary: ${prior.summary}` : "",
    missing.length ? `Earlier the office needed: ${missing.join("; ")}. The patient has now provided it.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  await prisma.session.update({ where: { id: target.sessionId }, data: { status: "in_progress" } });
  await runCallback(target.sessionId, target, target.session, patient, "gather", undefined, priorContext);
}

/** Pause the session for a one-time verification code and notify the patient (once). */
async function awaitVerification(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.status === "completed" || session.status === "awaiting_verification") return;
  await prisma.session.update({ where: { id: sessionId }, data: { status: "awaiting_verification" } });
  const { sendVerificationRequestEmail } = await import("./email.js");
  await sendVerificationRequestEmail(sessionId).catch((e) => console.error("verification email failed", e));
  const { notifyChoiceNeeded } = await import("./push.js");
  await notifyChoiceNeeded(sessionId, "verify").catch((e) => console.error("verification push failed", e));
}

/**
 * Patient supplied the one-time code → resume the held browser session, enter it, and confirm.
 * (Web channel only; the held session lives in-process from the original book attempt.)
 */
export async function submitVerification(targetId: string, code: string): Promise<void> {
  const target = await prisma.callTarget.findUnique({ where: { id: targetId }, include: { session: true } });
  if (!target || target.status !== "awaiting_verification" || !target.verificationId) return;

  if ((await minutesUsed(target.sessionId)) >= target.session.minutesCap) {
    await prisma.callTarget.update({ where: { id: targetId }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(target.sessionId);
  }

  await prisma.callTarget.update({ where: { id: targetId }, data: { status: "calling", calledAt: new Date() } });
  await prisma.session.update({ where: { id: target.sessionId }, data: { status: "in_progress" } });

  const { submitWebVerification } = await import("../channels/web.js");
  let result: ChannelResult;
  try {
    result = await submitWebVerification(target.verificationId, code);
  } catch (err) {
    result = { outcome: "failed", summary: `Verification failed: ${(err as Error).message}` };
  }
  await recordChannelResult(targetId, "web", "book", result);
}

/** Shared callback execution: route through the channel the target was handled by. */
async function runCallback(
  sessionId: string,
  target: NonNullable<Awaited<ReturnType<typeof prisma.callTarget.findUnique>>>,
  session: Parameters<typeof routeAndAttempt>[0]["session"],
  patient: PatientInfo,
  mode: "gather" | "book",
  chosenSlot: string | undefined,
  priorContext: string,
): Promise<void> {
  const channelType = (target.channel as ChannelType) ?? "voice";
  const channel = getChannel(channelType);
  if (!channel) {
    await prisma.callTarget.update({ where: { id: target.id }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(sessionId);
  }
  // Mark in-flight so the 60s worker tick won't re-enter this target mid-attempt (web runs sync).
  await prisma.callTarget.update({ where: { id: target.id }, data: { status: "calling", calledAt: new Date() } });
  const ctx: BookingContext = { target, session, patient, mode, chosenSlot, priorContext };
  let attempt;
  try {
    attempt = await channel.attempt(ctx);
  } catch (err) {
    console.error(`callback channel ${channelType} threw:`, err);
    await prisma.callTarget.update({ where: { id: target.id }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(sessionId);
  }
  if (attempt.kind === "pending") return; // webhook will advance
  if (attempt.kind === "unstarted") {
    await prisma.callTarget.update({ where: { id: target.id }, data: { status: "failed" } });
    return finalizeOrAwaitChoice(sessionId);
  }
  await recordChannelResult(target.id, channelType, mode === "book" ? "book" : "gather", attempt.result);
}

/** Mark a session completed and trigger the summary email. */
export async function completeSession(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.status === "completed") return;
  await prisma.session.update({ where: { id: sessionId }, data: { status: "completed" } });
  const { sendSummaryEmail } = await import("./email.js");
  await sendSummaryEmail(sessionId).catch((e) => console.error("summary email failed", e));
}
