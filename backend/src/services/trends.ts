// Longitudinal trend detection over canonicalized observations. Flags an analyte that is moving in a
// worsening direction across >=3 dated points. Conservative: relative change must clear a threshold.

import type { DraftAlert } from "./insights-types.js";

export interface TrendObs {
  id: string;
  analyteId: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  display: string;
  effectiveAt: Date | null;
  recordedAt: Date;
}

// Direction that is clinically "worse" for each tracked analyte.
const WORSE_WHEN_UP = new Set(["a1c", "ldl", "glucose_fasting", "bp_systolic", "bp_diastolic", "triglycerides", "total_cholesterol", "bmi", "weight"]);
const WORSE_WHEN_DOWN = new Set(["egfr", "hdl"]);
const REL_THRESHOLD = 0.1; // 10% move across the series

export function trendAlerts(observations: TrendObs[]): DraftAlert[] {
  const byAnalyte = new Map<string, TrendObs[]>();
  for (const o of observations) {
    if (!o.analyteId || o.canonicalValue == null) continue;
    if (!WORSE_WHEN_UP.has(o.analyteId) && !WORSE_WHEN_DOWN.has(o.analyteId)) continue;
    (byAnalyte.get(o.analyteId) ?? byAnalyte.set(o.analyteId, []).get(o.analyteId)!).push(o);
  }

  const out: DraftAlert[] = [];
  for (const [analyteId, pts] of byAnalyte) {
    const series = pts
      .map((o) => ({ t: (o.effectiveAt ?? o.recordedAt).getTime(), v: o.canonicalValue!, o }))
      .sort((a, b) => a.t - b.t);
    if (series.length < 3) continue;

    const first = series[0];
    const last = series[series.length - 1];
    if (first.v === 0) continue;
    const rel = (last.v - first.v) / Math.abs(first.v);
    const worse = WORSE_WHEN_UP.has(analyteId) ? rel > REL_THRESHOLD : rel < -REL_THRESHOLD;
    if (!worse) continue;

    const dir = last.v > first.v ? "rising" : "falling";
    const display = last.o.display;
    const unit = last.o.canonicalUnit ?? "";
    out.push({
      severity: "watch",
      category: "trend",
      title: `${display} is ${dir}`,
      detail:
        `${display} has moved from ${round(first.v)}${unit} to ${round(last.v)}${unit} over your last ${series.length} results ` +
        `(${pct(rel)}). Consider discussing this trend with your provider.`,
      relatedResourceIds: series.map((s) => s.o.id),
      followUpType: "book_visit",
      recommendedSpecialty: "primary care",
      daysToAction: 45,
      guideline: "Longitudinal trend",
    });
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 100)}%`;
