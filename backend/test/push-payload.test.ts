import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApnsPayload } from "../src/services/push.js";

test("buildApnsPayload wraps title/body in aps with a default sound", () => {
  const p = buildApnsPayload("Booked ✅", "Annual physical is booked.") as { aps: { alert: { title: string; body: string }; sound: string } };
  assert.equal(p.aps.alert.title, "Booked ✅");
  assert.equal(p.aps.alert.body, "Annual physical is booked.");
  assert.equal(p.aps.sound, "default");
});

test("buildApnsPayload includes a top-level link deep-link hint when given", () => {
  const p = buildApnsPayload("Choose a time", "Tap to pick.", "actions") as { link?: string };
  assert.equal(p.link, "actions");
});

test("buildApnsPayload omits link when none is given (no stray key)", () => {
  const p = buildApnsPayload("Reminder", "Visit tomorrow") as Record<string, unknown>;
  assert.equal("link" in p, false);
});
