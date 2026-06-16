import type { BookingContext, ChannelResult } from "./types.js";

/**
 * Deterministic mock outcome driven by sentinels in the patient's additionalInfo, so every path
 * is testable without live services (shared by the voice and web channels in mock mode):
 * - book mode, or additionalInfo contains "PROVIDED" → booked
 * - additionalInfo contains "NEEDINFO"               → info_needed
 * - acceptableWindow set                             → options_collected
 * - otherwise                                        → booked
 */
export function mockResult(ctx: BookingContext, label: string): ChannelResult {
  const info = ctx.patient.additionalInfo ?? "";
  const kind =
    ctx.mode === "book" || info.includes("PROVIDED")
      ? "booked"
      : info.includes("NEEDINFO")
        ? "info"
        : ctx.patient.acceptableWindow
          ? "options"
          : "booked";

  if (kind === "options") {
    return {
      outcome: "options_collected",
      offeredSlots: ["Tue Jun 23, 9:00 AM", "Wed Jun 24, 2:30 PM", "Fri Jun 26, 11:15 AM"],
      missingInfo: [],
      summary: `Mock ${label}: preferred times unavailable; offered alternatives.`,
      transcript: `[mock ${label}] Office offered 3 alternative slots.`,
      durationSec: 60,
    };
  }
  if (kind === "info") {
    return {
      outcome: "info_needed",
      offeredSlots: [],
      missingInfo: ["insurance member ID"],
      summary: `Mock ${label}: blocked on insurance member ID.`,
      transcript: `[mock ${label}] Office requires the insurance member ID before booking.`,
      durationSec: 60,
    };
  }
  return {
    outcome: "booked",
    appointmentDateTime: ctx.chosenSlot ?? "2026-06-20T15:30:00",
    confirmation: "MOCK-12345",
    offeredSlots: [],
    missingInfo: [],
    summary: `Mock ${label}: appointment booked.`,
    transcript: `[mock ${label}] Appointment confirmed${ctx.chosenSlot ? ` for ${ctx.chosenSlot}` : ""}.`,
    durationSec: 90,
  };
}
