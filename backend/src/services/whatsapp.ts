// WhatsApp channel for Klove's concierge agent. Twilio's WhatsApp uses the SAME Messages API as SMS
// (see sms.ts) — only the To/From carry a "whatsapp:" prefix. We mirror sms.ts: real send when Twilio
// creds + a WhatsApp sender are present, otherwise a mock log so the pipeline is exercisable in dev.
//
// Config is read straight from process.env here (like sms.ts) so this channel can be added without
// touching the central config. Inbound messages arrive at POST /webhooks/whatsapp and are verified
// with verifyTwilioSignature() below.

import { createHmac, timingSafeEqual } from "node:crypto";
import { toE164 } from "./phone.js";

// Read env lazily (not at module load) so the channel can be configured/toggled at runtime and in
// tests. The WhatsApp sender (`from`) is E.164, e.g. "+14155238886" — no "whatsapp:" prefix here.
function twilioCfg() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    from: process.env.TWILIO_WHATSAPP_FROM ?? "",
  };
}

/** True when Twilio WhatsApp is configured; otherwise WhatsApp runs in mock mode (logs only). */
export function whatsappEnabled(): boolean {
  const t = twilioCfg();
  return Boolean(t.accountSid && t.authToken && t.from);
}

/** True when the Twilio auth token is set — i.e. inbound webhook signatures can be verified. */
export function twilioAuthConfigured(): boolean {
  return Boolean(twilioCfg().authToken);
}

/**
 * Send one WhatsApp message (or log it in mock mode). Normalizes the recipient to E.164 first;
 * returns false if the number is unusable or delivery is rejected so callers can degrade gracefully.
 *
 * Note: Twilio only allows free-form business-initiated messages within 24h of the user's last
 * inbound message. Outside that window a pre-approved template is required — callers that send
 * proactively must gate on that window (see services/notify.ts). This function does not enforce it.
 */
export async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  const e164 = toE164(to);
  if (!e164) {
    console.warn(`[whatsapp] unusable phone number "${to}"`);
    return false;
  }

  if (!whatsappEnabled()) {
    console.log(`[whatsapp mock] to=${e164}\n${body}`);
    return true;
  }

  const twilio = twilioCfg();
  const params = new URLSearchParams({ To: `whatsapp:${e164}`, From: `whatsapp:${twilio.from}`, Body: body });
  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`Twilio WhatsApp send failed: HTTP ${res.status} ${detail}`);
    return false;
  }
  console.log(`WhatsApp sent to ${e164}`);
  return true;
}

/**
 * Verify a Twilio inbound webhook signature (X-Twilio-Signature). Twilio's scheme:
 *   signature = base64( HMAC-SHA1( authToken, fullUrl + sorted(key+value for each POST param) ) )
 * Keys are sorted alphabetically and concatenated with their values, no separators, appended to the
 * exact request URL. Returns true when the computed signature matches the header in constant time.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  const authToken = twilioCfg().authToken;
  if (!signature || !authToken) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
