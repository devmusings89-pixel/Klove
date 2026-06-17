// Curated registry of high-value lab analytes & vitals. The single source of truth for matching a
// raw extracted observation to a canonical analyte, converting its value to a canonical UCUM unit,
// and knowing healthy reference ranges (age/sex-aware). Used by normalize.ts (persistence) and the
// analysis engine (out-of-range + trends). Adding an analyte here lights it up everywhere.

export interface RefRange {
  sex?: "M" | "F"; // omit = applies to all
  ageMin?: number; // inclusive, years
  ageMax?: number; // inclusive, years
  low?: number; // in canonical unit
  high?: number; // in canonical unit
}

export interface Analyte {
  id: string; // canonical id, e.g. "a1c"
  display: string; // canonical display name
  loinc?: string[]; // known LOINC codes (matched first)
  aliases: RegExp; // matched against the raw display text
  unit: string; // canonical UCUM-ish unit
  // multiplier from a (normalized) source unit → canonical unit; canonicalValue = value * factor.
  units: Record<string, number>;
  ranges?: RefRange[]; // healthy reference ranges in the canonical unit
}

/** Normalize a unit string for lookup: lowercase, trim, unify micro sign and common spellings. */
export function normUnit(u?: string | null): string {
  return (u ?? "")
    .toLowerCase()
    .replace(/µ|μ/g, "u")
    .replace(/\s+/g, "")
    .replace(/per/g, "/")
    .replace(/mmhg/, "mmhg");
}

// factor presets (source unit → canonical). canonical noted in each analyte's `unit`.
const PCT = { "%": 1 };

export const ANALYTES: Analyte[] = [
  // ---- Metabolic / diabetes ----
  { id: "a1c", display: "Hemoglobin A1c", loinc: ["4548-4", "4549-2", "17856-6"], aliases: /a1c|glycohemoglobin|hba1c|hemoglobin a1c/i, unit: "%", units: PCT,
    ranges: [{ high: 5.7 }] },
  // Fasting glucose has a tight 70-99 range. Match only when the draw is explicitly fasting (or a
  // fasting-specific LOINC), so a normal post-meal/random reading isn't scored against the fasting
  // range. Random/postprandial draws fall through to `glucose_random` below.
  { id: "glucose_fasting", display: "Glucose, fasting", loinc: ["1558-6"], aliases: /fasting glucose|glucose,?\s*fasting|fasting blood sugar|\bfbg\b|\bfpg\b/i, unit: "mg/dL",
    units: { "mg/dl": 1, "mmol/l": 18.0182 }, ranges: [{ low: 70, high: 99 }] },
  // Random / postprandial / unspecified glucose: wider non-fasting upper bound (<140) so a normal
  // post-meal 140 isn't flagged "H". This is the catch-all for a bare "Glucose"/"Blood sugar".
  { id: "glucose_random", display: "Glucose", loinc: ["2345-7", "2339-0"], aliases: /glucose|blood sugar/i, unit: "mg/dL",
    units: { "mg/dl": 1, "mmol/l": 18.0182 }, ranges: [{ high: 140 }] },
  // eGFR is BSA-indexed (mL/min/1.73m2). A bare "mL/min" is a raw clearance and is NOT
  // interchangeable with eGFR, so it is intentionally absent from `units` (→ no canonical value).
  { id: "egfr", display: "eGFR", loinc: ["33914-3", "48643-1", "62238-1"], aliases: /egfr|estimated glomerular/i, unit: "mL/min/1.73m2",
    units: { "ml/min/1.73m2": 1 }, ranges: [{ low: 60 }] },
  { id: "creatinine", display: "Creatinine", loinc: ["2160-0"], aliases: /creatinine/i, unit: "mg/dL",
    units: { "mg/dl": 1, "umol/l": 1 / 88.42 }, ranges: [{ sex: "M", low: 0.74, high: 1.35 }, { sex: "F", low: 0.59, high: 1.04 }] },
  { id: "bun", display: "BUN", loinc: ["3094-0"], aliases: /\bbun\b|urea nitrogen/i, unit: "mg/dL", units: { "mg/dl": 1, "mmol/l": 2.801 }, ranges: [{ low: 7, high: 20 }] },

  // ---- Lipids ----
  { id: "total_cholesterol", display: "Total cholesterol", loinc: ["2093-3"], aliases: /total cholesterol|cholesterol, total|^cholesterol$/i, unit: "mg/dL",
    units: { "mg/dl": 1, "mmol/l": 38.67 }, ranges: [{ high: 200 }] },
  { id: "ldl", display: "LDL cholesterol", loinc: ["13457-7", "18262-6"], aliases: /ldl/i, unit: "mg/dL", units: { "mg/dl": 1, "mmol/l": 38.67 }, ranges: [{ high: 100 }] },
  { id: "hdl", display: "HDL cholesterol", loinc: ["2085-9"], aliases: /hdl/i, unit: "mg/dL", units: { "mg/dl": 1, "mmol/l": 38.67 },
    ranges: [{ sex: "M", low: 40 }, { sex: "F", low: 50 }] },
  { id: "triglycerides", display: "Triglycerides", loinc: ["2571-8"], aliases: /triglyceride/i, unit: "mg/dL", units: { "mg/dl": 1, "mmol/l": 88.57 }, ranges: [{ high: 150 }] },

  // ---- Thyroid ----
  { id: "tsh", display: "TSH", loinc: ["3016-3", "11580-8"], aliases: /\btsh\b|thyroid stimulating/i, unit: "mIU/L", units: { "miu/l": 1, "uiu/ml": 1 }, ranges: [{ low: 0.4, high: 4.0 }] },
  { id: "ft4", display: "Free T4", loinc: ["3024-7"], aliases: /free t4|ft4|free thyroxine/i, unit: "ng/dL", units: { "ng/dl": 1 }, ranges: [{ low: 0.8, high: 1.8 }] },

  // ---- Liver ----
  { id: "alt", display: "ALT", loinc: ["1742-6"], aliases: /\balt\b|alanine aminotransferase|sgpt/i, unit: "U/L", units: { "u/l": 1, "iu/l": 1 }, ranges: [{ high: 44 }] },
  { id: "ast", display: "AST", loinc: ["1920-8"], aliases: /\bast\b|aspartate aminotransferase|sgot/i, unit: "U/L", units: { "u/l": 1, "iu/l": 1 }, ranges: [{ high: 40 }] },

  // ---- Electrolytes ----
  // Require the full word "sodium". A bare "Na" symbol is too ambiguous (matches stray text /
  // "Na+" headers / chemical names) to score against a tight electrolyte range.
  { id: "sodium", display: "Sodium", loinc: ["2951-2"], aliases: /\bsodium\b/i, unit: "mmol/L", units: { "mmol/l": 1, "meq/l": 1 }, ranges: [{ low: 135, high: 145 }] },
  // Require the full word "potassium". Dropping the bare "K" alias means a one-letter "K" symbol or
  // "Vitamin K" no longer false-matches the potassium range.
  { id: "potassium", display: "Potassium", loinc: ["2823-3"], aliases: /\bpotassium\b/i, unit: "mmol/L", units: { "mmol/l": 1, "meq/l": 1 }, ranges: [{ low: 3.5, high: 5.1 }] },

  // ---- CBC ----
  // Hemoglobin (Hgb), NOT Hemoglobin A1c. Every branch excludes a following "a1c"/"a1" so an A1c
  // result (e.g. "Hb A1c", "HbA1c") is never scored against the Hgb 13.5-17.5 range.
  { id: "hemoglobin", display: "Hemoglobin", loinc: ["718-7"], aliases: /hemoglobin(?!\s*a1c)|^hgb$|\bhb\b(?!\s*a1c)(?!a1)/i, unit: "g/dL", units: { "g/dl": 1, "g/l": 0.1 },
    ranges: [{ sex: "M", low: 13.5, high: 17.5 }, { sex: "F", low: 12.0, high: 15.5 }] },
  { id: "hematocrit", display: "Hematocrit", loinc: ["4544-3"], aliases: /hematocrit|^hct$/i, unit: "%", units: PCT, ranges: [{ sex: "M", low: 41, high: 50 }, { sex: "F", low: 36, high: 44 }] },
  { id: "wbc", display: "White blood cells", loinc: ["6690-2"], aliases: /white blood|wbc|leukocyte/i, unit: "10^3/uL", units: { "10^3/ul": 1, "k/ul": 1, "10*3/ul": 1 }, ranges: [{ low: 4.0, high: 11.0 }] },
  { id: "platelets", display: "Platelets", loinc: ["777-3"], aliases: /platelet|^plt$/i, unit: "10^3/uL", units: { "10^3/ul": 1, "k/ul": 1 }, ranges: [{ low: 150, high: 400 }] },

  // ---- Vitamins / iron ----
  { id: "vitamin_d", display: "Vitamin D, 25-OH", loinc: ["1989-3", "62292-8"], aliases: /vitamin d|25-oh|25 hydroxy/i, unit: "ng/mL", units: { "ng/ml": 1, "nmol/l": 1 / 2.496 }, ranges: [{ low: 30, high: 100 }] },
  { id: "vitamin_b12", display: "Vitamin B12", loinc: ["2132-9"], aliases: /b12|cobalamin/i, unit: "pg/mL", units: { "pg/ml": 1, "pmol/l": 1 / 0.738 }, ranges: [{ low: 200, high: 900 }] },
  { id: "ferritin", display: "Ferritin", loinc: ["2276-4"], aliases: /ferritin/i, unit: "ng/mL", units: { "ng/ml": 1, "ug/l": 1 }, ranges: [{ sex: "M", low: 30, high: 400 }, { sex: "F", low: 15, high: 150 }] },

  // ---- Cancer screening markers ----
  { id: "psa", display: "PSA", loinc: ["2857-1"], aliases: /\bpsa\b|prostate specific/i, unit: "ng/mL", units: { "ng/ml": 1 }, ranges: [{ sex: "M", high: 4.0 }] },

  // ---- Vitals (also stored structured in VitalSign; registry powers analysis/trends) ----
  { id: "bp_systolic", display: "Systolic blood pressure", loinc: ["8480-6"], aliases: /systolic/i, unit: "mmHg", units: { mmhg: 1 }, ranges: [{ high: 130 }] },
  { id: "bp_diastolic", display: "Diastolic blood pressure", loinc: ["8462-4"], aliases: /diastolic/i, unit: "mmHg", units: { mmhg: 1 }, ranges: [{ high: 80 }] },
  { id: "heart_rate", display: "Heart rate", loinc: ["8867-4"], aliases: /heart rate|pulse|\bhr\b/i, unit: "bpm", units: { bpm: 1, "/min": 1 }, ranges: [{ low: 60, high: 100 }] },
  { id: "bmi", display: "BMI", loinc: ["39156-5"], aliases: /\bbmi\b|body mass index/i, unit: "kg/m2", units: { "kg/m2": 1 }, ranges: [{ low: 18.5, high: 25 }] },
  { id: "weight", display: "Weight", loinc: ["29463-7"], aliases: /weight|body weight/i, unit: "kg", units: { kg: 1, lb: 0.453592, lbs: 0.453592 } },
];

/** Match a raw observation (code + display) to a canonical analyte, or undefined. */
export function matchAnalyte(code: string | null | undefined, display: string): Analyte | undefined {
  if (code) {
    const byCode = ANALYTES.find((a) => a.loinc?.includes(code));
    if (byCode) return byCode;
  }
  return ANALYTES.find((a) => a.aliases.test(display));
}

/** Convert a value in `fromUnit` to the analyte's canonical unit, or undefined if not mappable. */
export function toCanonical(analyte: Analyte, value: number, fromUnit?: string | null): number | undefined {
  const u = normUnit(fromUnit);
  if (!u) {
    // Unit absent. Safe to assume canonical only when the analyte is single-unit (no ambiguity).
    // For multi-unit analytes (e.g. glucose mg/dL vs mmol/L) a missing unit is genuinely unknown —
    // leave canonicalValue undefined rather than guessing, which could mis-scale by ~18x.
    return Object.keys(analyte.units).length <= 1 ? value : undefined;
  }
  if (u === normUnit(analyte.unit)) return value;
  const factor = analyte.units[u];
  return factor !== undefined ? value * factor : undefined;
}

/** Pick the reference range for an analyte given age/sex (most specific match wins). */
export function rangeFor(analyte: Analyte, age?: number, sex?: string): RefRange | undefined {
  const s = sex === "M" || sex === "F" ? sex : undefined;
  const matches = (analyte.ranges ?? []).filter(
    (r) =>
      (r.sex === undefined || r.sex === s) &&
      (r.ageMin === undefined || (age !== undefined && age >= r.ageMin)) &&
      (r.ageMax === undefined || (age !== undefined && age <= r.ageMax)),
  );
  // Prefer sex-specific over generic.
  return matches.sort((a, b) => (b.sex ? 1 : 0) - (a.sex ? 1 : 0))[0];
}
