import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { enabled } from "../config.js";
import { lookupWebsite } from "../services/lookup.js";
import { mockResult } from "./mock.js";
import { WebSession } from "./web-session.js";
import { pickAdapter } from "./adapters/index.js";
import { reconWithSession } from "./adapters/generic.js";
import { holdSession, takeSession } from "./session-hold.js";
import type { BookingChannel, BookingContext, ChannelAttempt, ChannelResult } from "./types.js";

/**
 * Web channel — drives the office's online booking flow in a real browser. Picks a deterministic
 * platform adapter (e.g. patientsreach) when one matches the URL, else the generic LLM agent.
 * Synchronous: attempt() runs to completion, EXCEPT the verification wall, where it returns
 * "verification_needed" and HOLDS the live session for the patient to supply a one-time code.
 * In mock mode (web disabled) it returns a synthesized result.
 */
export const webChannel: BookingChannel = {
  type: "web",

  async detect(ctx) {
    if (ctx.target.website) return { supported: true, confidence: 0.8 };
    const found = await lookupWebsite(ctx.target.officeName);
    if (found) {
      await prisma.callTarget.update({ where: { id: ctx.target.id }, data: { website: found } });
      return { supported: true, confidence: 0.5 };
    }
    return { supported: false, confidence: 0 };
  },

  async attempt(ctx): Promise<ChannelAttempt> {
    const website = ctx.target.website ?? (await lookupWebsite(ctx.target.officeName));
    if (!website) return { kind: "unstarted", reason: "no booking website" };

    await prisma.callTarget.update({ where: { id: ctx.target.id }, data: { channel: "web", website } });

    if (!enabled.web()) {
      return { kind: "completed", result: mockResult(ctx, "web") };
    }

    const adapter = pickAdapter(website);
    const session = new WebSession();
    try {
      await session.start(website);
      const result = await adapter.run(session, ctx);

      // Verification wall: keep the browser alive so the patient's code can be entered later.
      if (result.outcome === "verification_needed" && adapter.submitVerification) {
        const verificationId = randomUUID();
        holdSession(verificationId, { session, adapter, ctx });
        return { kind: "completed", result: { ...result, verificationId } };
      }

      await session.close();
      return { kind: "completed", result };
    } catch (err) {
      await session.close();
      console.error(`web adapter (${adapter.name}) failed for ${website}:`, err);
      return { kind: "completed", result: { outcome: "failed", summary: `Web agent error: ${(err as Error).message}` } };
    }
  },
};

/**
 * Resume a held session after the patient supplies a verification code: enter it, confirm, and
 * return the final result. Closes the browser when done.
 */
export async function submitWebVerification(verificationId: string, code: string): Promise<ChannelResult> {
  const held = takeSession(verificationId);
  if (!held) return { outcome: "failed", summary: "The verification session expired. Please try booking again." };
  try {
    if (!held.adapter.submitVerification) {
      return { outcome: "failed", summary: "This booking flow does not support code verification." };
    }
    return await held.adapter.submitVerification(held.session, held.ctx, code);
  } catch (err) {
    return { outcome: "failed", summary: `Verification failed: ${(err as Error).message}` };
  } finally {
    await held.session.close();
  }
}

/** Read-only recon of a booking site — reports the flow, Saturday availability, and required fields. */
export async function reconWebsite(website: string, patientStatus = "new"): Promise<ChannelResult> {
  const ctx: BookingContext = {
    target: {} as BookingContext["target"],
    session: {} as BookingContext["session"],
    patient: { name: "", dob: "", reason: "", insurance: "", preferredTimes: "", acceptableWindow: "", additionalInfo: "", patientPhone: "", patientEmail: "", patientStatus },
    mode: "gather",
  };
  const session = new WebSession();
  try {
    await session.start(website);
    return await reconWithSession(session, ctx);
  } finally {
    await session.close();
  }
}
