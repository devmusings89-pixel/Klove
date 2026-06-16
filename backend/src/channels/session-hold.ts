import type { WebSession } from "./web-session.js";
import type { SchedulerAdapter } from "./adapters/types.js";
import type { BookingContext } from "./types.js";

/**
 * In-process registry of browser sessions paused mid-booking, waiting for the patient to supply a
 * one-time verification code. The browser stays alive (logged into the flow) so we can enter the
 * code and confirm without redoing the funnel.
 *
 * Dev scope: single-process Map with a TTL. In production this becomes the managed browser fleet
 * (M1b) — same hold/resume contract, durable across workers.
 */
interface Held {
  session: WebSession;
  adapter: SchedulerAdapter;
  ctx: BookingContext;
  timer: NodeJS.Timeout;
}

const HOLD_TTL_MS = 12 * 60 * 1000; // patient has 12 min to enter the code before we give up
const held = new Map<string, Held>();

export function holdSession(id: string, entry: { session: WebSession; adapter: SchedulerAdapter; ctx: BookingContext }): void {
  release(id);
  const timer = setTimeout(() => {
    const h = held.get(id);
    if (h) {
      h.session.close().catch(() => {});
      held.delete(id);
      console.log(`[session-hold] ${id} expired without a verification code; browser closed.`);
    }
  }, HOLD_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  held.set(id, { ...entry, timer });
}

/** Remove and return a held session (caller is responsible for closing it). */
export function takeSession(id: string): Held | undefined {
  const h = held.get(id);
  if (h) {
    clearTimeout(h.timer);
    held.delete(id);
  }
  return h;
}

function release(id: string): void {
  const h = held.get(id);
  if (h) {
    clearTimeout(h.timer);
    h.session.close().catch(() => {});
    held.delete(id);
  }
}
