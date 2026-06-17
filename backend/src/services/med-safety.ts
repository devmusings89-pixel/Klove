// Deterministic medication-safety checks over a person's active medications: duplicate therapy,
// a CURATED (non-exhaustive) set of high-severity interaction pairs, and refill-due reminders.
// Emits cited DraftAlerts. Always "discuss with your provider / pharmacist," never a directive.
// This is a safety *prompt*, not a complete interaction service — labeled as such in the detail.

import type { DraftAlert } from "./insights-types.js";

export interface MedRecord {
  id: string;
  display: string;
  rxNormCode?: string | null;
  status?: string | null;
  nextRefillDue?: Date | null;
}

// Curated high-severity interaction pairs (RxNorm not required — matched on common names/classes).
const INTERACTIONS: { a: RegExp; b: RegExp; severity: "watch" | "urgent"; detail: string }[] = [
  { a: /warfarin|coumadin/i, b: /ibuprofen|naproxen|nsaid|aspirin|aleve|advil|diclofenac|meloxicam/i, severity: "watch",
    detail: "Combining a blood thinner (warfarin) with NSAIDs/aspirin can raise bleeding risk." },
  { a: /lisinopril|enalapril|ramipril|benazepril|losartan|valsartan|olmesartan|ace inhibitor|\barb\b/i, b: /spironolactone|triamterene|amiloride|eplerenone|potassium/i, severity: "watch",
    detail: "An ACE inhibitor/ARB taken with a potassium-sparing agent or potassium can raise potassium levels." },
  { a: /simvastatin|atorvastatin|lovastatin/i, b: /clarithromycin|erythromycin|itraconazole|ketoconazole|gemfibrozil/i, severity: "watch",
    detail: "This combination can raise statin levels and the risk of muscle injury." },
  { a: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|\bssri\b/i, b: /phenelzine|tranylcypromine|selegiline|\bmaoi\b/i, severity: "urgent",
    detail: "SSRIs combined with MAOIs risk serotonin syndrome." },
  { a: /oxycodone|hydrocodone|morphine|fentanyl|tramadol|opioid|percocet|norco/i, b: /alprazolam|lorazepam|diazepam|clonazepam|benzodiazepine|xanax|ativan|valium/i, severity: "watch",
    detail: "Opioids with benzodiazepines increase sedation and respiratory-depression risk." },
];

const SAFETY_NOTE = " (Automated safety prompt — not a complete interaction check; confirm with your provider or pharmacist.)";

/** Run medication-safety checks. `now` is injectable for testing. */
export function detectMedIssues(meds: MedRecord[], now: number = Date.now()): DraftAlert[] {
  const active = meds.filter((m) => (m.status ?? "active") === "active");
  const out: DraftAlert[] = [];

  // 1) Duplicate therapy: same ingredient (rxNorm or first word of the name) appears more than once.
  const byKey = new Map<string, MedRecord[]>();
  for (const m of active) {
    const key = (m.rxNormCode || m.display.toLowerCase().split(/[\s,/(]/)[0]).trim();
    if (!key) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(m);
  }
  for (const [, group] of byKey) {
    if (group.length > 1) {
      out.push({
        severity: "watch",
        category: "med_safety",
        title: `Possible duplicate medication: ${group[0].display}`,
        detail: `Two or more active medications look like the same drug (${group.map((g) => g.display).join(", ")}). Consider confirming this is intentional with your provider or pharmacist.${SAFETY_NOTE}`,
        relatedResourceIds: group.map((g) => g.id),
        followUpType: "med_review",
        recommendedSpecialty: "primary care",
        daysToAction: 14,
        guideline: "Medication reconciliation",
      });
    }
  }

  // 2) Interaction pairs.
  for (const rule of INTERACTIONS) {
    const aMed = active.find((m) => rule.a.test(m.display));
    const bMed = active.find((m) => rule.b.test(m.display) && m.id !== aMed?.id);
    if (aMed && bMed) {
      out.push({
        severity: rule.severity,
        category: "med_safety",
        title: `Possible interaction: ${aMed.display} + ${bMed.display}`,
        detail: `${rule.detail}${SAFETY_NOTE}`,
        relatedResourceIds: [aMed.id, bMed.id],
        followUpType: "med_review",
        recommendedSpecialty: "primary care",
        daysToAction: rule.severity === "urgent" ? 2 : 14,
        guideline: "Drug-interaction reference",
      });
    }
  }

  // 3) Refill due (within 7 days or already past).
  for (const m of active) {
    if (m.nextRefillDue && m.nextRefillDue.getTime() <= now + 7 * 86_400_000) {
      const overdue = m.nextRefillDue.getTime() < now;
      out.push({
        severity: "info",
        category: "med_safety",
        title: `Refill ${overdue ? "overdue" : "due soon"}: ${m.display}`,
        detail: `Your supply of ${m.display} is ${overdue ? "estimated to have run out" : "running low"}. Consider requesting a refill so you don't miss doses.`,
        relatedResourceIds: [m.id],
        followUpType: "refill",
        daysToAction: overdue ? 1 : 7,
        guideline: "Adherence",
      });
    }
  }

  return out;
}
