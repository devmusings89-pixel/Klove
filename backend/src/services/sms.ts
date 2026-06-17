// SMS channel for Klove (member invites). Mirrors email.ts: real send when Twilio creds are present,
// otherwise a mock log so the pipeline is exercisable in dev. We hand-roll the Twilio REST call
// (no SDK dependency) — a single POST to the Messages API with HTTP Basic auth.
//
// Config is read straight from process.env here rather than from config.ts so this channel can be
// added without touching the central config (which is owned elsewhere). The shape mirrors the other
// `enabled.*()` gates in config.ts.

import { toE164 } from "./phone.js";

const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  // Either a from-number (E.164) or a Messaging Service SID may be configured.
  from: process.env.TWILIO_FROM_NUMBER ?? "",
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
};

/** True when Twilio is configured; otherwise SMS runs in mock mode (logs only). */
export function smsEnabled(): boolean {
  return Boolean(twilio.accountSid && twilio.authToken && (twilio.from || twilio.messagingServiceSid));
}

/**
 * Send one SMS (or log it in mock mode). Normalizes the recipient to E.164 first; returns false if
 * the number is unusable so callers can surface "couldn't text" without throwing.
 */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const e164 = toE164(to);
  if (!e164) {
    console.warn(`[sms] unusable phone number "${to}"`);
    return false;
  }

  if (!smsEnabled()) {
    console.log(`[sms mock] to=${e164}\n${body}`);
    return true;
  }

  const params = new URLSearchParams({ To: e164, Body: body });
  if (twilio.messagingServiceSid) params.set("MessagingServiceSid", twilio.messagingServiceSid);
  else params.set("From", twilio.from);

  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`Twilio SMS send failed: HTTP ${res.status} ${detail}`);
    throw new Error(`Twilio SMS send failed: HTTP ${res.status}`);
  }
  console.log(`SMS sent to ${e164}`);
  return true;
}
