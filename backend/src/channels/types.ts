import type { CallTarget, Session } from "@prisma/client";
import type { CallOutcome, PatientInfo } from "../types.js";

export type ChannelType = "voice" | "web" | "fhir" | "zocdoc" | "messaging" | "fax";

/** Everything a channel needs to attempt a booking for one office. */
export interface BookingContext {
  target: CallTarget;
  session: Session;
  patient: PatientInfo;
  mode: "gather" | "book";
  chosenSlot?: string; // book mode: the slot to confirm
  priorContext?: string; // continuity summary from a prior attempt
}

/** Normalized result every channel returns — same shape across voice/web/fhir/etc. */
export interface ChannelResult {
  outcome: CallOutcome; // booked | options_collected | info_needed | no_availability | failed
  appointmentDateTime?: string;
  confirmation?: string;
  offeredSlots?: string[]; // ALL available slots, in page order
  acceptableSlots?: string[]; // subset of offeredSlots within the acceptable window, in page order
  missingInfo?: string[];
  // verification_needed: token to resume the held browser session + where the code was sent.
  verificationId?: string;
  verificationContact?: string; // e.g. "your email" / "your phone"
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  durationSec?: number;
}

/**
 * Outcome of attempting a channel:
 * - completed: a synchronous channel (web) finished and produced a result.
 * - pending: an async channel (voice) started; the result arrives later (webhook) → recordCallResult.
 * - unstarted: the channel couldn't even begin (no usable contact, immediate error) → fall back.
 */
export type ChannelAttempt =
  | { kind: "completed"; result: ChannelResult }
  | { kind: "pending" }
  | { kind: "unstarted"; reason: string };

export interface BookingChannel {
  type: ChannelType;
  /** Can this channel serve this office? confidence breaks ties within the priority order. */
  detect(ctx: BookingContext): Promise<{ supported: boolean; confidence: number }>;
  /** Attempt to book (or gather / confirm a chosen slot). */
  attempt(ctx: BookingContext): Promise<ChannelAttempt>;
}
