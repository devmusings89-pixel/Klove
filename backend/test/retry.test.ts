import { test, after } from "node:test";
import assert from "node:assert/strict";
process.env.LIVE_BOOKING = "false";
const { shouldRetry } = await import("../src/services/orchestrator.js");
const { prisma } = await import("../src/db.js");

after(async () => { await prisma.$disconnect(); });

test("shouldRetry: re-dial no-answer/voicemail until the call budget is spent", () => {
  assert.equal(shouldRetry("no_answer", 1, 3), true);   // attempt 1 of 3 → retry
  assert.equal(shouldRetry("voicemail", 2, 3), true);   // attempt 2 of 3 → retry
  assert.equal(shouldRetry("no_answer", 3, 3), false);  // budget spent → give up
  assert.equal(shouldRetry("failed", 1, 3), false);     // hard failure → no retry
  assert.equal(shouldRetry("booked", 1, 3), false);     // success → no retry
});
