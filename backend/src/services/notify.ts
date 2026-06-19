// Channel-aware outreach dispatcher. One call fans a notification out to APNs push (always) AND to
// WhatsApp (when the user is verified, opted in, and inside Twilio's 24h business-initiated window).
// Outside the 24h window WhatsApp is skipped — the push already fired and the content waits in-app.
// This is the single emit point the worker ticks and the concierge call into.

import { prisma } from "../db.js";
import { sendPushToUser } from "./push.js";
import { sendWhatsApp } from "./whatsapp.js";

const WHATSAPP_WINDOW_MS = 24 * 3_600_000;

export interface NotifyOptions {
  title: string;
  body: string;
  /** Bypass the user's push/WhatsApp preference for safety-critical alerts (e.g. a missed critical dose). */
  force?: boolean;
  /** Deep-link hint (e.g. "actions"/"today") the app reads on tap to navigate to the right place. */
  link?: string;
}

/** Best-effort multi-channel notify. Never throws into the caller. */
export async function notifyUser(userId: string, opts: NotifyOptions): Promise<void> {
  const { title, body, force = false, link } = opts;

  // APNs push first (respects pushEnabled unless force) — mirrors prior behavior everywhere.
  await sendPushToUser(userId, title, body, force, link).catch((e) => console.error("notify push failed", e));

  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { whatsappPhone: true, whatsappVerified: true, whatsappEnabled: true, lastWhatsappInboundAt: true },
  });
  if (!u?.whatsappPhone || !u.whatsappVerified) return;
  if (u.whatsappEnabled === false && !force) return;
  // Business-initiated messages are only allowed within 24h of the user's last inbound message.
  const within = u.lastWhatsappInboundAt && Date.now() - u.lastWhatsappInboundAt.getTime() < WHATSAPP_WINDOW_MS;
  if (!within) return;
  await sendWhatsApp(u.whatsappPhone, `${title}\n${body}`).catch((e) => console.error("notify whatsapp failed", e));
}

/**
 * Notify the user on the channel a flow was initiated from, so a confirmation lands where they're
 * looking. `app` → push only (the in-app inbox Message is written by the caller). `whatsapp` → push +
 * WhatsApp. `null`/unknown → both (the legacy broadcast, for flows with no recorded origin).
 */
export async function notifyOnChannel(userId: string, originChannel: string | null, opts: NotifyOptions): Promise<void> {
  if (originChannel === "app") {
    await sendPushToUser(userId, opts.title, opts.body, opts.force ?? false, opts.link).catch((e) => console.error("notify push failed", e));
    return;
  }
  await notifyUser(userId, opts);
}
