import { prisma } from "../db.js";
import { enabled } from "../config.js";
import { toE164 } from "../services/phone.js";
import { lookupPhoneNumber } from "../services/lookup.js";
import { createCall } from "../services/vapi.js";
import { mockResult } from "./mock.js";
import type { BookingChannel, BookingContext, ChannelAttempt } from "./types.js";

/**
 * Voice channel — wraps the Vapi outbound call. Asynchronous in live mode: attempt() places the
 * call and returns `pending`; the real result arrives via the Vapi webhook (recordCallResult).
 * In mock mode it returns a synthesized `completed` result.
 */
export const voiceChannel: BookingChannel = {
  type: "voice",

  async detect(ctx) {
    // Supported if we have, or can look up, a phone number.
    if (ctx.target.phoneNumber) return { supported: true, confidence: 0.9 };
    const looked = await lookupPhoneNumber(ctx.target.officeName);
    return looked ? { supported: true, confidence: 0.6 } : { supported: false, confidence: 0 };
  },

  async attempt(ctx): Promise<ChannelAttempt> {
    let phone = ctx.target.phoneNumber;
    if (!phone) phone = await lookupPhoneNumber(ctx.target.officeName);
    phone = toE164(phone);
    if (!phone) return { kind: "unstarted", reason: "no valid phone number" };

    // Persist the normalized number + channel.
    await prisma.callTarget.update({
      where: { id: ctx.target.id },
      data: { phoneNumber: phone, channel: "voice" },
    });

    // Mock mode: synthesize a result synchronously.
    if (!enabled.vapi()) {
      return { kind: "completed", result: mockResult(ctx, "voice") };
    }

    // Live: place the call; result arrives via webhook → recordCallResult.
    try {
      const { vapiCallId } = await createCall({
        customerNumber: phone,
        patient: ctx.patient,
        mode: ctx.mode,
        chosenSlot: ctx.chosenSlot,
        priorContext: ctx.priorContext,
      });
      await prisma.callTarget.update({
        where: { id: ctx.target.id },
        data: { status: "calling", calledAt: new Date(), vapiCallId },
      });
      return { kind: "pending" };
    } catch (err) {
      return { kind: "unstarted", reason: `Vapi createCall failed: ${(err as Error).message}` };
    }
  },
};
