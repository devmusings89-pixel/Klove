import { test } from "node:test";
import assert from "node:assert";
import { canonicalize, parseReferenceRange } from "../src/services/normalize.js";

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
