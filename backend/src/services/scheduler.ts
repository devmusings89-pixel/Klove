import { config } from "../config.js";

const BUSINESS_START_HOUR = 9; // 9:00 local
const BUSINESS_END_HOUR = 17; // 17:00 local

/**
 * Is `date` within Mon–Fri 9:00–17:00 in the given IANA timezone?
 * Uses Intl to read wall-clock time in that zone (no extra deps).
 */
export function isWithinBusinessHours(timezone: string, date: Date = new Date()): boolean {
  if (!config.enforceBusinessHours) return true;

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
