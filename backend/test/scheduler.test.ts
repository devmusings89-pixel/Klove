import { test } from "node:test";
import assert from "node:assert/strict";

// Business-hours gating must be enabled for these assertions.
process.env.ENFORCE_BUSINESS_HOURS = "true";
const { isWithinBusinessHours } = await import("../src/services/scheduler.ts");

test("weekends are outside business hours", () => {
  const saturday = new Date("2026-06-13T15:00:00Z");
  assert.equal(isWithinBusinessHours("America/New_York", saturday), false);
});

test("weekday late morning is within business hours", () => {
  const wed11amNY = new Date("2026-06-17T15:00:00Z"); // 11:00 in NY
  assert.equal(isWithinBusinessHours("America/New_York", wed11amNY), true);
});

test("weekday overnight is outside business hours", () => {
  const wedMidnightNY = new Date("2026-06-17T04:00:00Z");
  assert.equal(isWithinBusinessHours("America/New_York", wedMidnightNY), false);
});

test("gating is timezone-aware (same instant, different zone)", () => {
  const instant = new Date("2026-06-17T15:00:00Z"); // 11:00 NY (open) but midnight Tokyo (closed)
  assert.equal(isWithinBusinessHours("America/New_York", instant), true);
  assert.equal(isWithinBusinessHours("Asia/Tokyo", instant), false);
});
