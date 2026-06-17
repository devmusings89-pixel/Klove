import { test } from "node:test";
import assert from "node:assert";
import { canonicalize, parseReferenceRange, normSex } from "../src/services/normalize.js";
import { matchAnalyte, toCanonical, ANALYTES } from "../src/services/analyte-registry.js";

test("A1c with % maps + flags high from registry range", () => {
  const c = canonicalize({ display: "Hemoglobin A1c", valueNum: 6.8, unit: "%" });
  assert.equal(c.analyteId, "a1c");
  assert.equal(c.canonicalValue, 6.8);
  assert.equal(c.refHigh, 5.7);
  assert.equal(c.abnormalFlag, "H");
  assert.equal(c.isAbnormal, true);
});

test("glucose mmol/L converts to mg/dL and flags high", () => {
  const c = canonicalize({ display: "Glucose, fasting", valueNum: 7.2, unit: "mmol/L" });
  assert.equal(c.analyteId, "glucose_fasting");
  assert.ok(Math.abs((c.canonicalValue ?? 0) - 129.73) < 0.5, `got ${c.canonicalValue}`);
  assert.equal(c.canonicalUnit, "mg/dL");
  assert.equal(c.abnormalFlag, "H");
});

test("lab's own reference range overrides registry default", () => {
  const c = canonicalize({ display: "LDL Cholesterol", valueNum: 90, unit: "mg/dL", referenceRange: "<130" });
  assert.equal(c.refHigh, 130);
  assert.equal(c.abnormalFlag, "N"); // 90 < 130
});

test("HDL is sex-specific", () => {
  const male = canonicalize({ display: "HDL", valueNum: 45, unit: "mg/dL" }, { sex: "M" });
  assert.equal(male.refLow, 40);
  assert.equal(male.abnormalFlag, "N"); // 45 >= 40
  const female = canonicalize({ display: "HDL", valueNum: 45, unit: "mg/dL" }, { sex: "F" });
  assert.equal(female.refLow, 50);
  assert.equal(female.abnormalFlag, "L"); // 45 < 50
});

test("explicit abnormal flag is trusted over derivation", () => {
  const c = canonicalize({ display: "Potassium", valueNum: 4.2, unit: "mmol/L", abnormalFlag: "H" });
  assert.equal(c.abnormalFlag, "H");
  assert.equal(c.isAbnormal, true);
});

test("unknown analyte yields no canonical mapping", () => {
  const c = canonicalize({ display: "Mystery Marker XYZ", valueNum: 12, unit: "widgets" });
  assert.equal(c.analyteId, undefined);
  assert.equal(c.canonicalValue, undefined);
});

test("parseReferenceRange handles common shapes", () => {
  assert.deepEqual(parseReferenceRange("4.0-5.6"), { low: 4.0, high: 5.6 });
  assert.deepEqual(parseReferenceRange("<100"), { high: 100 });
  assert.deepEqual(parseReferenceRange(">40"), { low: 40 });
  assert.deepEqual(parseReferenceRange("70 to 99"), { low: 70, high: 99 });
  assert.deepEqual(parseReferenceRange(""), {});
});

// ---- #1 glucose fasting vs random/postprandial ----
test("fasting glucose matches the fasting analyte and tight range", () => {
  const c = canonicalize({ display: "Fasting Glucose", valueNum: 110, unit: "mg/dL" });
  assert.equal(c.analyteId, "glucose_fasting");
  assert.equal(c.refHigh, 99);
  assert.equal(c.abnormalFlag, "H"); // 110 > 99
});

test("a bare/post-meal glucose 140 is NOT flagged high (random range)", () => {
  const c = canonicalize({ display: "Glucose", valueNum: 140, unit: "mg/dL" });
  assert.equal(c.analyteId, "glucose_random");
  assert.equal(c.refHigh, 140);
  assert.equal(c.abnormalFlag, "N"); // 140 is not > 140
});

// ---- #2 electrolyte one-letter aliases ----
test("stray 'Na'/'K' and 'Vitamin K' do not false-match electrolytes", () => {
  assert.equal(matchAnalyte(null, "Na")?.id, undefined);
  assert.equal(matchAnalyte(null, "K")?.id, undefined);
  assert.equal(matchAnalyte(null, "Vitamin K")?.id, undefined);
  // Full words still match.
  assert.equal(matchAnalyte(null, "Sodium")?.id, "sodium");
  assert.equal(matchAnalyte(null, "Potassium")?.id, "potassium");
});

// ---- #3 hemoglobin vs HbA1c ----
test("HbA1c is not scored against the hemoglobin range", () => {
  for (const disp of ["HbA1c", "Hb A1c", "Hemoglobin A1c"]) {
    assert.equal(matchAnalyte(null, disp)?.id, "a1c", disp);
  }
  assert.equal(matchAnalyte(null, "Hemoglobin")?.id, "hemoglobin");
  assert.equal(matchAnalyte(null, "Hgb")?.id, "hemoglobin");
});

// ---- #4 eGFR ml/min not equated with ml/min/1.73m2 ----
test("bare ml/min clearance is not treated as BSA-indexed eGFR", () => {
  const egfr = ANALYTES.find((a) => a.id === "egfr")!;
  assert.equal(toCanonical(egfr, 55, "mL/min"), undefined); // not convertible
  assert.equal(toCanonical(egfr, 55, "mL/min/1.73m2"), 55);
  // With an unknown source unit, no derived abnormal flag (see #6).
  const c = canonicalize({ display: "eGFR", valueNum: 55, unit: "mL/min" });
  assert.equal(c.canonicalValue, undefined);
  assert.equal(c.abnormalFlag, undefined); // not flagged L despite 55 < 60
});

// ---- #5 missing unit on a multi-unit analyte ----
test("missing unit on a multi-unit analyte leaves canonicalValue undefined", () => {
  const c = canonicalize({ display: "Glucose, fasting", valueNum: 5.5 }); // 5.5 could be mmol/L
  assert.equal(c.canonicalValue, undefined);
  assert.equal(c.abnormalFlag, undefined); // not flagged against mg/dL range
});

test("missing unit on a single-unit analyte assumes canonical", () => {
  const c = canonicalize({ display: "Hemoglobin A1c", valueNum: 6.8 }); // % is the only unit
  assert.equal(c.canonicalValue, 6.8);
  assert.equal(c.abnormalFlag, "H");
});

// ---- #6 conversion failure suppresses derived flag, keeps explicit ----
test("unknown source unit suppresses derived flag but keeps an explicit one", () => {
  const derived = canonicalize({ display: "Glucose, fasting", valueNum: 300, unit: "widgets" });
  assert.equal(derived.canonicalValue, undefined);
  assert.equal(derived.abnormalFlag, undefined);
  const explicit = canonicalize({ display: "Glucose, fasting", valueNum: 300, unit: "widgets", abnormalFlag: "H" });
  assert.equal(explicit.abnormalFlag, "H");
  assert.equal(explicit.isAbnormal, true);
});

// ---- #7 European decimal commas ----
test("parseReferenceRange handles decimal-comma locale", () => {
  assert.deepEqual(parseReferenceRange("3,5 - 5,1"), { low: 3.5, high: 5.1 });
  assert.deepEqual(parseReferenceRange("<5,7"), { high: 5.7 });
  // Thousands-separator commas are still stripped when a dot decimal is present.
  assert.deepEqual(parseReferenceRange("1,000 - 2,000.5"), { low: 1000, high: 2000.5 });
});

// ---- #8 sex normalization ----
test("normSex maps free-text sex to M/F", () => {
  assert.equal(normSex("Male"), "M");
  assert.equal(normSex("female"), "F");
  assert.equal(normSex("M"), "M");
  assert.equal(normSex("f"), "F");
  assert.equal(normSex("unknown"), undefined);
  assert.equal(normSex(null), undefined);
});

test("raw 'Male' selects the sex-specific HDL range via canonicalize", () => {
  const c = canonicalize({ display: "HDL", valueNum: 45, unit: "mg/dL" }, { sex: "Male" });
  assert.equal(c.refLow, 40); // male range, not sex-agnostic
  assert.equal(c.abnormalFlag, "N");
});
