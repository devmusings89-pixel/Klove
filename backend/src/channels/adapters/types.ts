import type { WebSession } from "../web-session.js";
import type { BookingContext, ChannelResult } from "../types.js";

/**
 * A SchedulerAdapter knows how to drive ONE family of booking sites. The web channel picks the
 * best-matching adapter for a URL (deterministic platform adapters first, generic LLM agent last).
 *
 * - `run` handles ctx.mode: "gather" enumerates availability; "book" confirms ctx.chosenSlot.
 * - When a site requires a one-time code the patient must read from their email/SMS, `run` returns
 *   outcome "verification_needed"; the web channel HOLDS the live session and later calls
 *   `submitVerification` with the code the patient supplied.
 */
export interface SchedulerAdapter {
  name: string;
  /** Does this adapter handle the given booking URL? (host/path match) */
  matches(url: string): boolean;
  /** Drive the flow for the current mode. The session is already started at the booking URL. */
  run(session: WebSession, ctx: BookingContext): Promise<ChannelResult>;
  /** Resume a held session after the patient supplies a verification code (book mode only). */
  submitVerification?(session: WebSession, ctx: BookingContext, code: string): Promise<ChannelResult>;
}
