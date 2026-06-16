import { prisma } from "../db.js";
import { fromJson } from "../services/json.js";
import { sendRawEmail } from "../services/email.js";
import type { BookingChannel, BookingContext, ChannelAttempt } from "./types.js";

/** Escape text for HTML email. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Email channel — last-resort fallback. Emails the office a booking request with the patient's
 * details. There's no instant confirmation (the office follows up), so the outcome is
 * "request_sent". Supported when an office email is available (target.channelHints.email).
 */
export const messagingChannel: BookingChannel = {
  type: "messaging",

  async detect(ctx) {
    const email = fromJson<{ email?: string }>(ctx.target.channelHints, {}).email;
    return email ? { supported: true, confidence: 0.4 } : { supported: false, confidence: 0 };
  },

  async attempt(ctx): Promise<ChannelAttempt> {
    const email = fromJson<{ email?: string }>(ctx.target.channelHints, {}).email;
    if (!email) return { kind: "unstarted", reason: "no office email" };

    await prisma.callTarget.update({ where: { id: ctx.target.id }, data: { channel: "messaging" } });

    const p = ctx.patient;
    const lines = [
      `Patient: ${p.name}`,
      p.dob ? `Date of birth: ${p.dob}` : "",
      p.reason ? `Reason for visit: ${p.reason}` : "",
      p.insurance ? `Insurance: ${p.insurance}` : "",
      p.preferredTimes ? `Preferred times: ${p.preferredTimes}` : "",
      p.acceptableWindow ? `Acceptable window: ${p.acceptableWindow}` : "",
      ctx.chosenSlot ? `Requested slot: ${ctx.chosenSlot}` : "",
      p.patientPhone ? `Callback phone: ${p.patientPhone}` : "",
      p.additionalInfo ? `Additional info: ${p.additionalInfo}` : "",
    ].filter(Boolean);

    const html = `
      <p>Hello ${esc(ctx.target.officeName)},</p>
      <p>I'd like to request an appointment. My details:</p>
      <ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      <p>Please reply or call me back to confirm a time. Thank you.</p>`;

    try {
      await sendRawEmail(email, `Appointment request — ${p.name}`, html);
    } catch (err) {
      return { kind: "completed", result: { outcome: "failed", summary: `Email send failed: ${(err as Error).message}` } };
    }

    return {
      kind: "completed",
      result: {
        outcome: "request_sent",
        summary: `Emailed an appointment request to ${email}. The office will follow up to confirm.`,
        transcript: `To: ${email}\n${lines.join("\n")}`,
      },
    };
  },
};
