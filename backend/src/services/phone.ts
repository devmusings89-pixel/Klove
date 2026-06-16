/**
 * Normalize a user-entered phone number to E.164 (what Vapi/telephony requires).
 * Handles common US formats; returns null if it can't produce a plausible E.164 number.
 *
 *   "2063518641"      -> "+12063518641"
 *   "(206) 351-8641"  -> "+12063518641"
 *   "1 206 351 8641"  -> "+12063518641"
 *   "+12063518641"    -> "+12063518641"
 *   "+44 20 7946 0000"-> "+442079460000"
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Already E.164-ish: keep leading +, strip the rest of the non-digits.
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`; // US/Canada without country code
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`; // US/Canada with 1
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`; // assume already has country code
  return null;
}
