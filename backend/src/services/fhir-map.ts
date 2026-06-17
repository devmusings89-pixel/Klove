// The common normalized bundle that both LLM extraction and FHIR ingestion produce, plus the
// writer that persists it into the FHIR-lite tables, and a mapper from raw FHIR → bundle.

import { prisma } from "../db.js";
import { toJson } from "./json.js";
import { canonicalize } from "./normalize.js";
import type { SourceType } from "../sources/types.js";

/** Whole-years age from a date of birth, or undefined. */
function ageFrom(dob?: Date | null): number | undefined {
  if (!dob) return undefined;
  const ms = Date.now() - dob.getTime();
  if (ms <= 0) return undefined;
  return Math.floor(ms / (365.25 * 86_400_000));
}

/** True if an observation for this analyte already exists on the same calendar day (dedup). */
async function sameDayExists(userId: string, analyteId: string, eff: Date): Promise<boolean> {
  const dayStart = new Date(eff); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(eff); dayEnd.setHours(23, 59, 59, 999);
  const hit = await prisma.observation.findFirst({
    where: { userId, analyteId, effectiveAt: { gte: dayStart, lte: dayEnd } },
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
        confidence: firstReport.confidence ?? 1,
        rawJson: toJson(firstReport),
      },
    });
    reportId = r.id;
  }

  // Demographics drive age/sex-aware reference ranges during canonicalization.
  const demo = await prisma.user.findUnique({ where: { id: userId }, select: { dob: true, sex: true } });
  const age = ageFrom(demo?.dob);
  let observations = 0;
  for (const o of bundle.observations ?? []) {
    const c = canonicalize(o, { age, sex: demo?.sex ?? undefined });
    const eff = date(o.effectiveAt);
    // Reconcile: skip an exact analyte+day duplicate (same lab re-ingested from another source).
    if (c.analyteId && eff && (await sameDayExists(userId, c.analyteId, eff))) continue;
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
        confidence: o.confidence ?? 1,
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
        confidence: c.confidence ?? 1,
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
        confidence: m.confidence ?? 1,
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
        confidence: v.confidence ?? 1,
        rawJson: toJson(v),
      },
    });
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
        confidence: im.confidence ?? 1,
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
        confidence: a.confidence ?? 1,
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
        confidence: ap.confidence ?? 1,
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
