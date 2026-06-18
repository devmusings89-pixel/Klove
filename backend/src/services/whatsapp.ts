// WhatsApp transport dispatch. The concierge agent calls sendWhatsApp() and is agnostic to how the
// message goes out. Two transports:
//   - baileys (default): logs in as a real WhatsApp account (free, no 24h window, native media).
//   - twilio: the official Business API (per-message cost, 24h proactive window).
// Pick via WHATSAPP_TRANSPORT. Inbound for Baileys arrives on its socket (whatsapp-baileys.ts); for
// Twilio it arrives on POST /webhooks/whatsapp — both funnel into handleWhatsAppInbound.

import { createHmac, timingSafeEqual } from "node:crypto";
import { toE164 } from "./phone.js";
import { sendViaBaileys, isBaileysReady } from "./whatsapp-baileys.js";

export type WhatsAppTransport = "baileys" | "twilio";
export function whatsappTransport(): WhatsAppTransport {
  return (process.env.WHATSAPP_TRANSPORT ?? "baileys").toLowerCase() === "twilio" ? "twilio" : "baileys";
}

function twilioCfg() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    from: process.env.TWILIO_WHATSAPP_FROM ?? "",
  };
}

/** True when the active transport can actually deliver (Baileys connected, or Twilio configured). */
export function whatsappEnabled(): boolean {
  if (whatsappTransport() === "baileys") return isBaileysReady();
  const t = twilioCfg();
  return Boolean(t.accountSid && t.authToken && t.from);
}

/** True when the Twilio auth token is set — i.e. inbound webhook signatures can be verified. */
export function twilioAuthConfigured(): boolean {
  return Boolean(twilioCfg().authToken);
}

/**
 * Send one WhatsApp message via the active transport. Normalizes the recipient to E.164 first;
 * returns false if the number is unusable or delivery is rejected so callers can degrade gracefully.
 */
export async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  const e164 = toE164(to);
  if (!e164) {
    console.warn(`[whatsapp] unusable phone number "${to}"`);
    return false;
  }
  return whatsappTransport() === "baileys" ? sendViaBaileys(e164, body) : sendViaTwilio(e164, body);
}

/** Twilio Business API send (fallback transport). Mock-logs when Twilio creds are absent. */
async function sendViaTwilio(e164: string, body: string): Promise<boolean> {
  const twilio = twilioCfg();
  if (!(twilio.accountSid && twilio.authToken && twilio.from)) {
    console.log(`[whatsapp mock] to=${e164}\n${body}`);
    return true;
  }
  const params = new URLSearchParams({ To: `whatsapp:${e164}`, From: `whatsapp:${twilio.from}`, Body: body });
  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    console.error(`Twilio WhatsApp send failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return false;
  }
  return true;
}

/**
 * Verify a Twilio inbound webhook signature (X-Twilio-Signature):
 *   base64( HMAC-SHA1( authToken, fullUrl + sorted(key+value for each POST param) ) ).
 */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  const authToken = twilioCfg().authToken;
  if (!signature || !authToken) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
