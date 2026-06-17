import { test } from "node:test";
import assert from "node:assert";
import { evaluateGuidelines } from "../src/services/guidelines.js";
import { detectMedIssues } from "../src/services/med-safety.js";
import { trendAlerts } from "../src/services/trends.js";

const dobForAge = (age: number) => new Date(Date.now() - age * 365.25 * 86_400_000);
const empty = { conditions: [], observations: [], immunizations: [], medications: [] };

test("guidelines: 50yo female with no records gets age/sex-appropriate screenings", () => {
  const alerts = evaluateGuidelines({ dob: dobForAge(50), sex: "F" }, empty);
  const ids = alerts.map((a) => a.title);
  assert.ok(ids.some((t) => /lipid panel/i.test(t)), "lipid panel due");
  assert.ok(ids.some((t) => /colorectal/i.test(t)), "colorectal due");
  assert.ok(ids.some((t) => /mammogram/i.test(t)), "mammogram due (female 40-74)");
  assert.ok(ids.some((t) => /cervical/i.test(t)), "cervical due (female 21-65)");
  // Every alert carries a citation + follow-up.
  assert.ok(alerts.every((a) => a.guideline && a.followUpType), "all cited + actionable");
});

test("guidelines: male doesn't get female-only screenings", () => {
  const alerts = evaluateGuidelines({ dob: dobForAge(50), sex: "M" }, empty);
  assert.ok(!alerts.some((a) => /mammogram|cervical/i.test(a.title)), "no female screenings for male");
});

test("guidelines: recent lipid result suppresses the lipid gap", () => {
  const recent = { analyteId: "ldl", effectiveAt: new Date(), recordedAt: new Date() };
  const alerts = evaluateGuidelines({ dob: dobForAge(50), sex: "F" }, { ...empty, observations: [recent] });
  assert.ok(!alerts.some((a) => /lipid panel/i.test(a.title)), "lipid suppressed when recent LDL exists");
});

test("guidelines: active diabetes without recent A1c => A1c monitoring (watch, endocrinology)", () => {
  const alerts = evaluateGuidelines(
    { dob: dobForAge(55), sex: "M" },
    { ...empty, conditions: [{ id: "c1", display: "Type 2 diabetes mellitus", clinicalStatus: "active" }] },
  );
  const a1c = alerts.find((a) => /A1c check/i.test(a.title));
  assert.ok(a1c, "A1c monitoring emitted");
  assert.equal(a1c!.severity, "watch");
  assert.equal(a1c!.recommendedSpecialty, "endocrinology");
  // Statin therapy gap for diabetic 40-75 with no statin.
  assert.ok(alerts.some((a) => /statin/i.test(a.title)), "statin therapy gap");
});

test("guidelines: recent flu shot suppresses the flu gap", () => {
  const withFlu = { ...empty, immunizations: [{ display: "Influenza, seasonal", administeredAt: new Date(), recordedAt: new Date() }] };
  const alerts = evaluateGuidelines({ dob: dobForAge(40), sex: "F" }, withFlu);
  assert.ok(!alerts.some((a) => /flu/i.test(a.title)), "flu suppressed when recent");
});

test("med-safety: interaction, duplicate, and refill", () => {
  const past = new Date(Date.now() - 86_400_000);
  const alerts = detectMedIssues([
    { id: "m1", display: "Warfarin 5mg", status: "active" },
    { id: "m2", display: "Ibuprofen 400mg", status: "active" },
    { id: "m3", display: "Atorvastatin 20mg", status: "active" },
    { id: "m4", display: "Atorvastatin 40mg", status: "active" },
    { id: "m5", display: "Lisinopril 10mg", status: "active", nextRefillDue: past },
  ]);
  assert.ok(alerts.some((a) => /interaction/i.test(a.title) && /warfarin/i.test(a.title)), "warfarin+NSAID interaction");
  assert.ok(alerts.some((a) => /duplicate/i.test(a.title)), "duplicate atorvastatin");
  assert.ok(alerts.some((a) => /refill/i.test(a.title) && a.followUpType === "refill"), "refill due");
});

test("trends: three rising A1c results flag a worsening trend", () => {
  const mk = (id: string, v: number, daysAgo: number) => ({
    id, analyteId: "a1c", canonicalValue: v, canonicalUnit: "%", display: "Hemoglobin A1c",
    effectiveAt: new Date(Date.now() - daysAgo * 86_400_000), recordedAt: new Date(),
  });
  const alerts = trendAlerts([mk("o1", 5.8, 360), mk("o2", 6.2, 180), mk("o3", 6.8, 5)]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /rising/i);
  assert.equal(alerts[0].category, "trend");
});

test("trends: stable values produce no alert", () => {
  const mk = (id: string, v: number, d: number) => ({ id, analyteId: "ldl", canonicalValue: v, canonicalUnit: "mg/dL", display: "LDL", effectiveAt: new Date(Date.now() - d * 86_400_000), recordedAt: new Date() });
  assert.equal(trendAlerts([mk("a", 100, 200), mk("b", 101, 100), mk("c", 99, 5)]).length, 0);
});
