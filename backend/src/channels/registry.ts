import type { BookingChannel, BookingContext, ChannelResult, ChannelType } from "./types.js";
import { voiceChannel } from "./voice.js";
import { webChannel } from "./web.js";
import { messagingChannel } from "./messaging.js";
import { fhirChannel, zocdocChannel, faxChannel } from "./scaffolds.js";

/**
 * Channels in priority order. Product fallback chain: web booking → phone call → email request.
 * detect() filters to what an office supports; the router tries them in this order, falling back
 * on failure. (fhir/zocdoc are scaffolds — detect=false — until partnerships land.)
 */
const CHANNELS: BookingChannel[] = [
  webChannel, // 1) online booking automation
  voiceChannel, // 2) phone call
  messagingChannel, // 3) email booking request
  fhirChannel, // (deferred)
  zocdocChannel, // (deferred)
  faxChannel, // (deferred)
];

/** Look up a specific channel adapter by type (used by callbacks to reuse the prior channel). */
export function getChannel(type: ChannelType): BookingChannel | undefined {
  return CHANNELS.find((c) => c.type === type);
}

/** Move the office's remembered preferred channel to the front, keeping the rest in priority order. */
export function prioritizeChannels<T extends { channel: { type: ChannelType } }>(supported: T[], preferred?: string | null): T[] {
  if (!preferred) return supported;
  const pref = supported.filter((d) => d.channel.type === preferred);
  if (!pref.length) return supported;
  return [...pref, ...supported.filter((d) => d.channel.type !== preferred)];
}

const PRIORITY: Record<ChannelType, number> = {
  web: 0,
  voice: 1,
  messaging: 2,
  fhir: 3,
  zocdoc: 4,
  fax: 5,
};

export interface RouteResult {
  channel: ChannelType;
  pending: boolean; // true => async channel started; result arrives via webhook
  result?: ChannelResult; // present for synchronous channels (web)
  triedChannels: ChannelType[];
}

/**
 * Detect supported channels, then attempt them in priority order:
 * - first channel that returns `pending` → return (await webhook)
 * - first `completed` with a usable outcome → return it
 * - `completed` with failed/no_availability, or `unstarted` → fall back to the next channel
 */
export async function routeAndAttempt(ctx: BookingContext): Promise<RouteResult> {
  const detections = await Promise.all(
    CHANNELS.map(async (c) => ({ channel: c, det: await safeDetect(c, ctx) })),
  );
  const supported = detections
    .filter((d) => d.det.supported)
    .sort((a, b) => PRIORITY[a.channel.type] - PRIORITY[b.channel.type] || b.det.confidence - a.det.confidence);

  // Use the office's remembered preferred method first (learned from a past successful booking), then
  // fall through the rest in the default priority order.
  const ordered = prioritizeChannels(supported, ctx.target.preferredChannel);

  const tried: ChannelType[] = [];
  let lastFailed: { channel: ChannelType; result: ChannelResult } | undefined;
  for (const { channel } of ordered) {
    tried.push(channel.type);
    let attempt;
    try {
      attempt = await channel.attempt(ctx);
    } catch (err) {
      console.error(`channel ${channel.type} threw during attempt:`, err);
      continue; // fall back
    }
    if (attempt.kind === "pending") return { channel: channel.type, pending: true, triedChannels: tried };
    if (attempt.kind === "unstarted") {
      console.error(`channel ${channel.type} unstarted: ${attempt.reason}`);
      continue; // fall back
    }
    // completed
    if (attempt.result.outcome === "failed" || attempt.result.outcome === "no_availability") {
      console.warn(`channel ${channel.type} returned ${attempt.result.outcome}: ${attempt.result.summary ?? ""}`);
      lastFailed = { channel: channel.type, result: attempt.result }; // keep detail in case nothing better follows
      continue;
    }
    return { channel: channel.type, pending: false, result: attempt.result, triedChannels: tried };
  }

  // Nothing succeeded — return the most recent completed (failed) result so its detail is preserved.
  if (lastFailed) return { channel: lastFailed.channel, pending: false, result: lastFailed.result, triedChannels: tried };
  return { channel: tried.at(-1) ?? "voice", pending: false, result: { outcome: "failed" }, triedChannels: tried };
}

async function safeDetect(c: BookingChannel, ctx: BookingContext) {
  try {
    return await c.detect(ctx);
  } catch (err) {
    console.error(`channel ${c.type} threw during detect:`, err);
    return { supported: false, confidence: 0 };
  }
}
