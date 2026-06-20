import { test } from "node:test";
import assert from "node:assert/strict";
const { matchesWindow } = await import("../src/channels/adapters/patientsreach.js");

test("matchesWindow honors a day even when 'any time' is present (the Avondale bug)", () => {
  assert.equal(matchesWindow("THU", "1:00 PM", "Saturday any time"), false); // was wrongly true
  assert.equal(matchesWindow("SAT", "1:00 PM", "Saturday any time"), true);
});
test("matchesWindow accepts anything when truly unconstrained", () => {
  assert.equal(matchesWindow("THU", "1:00 PM", "any time"), true);
  assert.equal(matchesWindow("MON", "9:00 AM", "asap"), true);
  assert.equal(matchesWindow("MON", "9:00 AM", ""), true);
});
test("matchesWindow applies day + time-of-day + after/before", () => {
  assert.equal(matchesWindow("THU", "9:00 AM", "weekday mornings"), true);
  assert.equal(matchesWindow("THU", "2:00 PM", "weekday mornings"), false);
  assert.equal(matchesWindow("SAT", "1:00 PM", "weekend"), true);
  assert.equal(matchesWindow("MON", "8:00 AM", "after 4pm"), false);
  assert.equal(matchesWindow("MON", "5:00 PM", "after 4pm"), true);
});
