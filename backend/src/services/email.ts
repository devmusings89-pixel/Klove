import { Resend } from "resend";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";
import { fromJson } from "./json.js";
import type { CallStructuredData } from "../types.js";

/** Escape user/transcript text before embedding in HTML email. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Public wrapper to send a raw email (used by the email booking channel). */
export async function sendRawEmail(to: string, subject: string, html: string): Promise<void> {
  return sendEmail(to, subject, html);
}

/** Send one HTML email (or log it in mock mode). */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!enabled.resend()) {
    console.log(`[email mock] to=${to} subject="${subject}"\n${html}`);
    return;
  }
  const resend = new Resend(config.resend.apiKey);
  const { data, error } = await resend.emails.send({ from: config.resend.from, to, subject, html });
  if (error) {
    console.error("Resend send failed:", error);
    throw new Error(`Resend send failed: ${error.message ?? JSON.stringify(error)}`);
  }
  console.log(`Email sent to ${to} (id: ${data?.id})`);
}

/** Send the requesting user a per-office summary of the session results. */
export async function sendSummaryEmail(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true, targets: { orderBy: { order: "asc" }, include: { results: { orderBy: { createdAt: "asc" } } } } },
  });
  if (!session) return;

  const rows = session.targets.map((t) => {
    const latest = t.results.at(-1);
    const sd = fromJson<CallStructuredData | null>(latest?.structuredData, null);
    const outcome = sd?.appointmentBooked
      ? `✅ Booked — ${escapeHtml(sd.appointmentDateTime)}${sd.confirmation ? ` (conf: ${escapeHtml(sd.confirmation)})` : ""}`
      : sd?.outcome === "transferred"
        ? `📞 We connected you with the office to finish booking`
        : sd?.outcome === "request_sent"
          ? `📧 Booking request emailed — the office will follow up`
          : `❌ ${escapeHtml(t.status)}`;
    return `<tr><td><b>${escapeHtml(t.officeName)}</b></td><td>${outcome}</td></tr>`;
  });

  // One transcript block per call (gather + booking callback both shown), labeled by phase.
  const transcripts = session.targets.flatMap((t) =>
    t.results
      .filter((r) => r.transcript)
      .map((r) => {
        const dur = r.durationSec ? ` · ${r.durationSec}s` : "";
        const phase = r.phase === "book" ? " (callback)" : r.phase === "gather" ? " (initial)" : "";
        return `
          <h3 style="margin-bottom:4px">${escapeHtml(t.officeName)}${phase}${dur}</h3>
          ${r.summary ? `<p style="margin:4px 0;color:#555">${escapeHtml(r.summary)}</p>` : ""}
          <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f5f5f7;padding:12px;border-radius:8px">${escapeHtml(
            r.transcript!,
          )}</pre>`;
      }),
  );

  const html = `
    <h2>Your Klove appointment results</h2>
    <table cellpadding="8" style="border-collapse:collapse">${rows.join("")}</table>
    ${transcripts.length ? `<h2 style="margin-top:24px">Call transcripts</h2>${transcripts.join("")}` : ""}`;

  if (session.user.email) await sendEmail(session.user.email, "Your Klove appointment results", html);
}

/** Ask the patient to pick a time when no office could auto-book within their window. */
export async function sendChoiceRequestEmail(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true, targets: { orderBy: { order: "asc" } } },
  });
  if (!session) return;

  const blocks = session.targets
    .map((t) => ({ t, slots: fromJson<string[]>(t.offeredSlots, []) }))
    .filter(({ slots }) => slots.length > 0)
    .map(
      ({ t, slots }) => `
        <h3 style="margin-bottom:4px">${escapeHtml(t.officeName)}</h3>
        <ul>${slots.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`,
    );

  const html = `
    <h2>Your preferred times weren't available</h2>
    <p>Here are the times these offices offered. Open the Klove app to choose one, and we'll call back to book it.</p>
    ${blocks.join("")}`;

  if (session.user.email) await sendEmail(session.user.email, "Choose your appointment time", html);
}

/** Ask the patient to supply information the office required before it can book. */
export async function sendInfoRequestEmail(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true, targets: { orderBy: { order: "asc" } } },
  });
  if (!session) return;

  const blocks = session.targets
    .map((t) => ({ t, missing: fromJson<string[]>(t.missingInfo, []) }))
    .filter(({ missing }) => missing.length > 0)
    .map(
      ({ t, missing }) => `
        <h3 style="margin-bottom:4px">${escapeHtml(t.officeName)}</h3>
        <ul>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`,
    );

  const html = `
    <h2>The office needs a bit more information</h2>
    <p>To finish booking, these offices asked for details we didn't have. Open the Klove app to provide them, and we'll call back to complete the booking.</p>
    ${blocks.join("")}`;

  if (session.user.email) await sendEmail(session.user.email, "More info needed to book your appointment", html);
}

/** Tell the patient an online scheduler sent them a one-time code they need to enter to finish. */
export async function sendVerificationRequestEmail(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true, targets: { orderBy: { order: "asc" } } },
  });
  if (!session) return;

  const blocks = session.targets
    .filter((t) => t.status === "awaiting_verification")
    .map(
      (t) => `
        <h3 style="margin-bottom:4px">${escapeHtml(t.officeName)}</h3>
        <p style="margin:4px 0">We're almost done booking${t.chosenSlot ? ` <b>${escapeHtml(t.chosenSlot)}</b>` : ""}. ${escapeHtml(t.officeName)}'s scheduler sent a one-time code to ${escapeHtml(t.verificationContact || "your email or phone")}.</p>`,
    );

  const html = `
    <h2>Enter your booking verification code</h2>
    <p>Check ${escapeHtml(session.targets.find((t) => t.status === "awaiting_verification")?.verificationContact || "your email or phone")} for a code from the office, then open the Klove app and enter it to finish booking.</p>
    ${blocks.join("")}
    <p style="color:#888;font-size:13px">The code expires quickly, so please enter it soon.</p>`;

  if (session.user.email) await sendEmail(session.user.email, "Enter your booking code to finish", html);
}
