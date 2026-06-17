// Canonicalize a raw extracted observation: match it to a registry analyte, convert its value to the
// canonical unit, parse its reference range into numbers, and derive an abnormal flag. Pure (no I/O)
// so it's unit-testable and runs at persistence time (fhir-map.persistBundle).

import { matchAnalyte, toCanonical, rangeFor, type Analyte } from "./analyte-registry.js";

export interface RawObs {
  code?: string | null;
  display: string;
  valueNum?: number | null;
  unit?: string | null;
  referenceRange?: string | null;
  abnormalFlag?: string | null;
}

export interface Canonical {
  analyteId?: string;
  canonicalUnit?: string;
  canonicalValue?: number;
  refLow?: number;
  refHigh?: number;
  isAbnormal?: boolean;
  abnormalFlag?: string; // "H" | "L" | "N" | original
}

/**
 * Canonicalize one observation. `age`/`sex` (when known) select the right reference range; without
 * them we fall back to a parsed free-text range or the analyte's generic range.
 */
export function canonicalize(obs: RawObs, opts: { age?: number; sex?: string } = {}): Canonical {
  const out: Canonical = {};
  const analyte = matchAnalyte(obs.code, obs.display);

  // Value → canonical unit.
  if (analyte) {
    out.analyteId = analyte.id;
    out.canonicalUnit = analyte.unit;
    if (typeof obs.valueNum === "number") {
      const cv = toCanonical(analyte, obs.valueNum, obs.unit);
      if (cv !== undefined) out.canonicalValue = round(cv);
    }
  }

  // Reference range: prefer the lab's own parsed range; else the analyte's age/sex range.
  const parsed = parseReferenceRange(obs.referenceRange);
  let low = parsed.low;
  let high = parsed.high;
  if (low === undefined && high === undefined && analyte) {
    const r = rangeFor(analyte, opts.age, opts.sex);
    if (r) { low = r.low; high = r.high; }
  }
  out.refLow = low;
  out.refHigh = high;

  // Abnormal: trust an explicit flag; else derive from canonical value vs range.
  const flag = (obs.abnormalFlag ?? "").trim().toUpperCase();
  if (flag === "H" || flag === "L" || flag === "A") {
    out.abnormalFlag = flag;
    out.isAbnormal = true;
  } else if (flag === "N") {
    out.abnormalFlag = "N";
    out.isAbnormal = false;
  } else {
    const v = out.canonicalValue ?? (typeof obs.valueNum === "number" ? obs.valueNum : undefined);
    if (v !== undefined && (low !== undefined || high !== undefined)) {
      if (high !== undefined && v > high) { out.abnormalFlag = "H"; out.isAbnormal = true; }
      else if (low !== undefined && v < low) { out.abnormalFlag = "L"; out.isAbnormal = true; }
      else { out.abnormalFlag = "N"; out.isAbnormal = false; }
    }
  }

  return out;
}

/** Parse a free-text reference range into numeric bounds. Handles "4.0-5.6", "<100", ">40", "70 - 99". */
export function parseReferenceRange(s?: string | null): { low?: number; high?: number } {
  if (!s) return {};
  const t = s.replace(/[,]/g, "").trim();
  // "<100" / "≤100"
  let m = t.match(/^[<≤]\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { high: parseFloat(m[1]) };
  // ">40" / "≥40"
  m = t.match(/^[>≥]\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { low: parseFloat(m[1]) };
  // "low - high" (also "low to high")
  m = t.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    return { low: Math.min(a, b), high: Math.max(a, b) };
  }
  return {};
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Convenience for callers that have the matched analyte already. */
export type { Analyte };
