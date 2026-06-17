// Evidence-based screening / vaccine / monitoring / med-therapy catalog (data, not code) + an
// evaluator that turns it into care-gap DraftAlerts for one person. Conservative + cited; every
// alert is "consider / discuss with your provider," never a directive or diagnosis.
//
// Sources are summarized in `citation` (USPSTF / ADA / ACC / CDC ACIP). Cadences are simplified to a
// single interval; the goal is to surface a likely gap to discuss, not to be a clinical authority.

import type { DraftAlert } from "./insights-types.js";

type Category = "screening" | "vaccine" | "monitoring" | "med_therapy";

interface Guideline {
  id: string;
  title: string;
  category: Category;
  ageMin?: number;
  ageMax?: number;
  sex?: "M" | "F";
  requiredCondition?: RegExp; // only applies if an active condition matches
  cadenceDays: number; // considered "due" if no satisfying record within this window
  // What counts as "done recently": an observation analyteId, an immunization match, or a medication match.
  satisfiedByAnalyte?: string;
  satisfiedByImmunization?: RegExp;
  satisfiedByMedication?: RegExp;
  // Can we actually verify completion from the data? If false, we emit a gentle info nudge (we can't
  // know if it was done elsewhere) rather than a confident "overdue".
  verifiable: boolean;
  severity: "info" | "watch";
  followUpType: string;
  recommendedSpecialty?: string;
  daysToAction?: number;
  citation: string;
  detail: string;
}

const YEAR = 365;

export const GUIDELINES: Guideline[] = [
  // ---- Screening (verifiable via labs) ----
  { id: "lipid_panel", title: "Lipid panel may be due", category: "screening", ageMin: 40, ageMax: 75, cadenceDays: 5 * YEAR,
    satisfiedByAnalyte: "ldl", verifiable: true, severity: "info", followUpType: "retest", recommendedSpecialty: "primary care", daysToAction: 60,
    citation: "USPSTF / ACC-AHA", detail: "Routine cholesterol screening is recommended for adults 40–75 and there's no recent lipid result on file. Consider a lipid panel and discussing cardiovascular risk with your provider." },

  // ---- Screening (not verifiable from current data — gentle nudge) ----
  { id: "colorectal", title: "Colorectal cancer screening may be due", category: "screening", ageMin: 45, ageMax: 75, cadenceDays: 10 * YEAR,
    verifiable: false, severity: "info", followUpType: "book_visit", recommendedSpecialty: "primary care", daysToAction: 90,
    citation: "USPSTF Grade A (45–75)", detail: "Adults 45–75 should be screened for colorectal cancer (colonoscopy or stool-based test). If you haven't been screened recently, consider discussing options with your provider." },
  { id: "mammogram", title: "Mammogram may be due", category: "screening", ageMin: 40, ageMax: 74, sex: "F", cadenceDays: 2 * YEAR,
    verifiable: false, severity: "info", followUpType: "book_visit", recommendedSpecialty: "radiology", daysToAction: 90,
    citation: "USPSTF (biennial, 40–74)", detail: "Biennial mammography is recommended for women 40–74. If it's been a while, consider scheduling and discussing with your provider." },
  { id: "cervical", title: "Cervical cancer screening may be due", category: "screening", ageMin: 21, ageMax: 65, sex: "F", cadenceDays: 3 * YEAR,
    verifiable: false, severity: "info", followUpType: "book_visit", recommendedSpecialty: "gynecology", daysToAction: 90,
    citation: "USPSTF (21–65)", detail: "Cervical cancer screening (Pap/HPV) is recommended for women 21–65. Consider discussing your last screening date with your provider." },
  { id: "bone_density", title: "Bone density screening may be due", category: "screening", ageMin: 65, sex: "F", cadenceDays: 5 * YEAR,
    verifiable: false, severity: "info", followUpType: "book_visit", recommendedSpecialty: "primary care", daysToAction: 90,
    citation: "USPSTF (women 65+)", detail: "Women 65+ should be screened for osteoporosis (DEXA). If you haven't had a bone-density scan, consider discussing it with your provider." },
  { id: "aaa", title: "One-time AAA ultrasound may be appropriate", category: "screening", ageMin: 65, ageMax: 75, sex: "M", cadenceDays: 100 * YEAR,
    verifiable: false, severity: "info", followUpType: "book_visit", recommendedSpecialty: "primary care", daysToAction: 120,
    citation: "USPSTF (men 65–75 who ever smoked)", detail: "Men 65–75 who have ever smoked are advised to have a one-time abdominal aortic aneurysm ultrasound. Consider discussing with your provider." },

  // ---- Condition monitoring (verifiable) ----
  { id: "a1c_monitoring", title: "A1c check may be due", category: "monitoring", requiredCondition: /diabet/i, cadenceDays: 180,
    satisfiedByAnalyte: "a1c", verifiable: true, severity: "watch", followUpType: "retest", recommendedSpecialty: "endocrinology", daysToAction: 30,
    citation: "ADA Standards of Care", detail: "You have an active diabetes diagnosis and no recent A1c on file. Consider an A1c and discussing your targets with your provider." },
  { id: "bp_monitoring", title: "Blood pressure check may be due", category: "monitoring", requiredCondition: /hypertens|high blood pressure/i, cadenceDays: 180,
    satisfiedByAnalyte: "bp_systolic", verifiable: true, severity: "info", followUpType: "retest", recommendedSpecialty: "primary care", daysToAction: 30,
    citation: "ACC-AHA", detail: "You have an active hypertension diagnosis and no recent blood-pressure reading on file. Consider a check and discussing it with your provider." },
  { id: "kidney_monitoring", title: "Kidney function recheck may be due", category: "monitoring", requiredCondition: /chronic kidney|ckd|renal/i, cadenceDays: 365,
    satisfiedByAnalyte: "egfr", verifiable: true, severity: "watch", followUpType: "retest", recommendedSpecialty: "nephrology", daysToAction: 45,
    citation: "KDIGO", detail: "With a kidney condition on file and no recent eGFR, consider a renal panel and discussing it with your provider." },

  // ---- Vaccines (verifiable via immunization records) ----
  { id: "flu", title: "Flu vaccine may be due", category: "vaccine", ageMin: 18, cadenceDays: YEAR,
    satisfiedByImmunization: /influenza|flu/i, verifiable: true, severity: "info", followUpType: "vaccine", daysToAction: 60,
    citation: "CDC ACIP (annual)", detail: "Annual influenza vaccination is recommended and there's no flu shot on file in the past year. Consider getting one." },
  { id: "tdap", title: "Tdap/Td booster may be due", category: "vaccine", ageMin: 18, cadenceDays: 10 * YEAR,
    satisfiedByImmunization: /tdap|tetanus|td booster|dtap/i, verifiable: true, severity: "info", followUpType: "vaccine", daysToAction: 90,
    citation: "CDC ACIP (every 10y)", detail: "A tetanus (Td/Tdap) booster is recommended every 10 years and none is on file. Consider discussing with your provider." },
  { id: "shingles", title: "Shingles vaccine may be due", category: "vaccine", ageMin: 50, cadenceDays: 100 * YEAR,
    satisfiedByImmunization: /zoster|shingrix|shingles/i, verifiable: true, severity: "info", followUpType: "vaccine", daysToAction: 90,
    citation: "CDC ACIP (50+)", detail: "Adults 50+ are recommended to get the shingles (zoster) vaccine series, and none is on file. Consider discussing it with your provider." },
  { id: "pneumococcal", title: "Pneumococcal vaccine may be due", category: "vaccine", ageMin: 65, cadenceDays: 100 * YEAR,
    satisfiedByImmunization: /pneumococc|pcv|ppsv|prevnar|pneumovax/i, verifiable: true, severity: "info", followUpType: "vaccine", daysToAction: 90,
    citation: "CDC ACIP (65+)", detail: "Adults 65+ are recommended to receive pneumococcal vaccination, and none is on file. Consider discussing it with your provider." },

  // ---- Medication therapy gaps (verifiable via meds) ----
  { id: "statin_diabetes", title: "Statin therapy worth discussing", category: "med_therapy", requiredCondition: /diabet/i, ageMin: 40, ageMax: 75, cadenceDays: 100 * YEAR,
    satisfiedByMedication: /statin|atorvastatin|rosuvastatin|simvastatin|pravastatin|lovastatin/i, verifiable: true, severity: "info",
    followUpType: "med_review", recommendedSpecialty: "primary care", daysToAction: 60,
    citation: "ADA / ACC-AHA", detail: "Guidelines suggest most adults 40–75 with diabetes benefit from a statin, and none is on file. Consider discussing cholesterol-lowering therapy with your provider." },
];

export interface GuidelineRecords {
  conditions: { id: string; display: string; clinicalStatus: string | null }[];
  observations: { analyteId: string | null; effectiveAt: Date | null; recordedAt: Date }[];
  immunizations: { display: string; administeredAt: Date | null; recordedAt: Date }[];
  medications: { display: string; status: string | null }[];
}

/** Whole-years age from a date of birth. */
export function ageFromDob(dob?: Date | null): number | undefined {
  if (!dob) return undefined;
  const ms = Date.now() - dob.getTime();
  return ms > 0 ? Math.floor(ms / (365.25 * 86_400_000)) : undefined;
}

/** Evaluate the catalog for one person; emit a DraftAlert per due/overdue (and unverifiable) gap. */
export function evaluateGuidelines(
  demo: { dob?: Date | null; sex?: string | null },
  records: GuidelineRecords,
): DraftAlert[] {
  const age = ageFromDob(demo.dob);
  const sex = demo.sex === "M" || demo.sex === "F" ? demo.sex : undefined;
  const now = Date.now();
  const activeConds = records.conditions.filter((c) => (c.clinicalStatus ?? "active") === "active");
  const out: DraftAlert[] = [];

  for (const g of GUIDELINES) {
    // Applicability gates.
    if (g.ageMin !== undefined && (age === undefined || age < g.ageMin)) continue;
    if (g.ageMax !== undefined && (age === undefined || age > g.ageMax)) continue;
    if (g.sex && g.sex !== sex) continue;
    if (g.requiredCondition && !activeConds.some((c) => g.requiredCondition!.test(c.display))) continue;

    // Satisfied recently?
    const within = (t?: number) => t !== undefined && now - t <= g.cadenceDays * 86_400_000;
    let satisfied = false;
    if (g.satisfiedByAnalyte) {
      const latest = records.observations
        .filter((o) => o.analyteId === g.satisfiedByAnalyte)
        .map((o) => (o.effectiveAt ?? o.recordedAt).getTime())
        .sort((a, b) => b - a)[0];
      satisfied = within(latest);
    } else if (g.satisfiedByImmunization) {
      const latest = records.immunizations
        .filter((i) => g.satisfiedByImmunization!.test(i.display))
        .map((i) => (i.administeredAt ?? i.recordedAt).getTime())
        .sort((a, b) => b - a)[0];
      satisfied = within(latest);
    } else if (g.satisfiedByMedication) {
      satisfied = records.medications.some((m) => (m.status ?? "active") === "active" && g.satisfiedByMedication!.test(m.display));
    }
    if (satisfied) continue;

    out.push({
      severity: g.severity,
      category: g.category,
      title: g.title,
      detail: g.detail,
      relatedResourceIds: [],
      followUpType: g.followUpType,
      recommendedSpecialty: g.recommendedSpecialty,
      daysToAction: g.daysToAction,
      guideline: g.citation,
    });
  }
  return out;
}
