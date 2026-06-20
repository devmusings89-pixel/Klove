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

const DEFAULT_DAYS = ["mon", "tue", "wed", "thu", "fri"];

/** Is `date` within a custom open–close window on the given days, in the timezone? */
function withinWindow(timezone: string, date: Date, openHour: number, closeHour: number, days: string[]): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(date);
  const weekday = (parts.find((p) => p.type === "weekday")?.value ?? "").slice(0, 3).toLowerCase();
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return days.includes(weekday) && hour >= openHour && hour < closeHour;
}

/**
 * The first instant at/after `from` that falls within the given open hours/days, in the office's
 * timezone — so a retry is never placed while the office is closed. Defaults to Mon–Fri 9–17 when the
 * office's specific hours aren't known. Steps in 15-min increments, capped at ~8 days.
 */
export function nextWithinHours(
  timezone: string,
  from: Date = new Date(),
  openHour: number = BUSINESS_START_HOUR,
  closeHour: number = BUSINESS_END_HOUR,
  days: string[] = DEFAULT_DAYS,
): Date {
  const dayset = (days.length ? days : DEFAULT_DAYS).map((d) => d.slice(0, 3).toLowerCase());
  const open = Number.isFinite(openHour) ? openHour : BUSINESS_START_HOUR;
  const close = Number.isFinite(closeHour) && closeHour > open ? closeHour : BUSINESS_END_HOUR;
  const d = new Date(from);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (withinWindow(timezone, d, open, close, dayset)) return d;
    d.setMinutes(d.getMinutes() + 15);
  }
  return d;
}

/** Back-compat: next standard business-hours start (Mon–Fri 9–17). */
export function nextBusinessStart(timezone: string, from: Date = new Date()): Date {
  return nextWithinHours(timezone, from);
}
