import type { CallResult, CallTarget, Session } from "@prisma/client";
import { fromJson } from "../services/json.js";
import { decryptField } from "../services/crypto.js";
import type { CallStructuredData, PatientInfo } from "../types.js";

type FullTarget = CallTarget & { results: CallResult[] };
type FullSession = Session & { targets: FullTarget[] };

function serializeResult(r: CallResult) {
  return {
    phase: r.phase,
    channel: r.channel,
    transcript: decryptField(r.transcript),
    summary: decryptField(r.summary),
    structuredData: fromJson<CallStructuredData | null>(r.structuredData, null),
    recordingUrl: r.recordingUrl,
    endedReason: r.endedReason,
    durationSec: r.durationSec,
    createdAt: r.createdAt,
  };
}

/** Shape a session (with targets + results) into the JSON the iOS client consumes. */
export function serializeSession(s: FullSession) {
  // Cross-office options the patient can pick from when status is awaiting_choice.
  const aggregatedOptions = s.targets.flatMap((t) =>
    fromJson<string[]>(t.offeredSlots, []).map((slot) => ({
      targetId: t.id,
      officeName: t.officeName,
      slot,
    })),
  );

  // Per-office info requests when status is awaiting_info.
  const infoRequests = s.targets
    .map((t) => ({ targetId: t.id, officeName: t.officeName, missingInfo: fromJson<string[]>(t.missingInfo, []) }))
    .filter((r) => r.missingInfo.length > 0);

  // Per-office verification requests when status is awaiting_verification (one-time code entry).
  const verificationRequests = s.targets
    .filter((t) => t.status === "awaiting_verification")
    .map((t) => ({ targetId: t.id, officeName: t.officeName, contact: t.verificationContact, slot: t.chosenSlot }));

  return {
    id: s.id,
    status: s.status,
    patientInfo: fromJson<PatientInfo | null>(s.patientInfo, null),
    maxCalls: s.maxCalls,
    minutesCap: s.minutesCap,
    stopWhenBooked: s.stopWhenBooked,
    createdAt: s.createdAt,
    aggregatedOptions,
    infoRequests,
    verificationRequests,
    targets: s.targets.map((t) => {
      const ordered = [...t.results].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return {
        id: t.id,
        officeName: t.officeName,
        phoneNumber: t.phoneNumber,
        timezone: t.timezone,
        order: t.order,
        status: t.status,
        channel: t.channel,
        website: t.website,
        attempts: t.attempts,
        nextAttemptAt: t.nextAttemptAt,
        maxAttempts: s.maxCalls,
        callbackHours: t.callbackHours,
        offeredSlots: fromJson<string[]>(t.offeredSlots, []),
        chosenSlot: t.chosenSlot,
        missingInfo: fromJson<string[]>(t.missingInfo, []),
        verificationContact: t.verificationContact,
        // `result` = latest call (back-compat for existing UI); `results` = full history.
        result: ordered.length ? serializeResult(ordered.at(-1)!) : null,
        results: ordered.map(serializeResult),
      };
    }),
  };
}
