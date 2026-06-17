// The common normalized bundle that both LLM extraction and FHIR ingestion produce, plus the
// writer that persists it into the FHIR-lite tables, and a mapper from raw FHIR → bundle.

import { prisma } from "../db.js";
import { toJson } from "./json.js";
import { canonicalize, normSex, type RawObs } from "./normalize.js";
import type { SourceType } from "../sources/types.js";

// Neutral default confidence when an extractor/source doesn't supply one. Avoids a fake 1.0 (100%)
// that would imply certainty we don't have. 0.5 reads as "unknown / not asserted".
const DEFAULT_CONFIDENCE = 0.5;

/** Whole-years age from a date of birth, or undefined. */
function ageFrom(dob?: Date | null): number | undefined {
  if (!dob) return undefined;
  const ms = Date.now() - dob.getTime();
  if (ms <= 0) return undefined;
  return Math.floor(ms / (365.25 * 86_400_000));
}

/**
 * True if an identical observation already exists on the same calendar day (dedup of a lab
 * re-ingested from another source). We key on analyte + value + source so two *different* readings
 * on the same day (e.g. AM and PM glucose) both survive — only an exact re-ingest is dropped.
 */
async function sameDayDuplicateExists(
  userId: string,
  analyteId: string,
  eff: Date,
  valueNum: number | null | undefined,
  sourceType: SourceType,
): Promise<boolean> {
  const dayStart = new Date(eff); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(eff); dayEnd.setHours(23, 59, 59, 999);
  const hit = await prisma.observation.findFirst({
    where: {
      userId,
      analyteId,
      sourceType,
      valueNum: valueNum ?? null,
      effectiveAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true },
  });
  return hit !== null;
}

export interface ExtractedObservation {
  code?: string;
  display: string;
  valueNum?: number;
  valueString?: string;
  unit?: string;
  referenceRange?: string;
  abnormalFlag?: string;
  effectiveAt?: string;
  confidence?: number;
}
export interface ExtractedCondition {
  code?: string;
  display: string;
  clinicalStatus?: string;
  onsetDate?: string;
  severity?: string;
  confidence?: number;
}
export interface ExtractedMedication {
  display: string;
  rxNormCode?: string;
  dosage?: string;
  doseValue?: number;
  doseUnit?: string;
  frequency?: string;
  route?: string;
  daysSupply?: number;
  status?: string;
  startDate?: string;
  endDate?: string;
  confidence?: number;
}
export interface ExtractedVital {
  type: string; // blood_pressure | heart_rate | weight | height | bmi | temperature | spo2
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  valueNum?: number;
  unit?: string;
  measuredAt?: string;
  confidence?: number;
}
export interface ExtractedImmunization {
  cvxCode?: string;
  display: string;
  administeredAt?: string;
  doseNumber?: number;
  series?: string;
  confidence?: number;
}
export interface ExtractedReport {
  display: string;
  category?: string;
  issuedAt?: string;
  confidence?: number;
}
export interface ExtractedAllergy {
  substance: string;
  reaction?: string;
  severity?: string;
  confidence?: number;
}
export interface ExtractedAppointment {
  title: string;
  provider?: string;
  providerPhone?: string;
  providerWebsite?: string;
  providerAddress?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
  status?: string;
  confirmation?: string;
  notes?: string;
  confidence?: number;
}

export interface ExtractedBundle {
  isHealthRelated?: boolean; // false => classifier dropped it
  reportSummary?: string;
  observations?: ExtractedObservation[];
  conditions?: ExtractedCondition[];
  medications?: ExtractedMedication[];
  reports?: ExtractedReport[];
  allergies?: ExtractedAllergy[];
  appointments?: ExtractedAppointment[];
  vitals?: ExtractedVital[];
  immunizations?: ExtractedImmunization[];
}

function date(s?: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Canonical key for a provider/office name so trivial spelling/punctuation/honorific differences
 * collapse to one identity ("Dr. Lin" == "Dr Lin" == "DR. LIN"). This is the server-side twin of the
 * iOS `providerKey` used for the "Book again" list, so the derived doctor index is stable across
 * sources instead of fragmenting on formatting. Kept here (the FHIR-mapping boundary) so any code
 * deriving providers from appointments/practitioners can dedupe consistently.
 *
 * NOTE: This is additive — it sits alongside the labs vitals→Observation bridge above and does not
 * touch it. The ad-hoc lowercased-name dedupe in services/intake.ts (matchProviders, NOT in this
 * lane's ownership) should adopt this helper; doing so is the one out-of-lane change that finishes
 * item #6 end-to-end.
 */
export function providerKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(dr|doctor|mr|mrs|ms)\s+(.*)$/);
  if (m) s = m[2];
  return s;
}

/**
 * Decompose an extracted vital into the canonical-Observation components the analysis pipeline
 * understands (item #9). A blood_pressure vital yields two observations (systolic + diastolic); the
 * rest yield one. The `display` text is chosen to hit the analyte-registry aliases (systolic/
 * diastolic/heart rate/weight/BMI) so canonicalize() assigns the right analyteId & range.
 * Vital types with no registry analyte (height, temperature, spo2) are skipped.
 */
function vitalToObservations(v: ExtractedVital): RawObs[] {
  const out: RawObs[] = [];
  const t = (v.type ?? "").toLowerCase();
  if (t === "blood_pressure" || v.systolic != null || v.diastolic != null) {
    if (v.systolic != null) out.push({ display: "Systolic blood pressure", valueNum: v.systolic, unit: v.unit ?? "mmHg" });
    if (v.diastolic != null) out.push({ display: "Diastolic blood pressure", valueNum: v.diastolic, unit: v.unit ?? "mmHg" });
    return out;
  }
  if (t === "heart_rate" && (v.pulse != null || v.valueNum != null)) {
    out.push({ display: "Heart rate", valueNum: v.pulse ?? v.valueNum, unit: v.unit ?? "bpm" });
    return out;
  }
  // Single-value vitals that map to a registry analyte by display text.
  const single: Record<string, string> = { weight: "Weight", body_weight: "Weight", bmi: "BMI" };
  const display = single[t];
  if (display && v.valueNum != null) out.push({ display, valueNum: v.valueNum, unit: v.unit });
  return out;
}

/** Persist a normalized bundle into the FHIR-lite tables. Returns counts for the job summary. */
export async function persistBundle(
  userId: string,
  documentId: string,
  sourceType: SourceType,
  bundle: ExtractedBundle,
): Promise<{ observations: number; conditions: number; medications: number; reports: number; allergies: number; appointments: number; vitals: number; immunizations: number }> {
  const base = { userId, documentId, sourceType };

  // A report groups its observations; create it first so observations can link to it.
  let reportId: string | undefined;
  const firstReport = bundle.reports?.[0];
  if (firstReport) {
    const r = await prisma.diagnosticReport.create({
      data: {
        ...base,
        display: firstReport.display,
        category: firstReport.category,
        issuedAt: date(firstReport.issuedAt),
        confidence: firstReport.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(firstReport),
      },
    });
    reportId = r.id;
  }

  // Demographics drive age/sex-aware reference ranges during canonicalization. Normalize the raw
  // sex value ("Male"/"M"/…) at this boundary so canonicalize() reliably gets "M"/"F".
  const demo = await prisma.user.findUnique({ where: { id: userId }, select: { dob: true, sex: true } });
  const age = ageFrom(demo?.dob);
  const sex = normSex(demo?.sex);
  let observations = 0;
  for (const o of bundle.observations ?? []) {
    const c = canonicalize(o, { age, sex });
    const eff = date(o.effectiveAt);
    // Reconcile: skip only an *exact* re-ingest (same analyte + value + source on the same day) so
    // distinct same-day readings (e.g. AM/PM glucose) are both kept.
    if (c.analyteId && eff && (await sameDayDuplicateExists(userId, c.analyteId, eff, o.valueNum, sourceType))) continue;
    await prisma.observation.create({
      data: {
        ...base,
        reportId,
        code: o.code,
        display: o.display,
        valueNum: o.valueNum,
        valueString: o.valueString,
        unit: o.unit,
        referenceRange: o.referenceRange,
        abnormalFlag: c.abnormalFlag ?? o.abnormalFlag,
        analyteId: c.analyteId,
        canonicalValue: c.canonicalValue,
        canonicalUnit: c.canonicalUnit,
        refLow: c.refLow,
        refHigh: c.refHigh,
        effectiveAt: eff,
        confidence: o.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(o),
      },
    });
    observations++;
  }
  for (const c of bundle.conditions ?? []) {
    await prisma.condition.create({
      data: {
        ...base,
        code: c.code,
        display: c.display,
        clinicalStatus: c.clinicalStatus,
        onsetDate: date(c.onsetDate),
        severity: c.severity,
        confidence: c.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(c),
      },
    });
  }
  for (const m of bundle.medications ?? []) {
    const startDate = date(m.startDate);
    // Compute the next refill date when we know start + supply duration.
    const nextRefillDue = startDate && m.daysSupply ? new Date(startDate.getTime() + m.daysSupply * 86_400_000) : undefined;
    await prisma.medicationStatement.create({
      data: {
        ...base,
        display: m.display,
        rxNormCode: m.rxNormCode,
        dosage: m.dosage,
        doseValue: m.doseValue,
        doseUnit: m.doseUnit,
        frequency: m.frequency,
        route: m.route,
        daysSupply: m.daysSupply,
        nextRefillDue,
        status: m.status,
        startDate,
        endDate: date(m.endDate),
        confidence: m.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(m),
      },
    });
  }
  for (const v of bundle.vitals ?? []) {
    await prisma.vitalSign.create({
      data: {
        ...base,
        type: v.type,
        systolic: v.systolic,
        diastolic: v.diastolic,
        pulse: v.pulse,
        valueNum: v.valueNum,
        unit: v.unit,
        measuredAt: date(v.measuredAt),
        confidence: v.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(v),
      },
    });

    // --- Vitals → canonical Observations bridge (item #9) -------------------------------------
    // VitalSign rows carry no analyteId/canonicalValue, but trends.ts and the bp_monitoring
    // guideline read Observation.analyteId. So we ALSO emit canonical Observations for each vital
    // component (BP systolic/diastolic, heart rate, weight, BMI) here. This is what makes BP/weight
    // trends and the "BP check may be due" alert actually fire. Kept self-contained in
    // `vitalToObservations` below so it's easy to see/preserve.
    // NOTE TO BOOKINGS SPECIALIST: this loop body (and `vitalToObservations`) is the labs vitals
    // bridge — please don't drop it when you edit fhir-map.ts.
    const eff = date(v.measuredAt);
    for (const raw of vitalToObservations(v)) {
      const c = canonicalize(raw, { age, sex });
      if (!c.analyteId) continue;
      if (eff && (await sameDayDuplicateExists(userId, c.analyteId, eff, raw.valueNum, sourceType))) continue;
      await prisma.observation.create({
        data: {
          ...base,
          reportId,
          code: raw.code,
          display: raw.display,
          valueNum: raw.valueNum,
          unit: raw.unit,
          abnormalFlag: c.abnormalFlag,
          analyteId: c.analyteId,
          canonicalValue: c.canonicalValue,
          canonicalUnit: c.canonicalUnit,
          refLow: c.refLow,
          refHigh: c.refHigh,
          effectiveAt: eff,
          confidence: v.confidence ?? DEFAULT_CONFIDENCE,
          rawJson: toJson({ derivedFromVital: v.type, ...raw }),
        },
      });
    }
  }
  for (const im of bundle.immunizations ?? []) {
    await prisma.immunization.create({
      data: {
        ...base,
        cvxCode: im.cvxCode,
        display: im.display,
        administeredAt: date(im.administeredAt),
        doseNumber: im.doseNumber,
        series: im.series,
        confidence: im.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(im),
      },
    });
  }
  for (const a of bundle.allergies ?? []) {
    await prisma.allergyIntolerance.create({
      data: {
        ...base,
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
        confidence: a.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(a),
      },
    });
  }
  for (const ap of bundle.appointments ?? []) {
    await prisma.appointment.create({
      data: {
        ...base,
        title: ap.title,
        provider: ap.provider,
        providerPhone: ap.providerPhone,
        providerWebsite: ap.providerWebsite,
        providerAddress: ap.providerAddress,
        location: ap.location,
        startsAt: date(ap.startsAt),
        endsAt: date(ap.endsAt),
        status: ap.status ?? "scheduled",
        confirmation: ap.confirmation,
        notes: ap.notes,
        confidence: ap.confidence ?? DEFAULT_CONFIDENCE,
        rawJson: toJson(ap),
      },
    });
  }

  return {
    observations,
    conditions: bundle.conditions?.length ?? 0,
    medications: bundle.medications?.length ?? 0,
    reports: bundle.reports?.length ?? 0,
    allergies: bundle.allergies?.length ?? 0,
    appointments: bundle.appointments?.length ?? 0,
    vitals: bundle.vitals?.length ?? 0,
    immunizations: bundle.immunizations?.length ?? 0,
  };
}

/**
 * Map a FHIR resource (or Bundle) — from HealthKit/aggregator — into an ExtractedBundle.
 * Handles the common resource types; unknown types are ignored (rawJson on rows preserves fidelity).
 */
export function fhirToBundle(fhir: unknown): ExtractedBundle {
  const out: ExtractedBundle = { observations: [], conditions: [], medications: [], reports: [], allergies: [], appointments: [], vitals: [], immunizations: [] };
  const resources: unknown[] = isBundle(fhir)
    ? (fhir.entry ?? []).map((e) => e.resource)
    : [fhir];

  // First pass: index Practitioner resources by reference id so an Appointment that points at one
  // ("Practitioner/123") can resolve a real provider name instead of dropping it (item #6).
  const practitioners = new Map<string, string>();
  for (const res of resources) {
    const r = res as Record<string, unknown> | null;
    if (r && typeof r === "object" && r.resourceType === "Practitioner") {
      const name = practitionerName(r);
      const id = typeof r.id === "string" ? r.id : undefined;
      if (id && name) practitioners.set(`Practitioner/${id}`, name);
    }
  }

  for (const res of resources) {
    if (!res || typeof res !== "object") continue;
    const r = res as Record<string, unknown>;
    switch (r.resourceType) {
      case "Observation":
        out.observations!.push({
          code: codeOf(r.code),
          display: textOf(r.code) ?? "Observation",
          valueNum: typeof (r.valueQuantity as any)?.value === "number" ? (r.valueQuantity as any).value : undefined,
          unit: (r.valueQuantity as any)?.unit,
          valueString: typeof r.valueString === "string" ? r.valueString : undefined,
          effectiveAt: typeof r.effectiveDateTime === "string" ? r.effectiveDateTime : undefined,
          confidence: 1,
        });
        break;
      case "Condition":
        out.conditions!.push({
          code: codeOf(r.code),
          display: textOf(r.code) ?? "Condition",
          clinicalStatus: textOf(r.clinicalStatus),
          onsetDate: typeof r.onsetDateTime === "string" ? r.onsetDateTime : undefined,
          confidence: 1,
        });
        break;
      case "MedicationStatement":
      case "MedicationRequest":
        out.medications!.push({
          display: textOf(r.medicationCodeableConcept) ?? "Medication",
          confidence: 1,
        });
        break;
      case "AllergyIntolerance":
        out.allergies!.push({ substance: textOf(r.code) ?? "Allergen", confidence: 1 });
        break;
      case "DiagnosticReport":
        out.reports!.push({ display: textOf(r.code) ?? "Diagnostic report", confidence: 1 });
        break;
      case "Appointment":
        out.appointments!.push({
          title: typeof r.description === "string" ? r.description : (textOf(r.serviceType) ?? "Appointment"),
          provider: appointmentProvider(r, practitioners),
          startsAt: typeof r.start === "string" ? r.start : undefined,
          endsAt: typeof r.end === "string" ? r.end : undefined,
          status: typeof r.status === "string" ? r.status : undefined,
          confidence: 1,
        });
        break;
      case "Immunization":
        out.immunizations!.push({
          cvxCode: codeOf(r.vaccineCode),
          display: textOf(r.vaccineCode) ?? "Immunization",
          administeredAt: typeof r.occurrenceDateTime === "string" ? r.occurrenceDateTime : undefined,
          confidence: 1,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function isBundle(x: unknown): x is { entry?: { resource: unknown }[] } {
  return Boolean(x && typeof x === "object" && (x as any).resourceType === "Bundle");
}
function codeOf(cc: unknown): string | undefined {
  const coding = (cc as any)?.coding?.[0];
  return coding?.code;
}
function textOf(cc: unknown): string | undefined {
  const c = cc as any;
  return c?.text ?? c?.coding?.[0]?.display;
}

/** Human-readable name from a FHIR Practitioner (HumanName[0]). */
function practitionerName(r: Record<string, unknown>): string | undefined {
  const n = (r.name as any)?.[0] ?? r.name;
  if (!n) return undefined;
  if (typeof n.text === "string" && n.text.trim()) return n.text.trim();
  const given = Array.isArray(n.given) ? n.given.join(" ") : "";
  const full = [n.prefix?.[0], given, n.family].filter(Boolean).join(" ").trim();
  return full || undefined;
}

/**
 * Resolve the provider for a FHIR Appointment from its participants: prefer a participant whose
 * actor references an indexed Practitioner; else fall back to the actor's display text. Returns
 * undefined when no provider is named.
 */
function appointmentProvider(r: Record<string, unknown>, practitioners: Map<string, string>): string | undefined {
  const participants = Array.isArray(r.participant) ? (r.participant as any[]) : [];
  for (const p of participants) {
    const ref = p?.actor?.reference;
    if (typeof ref === "string" && practitioners.has(ref)) return practitioners.get(ref);
  }
  for (const p of participants) {
    const display = p?.actor?.display;
    if (typeof display === "string" && display.trim()) return display.trim();
  }
  return undefined;
}
