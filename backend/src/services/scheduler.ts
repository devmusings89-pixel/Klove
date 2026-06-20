import { config } from "../config.js";

const BUSINESS_START_HOUR = 9; // 9:00 local
const BUSINESS_END_HOUR = 17; // 17:00 local

/** The raw Mon–Fri 9–17 check in a timezone (ignores the global enforce flag). */
function withinHours(timezone: string, date: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = Number(hourStr) % 24;

  const isWeekday = !["Sat", "Sun"].includes(weekday);
  return isWeekday && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

/**
 * Is `date` within Mon–Fri 9:00–17:00 in the given IANA timezone? Gated by config.enforceBusinessHours
 * (off by default) so the global call-placement gate is unchanged.
 */
export function isWithinBusinessHours(timezone: string, date: Date = new Date()): boolean {
  if (!config.enforceBusinessHours) return true;
  return withinHours(timezone, date);
}

/**
 * The first instant at/after `from` that's within the office's business hours, in its timezone. Used to
 * schedule call retries so we never re-dial an office while it's closed (e.g. a no-answer at 9pm waits
 * until the next morning rather than retrying at 9:15pm). Steps in 15-min increments, capped at ~8 days.
 */
export function nextBusinessStart(timezone: string, from: Date = new Date()): Date {
  const d = new Date(from);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (withinHours(timezone, d)) return d;
    d.setMinutes(d.getMinutes() + 15);
  }
  return d;
}
