// Family Health Graph + timeline projection (Klove).
//
// The "graph" is a derived read layer over the per-user FHIR-lite tables — not a materialized
// store. Users never see raw data; they see a clean chronological timeline and, on request,
// focused "show me" views. Everything here is a projection computed on demand (the anti-dashboard).

import { prisma } from "../db.js";

export type TimelineKind = "observation" | "condition" | "medication" | "report" | "allergy" | "appointment";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  date: string | null; // ISO; null sorts last
  title: string;
  detail?: string;
  source: string;
  abnormal?: boolean;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A clean, chronological health story for one member (newest first). */
export async function buildTimeline(userId: string): Promise<TimelineEntry[]> {
  const [observations, conditions, medications, reports, allergies, appointments] = await Promise.all([
    prisma.observation.findMany({ where: { userId } }),
    prisma.condition.findMany({ where: { userId } }),
    prisma.medicationStatement.findMany({ where: { userId } }),
    prisma.diagnosticReport.findMany({ where: { userId } }),
    prisma.allergyIntolerance.findMany({ where: { userId } }),
    prisma.appointment.findMany({ where: { userId } }),
  ]);

  const entries: TimelineEntry[] = [];

  for (const o of observations) {
    const value = o.valueNum != null ? `${o.valueNum}${o.unit ? ` ${o.unit}` : ""}` : o.valueString ?? "";
    entries.push({
      id: o.id,
      kind: "observation",
      date: iso(o.effectiveAt ?? o.recordedAt),
      title: o.display,
      detail: [value, o.referenceRange ? `ref ${o.referenceRange}` : null].filter(Boolean).join(" · ") || undefined,
      source: o.sourceType,
      abnormal: Boolean(o.abnormalFlag && o.abnormalFlag !== "N"),
    });
  }
  for (const c of conditions) {
    entries.push({
      id: c.id,
      kind: "condition",
      date: iso(c.onsetDate ?? c.recordedAt),
      title: c.display,
      detail: c.clinicalStatus ?? undefined,
      source: c.sourceType,
    });
  }
  for (const m of medications) {
    entries.push({
      id: m.id,
      kind: "medication",
      date: iso(m.startDate ?? m.recordedAt),
      title: m.display,
      detail: [m.dosage, m.status].filter(Boolean).join(" · ") || undefined,
      source: m.sourceType,
    });
  }
  for (const r of reports) {
    entries.push({
      id: r.id,
      kind: "report",
      date: iso(r.issuedAt ?? r.recordedAt),
      title: r.display,
      detail: r.category ?? undefined,
      source: r.sourceType,
    });
  }
  for (const a of allergies) {
    entries.push({
      id: a.id,
      kind: "allergy",
      date: iso(a.recordedAt),
      title: a.substance,
      detail: [a.reaction, a.severity].filter(Boolean).join(" · ") || undefined,
      source: a.sourceType,
    });
  }
  for (const ap of appointments) {
    entries.push({
      id: ap.id,
      kind: "appointment",
      date: iso(ap.startsAt ?? ap.recordedAt),
      title: ap.title,
      detail: [ap.provider, ap.location].filter(Boolean).join(" · ") || undefined,
      source: ap.sourceType,
    });
  }

  // Newest first; null dates sink to the bottom.
  entries.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  return entries;
}

export interface GraphSummary {
  member: { userId: string };
  counts: { conditions: number; medications: number; observations: number; appointments: number; allergies: number };
  activeConditions: string[];
  activeMedications: string[];
  nextAppointment: { title: string; date: string | null; provider: string | null } | null;
}

/** A compact, grounded snapshot of a member's care — used by briefs and "show me" summaries. */
export async function buildSummary(userId: string): Promise<GraphSummary> {
  const [conditions, medications, observations, allergies, appointments] = await Promise.all([
    prisma.condition.findMany({ where: { userId } }),
    prisma.medicationStatement.findMany({ where: { userId } }),
    prisma.observation.count({ where: { userId } }),
    prisma.allergyIntolerance.count({ where: { userId } }),
    prisma.appointment.findMany({ where: { userId }, orderBy: { startsAt: "asc" } }),
  ]);

  const now = new Date();
  const upcoming = appointments.find((a) => a.startsAt && a.startsAt >= now) ?? null;

  return {
    member: { userId },
    counts: {
      conditions: conditions.length,
      medications: medications.length,
      observations,
      appointments: appointments.length,
      allergies,
    },
    activeConditions: conditions.filter((c) => (c.clinicalStatus ?? "active") === "active").map((c) => c.display),
    activeMedications: medications.filter((m) => (m.status ?? "active") === "active").map((m) => m.display),
    nextAppointment: upcoming ? { title: upcoming.title, date: iso(upcoming.startsAt), provider: upcoming.provider } : null,
  };
}
