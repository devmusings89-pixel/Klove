import type { BookingChannel, ChannelType } from "./types.js";

/**
 * Deferred channels: the interface is wired so the registry already knows about them, but
 * detect() returns false until the relevant integration/partnership lands. When ready, fill in
 * detect() (check channelHints / config) and attempt(), and they light up with no router change.
 */
function deferred(type: ChannelType, note: string): BookingChannel {
  return {
    type,
    async detect() {
      return { supported: false, confidence: 0 };
    },
    async attempt() {
      return { kind: "unstarted", reason: `${type} not enabled: ${note}` };
    },
  };
}

// FHIR/EHR (Epic Appointment.$find/$book, Cerner, athenahealth) — needs SMART app registration + per-org onboarding.
export const fhirChannel = deferred("fhir", "SMART-on-FHIR app registration + per-org onboarding required");

// Zocdoc for Developers — needs a developer partnership + provider directory.
export const zocdocChannel = deferred("zocdoc", "Zocdoc developer partnership required");

// e-fax — later (needs an e-fax provider).
export const faxChannel = deferred("fax", "fax channel not yet enabled");
