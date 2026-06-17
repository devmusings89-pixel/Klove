// Aggregate analysis pass: looks across a user's normalized records and emits HealthAlerts.
// Deterministic range-checks run first (cheap, never hallucinate); when Claude is configured an
// additional "connect the dots across diagnoses" pass adds higher-order alerts. Alerts are framed
// as things to discuss with a provider — never as diagnosis.

import Anthropic from "@anthropic-ai/sdk";
import { runTool, llmAvailable } from "./llm-tool.js";
import { prisma } from "../db.js";
import { toJson, fromJson } from "./json.js";
import type { DraftAlert } from "./insights-types.js";
import { evaluateGuidelines } from "./guidelines.js";
import { detectMedIssues } from "./med-safety.js";
import { trendAlerts } from "./trends.js";

/** Higher rank surfaces nearer the top of the Today briefing. */
function rankFor(severity: DraftAlert["severity"]): number {
  return severity === "urgent" ? 100 : severity === "watch" ? 60 : 30;
}

const ALERT_TOOL: Anthropic.Tool = {
  name: "emit_alerts",
  description:
    "Emit health alerts that connect findings across the patient's records (trends, condition/medication " +
    "interactions, things to be aware of). Only emit well-supported alerts. Always phrase as something to " +
    "discuss with a provider; never state a diagnosis.",
  input_schema: {
    type: "object",
    properties: {
      alerts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["info", "watch", "urgent"] },
            title: { type: "string" },
            detail: { type: "string" },
            relatedResourceIds: { type: "array", items: { type: "string" } },
          },
          required: ["severity", "title", "detail"],
        },
      },
    },
    required: ["alerts"],
  },
};

/** Run analysis for one user and persist any new alerts. Returns the number created. */
export async function runAnalysis(userId: string, generatedByJobId?: string): Promise<number> {
  const [observations, conditions, medications, immunizations, demo] = await Promise.all([
    prisma.observation.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 300 }),
    prisma.condition.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.medicationStatement.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.immunization.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.user.findUnique({ where: { id: userId }, select: { dob: true, sex: true } }),
  ]);

  const drafts: DraftAlert[] = [];

  // 1) Deterministic: flag abnormal observations (uses derived flag from canonicalization).
  for (const o of observations) {
    if (o.abnormalFlag && o.abnormalFlag !== "N") {
      drafts.push({
        severity: o.abnormalFlag === "H" || o.abnormalFlag === "L" ? "watch" : "info",
        category: "abnormal",
        title: `${o.display} out of range`,
        detail: `${o.display} was ${o.canonicalValue ?? o.valueNum ?? o.valueString ?? "?"}${o.canonicalUnit ?? (o.unit ? " " + o.unit : "")}` +
          `${o.refLow != null || o.refHigh != null ? ` (reference ${o.refLow ?? ""}–${o.refHigh ?? ""})` : o.referenceRange ? ` (reference ${o.referenceRange})` : ""}. Consider discussing with your provider.`,
        relatedResourceIds: [o.id],
        followUpType: "retest",
        recommendedSpecialty: "primary care",
        daysToAction: 30,
        guideline: "Reference range",
      });
    }
  }

  // 1b) Screening / vaccine / monitoring / med-therapy gaps from the evidence-based catalog.
  drafts.push(
    ...evaluateGuidelines(
      { dob: demo?.dob, sex: demo?.sex },
      {
        conditions: conditions.map((c) => ({ id: c.id, display: c.display, clinicalStatus: c.clinicalStatus })),
        observations: observations.map((o) => ({ analyteId: o.analyteId, effectiveAt: o.effectiveAt, recordedAt: o.recordedAt })),
        immunizations: immunizations.map((i) => ({ display: i.display, administeredAt: i.administeredAt, recordedAt: i.recordedAt })),
        medications: medications.map((m) => ({ display: m.display, status: m.status })),
      },
    ),
  );

  // 1c) Medication safety: duplication, interactions, refills.
  drafts.push(
    ...detectMedIssues(
      medications.map((m) => ({ id: m.id, display: m.display, rxNormCode: m.rxNormCode, status: m.status, nextRefillDue: m.nextRefillDue })),
    ),
  );

  // 1d) Longitudinal trends across canonical values.
  drafts.push(...trendAlerts(observations));

  // 2) LLM cross-diagnosis pass (only when configured).
  if (llmAvailable() && (conditions.length || observations.length)) {
    try {
      drafts.push(...(await llmAlerts(observations, conditions, medications)));
    } catch (err) {
      console.error("analysis llm pass failed:", err);
    }
  }

  // The member's household (for spawning Tasks into the Today briefing). Skip task creation if the
  // user somehow isn't in a household yet (pre-backfill).
  const membership = await prisma.householdMembership.findFirst({ where: { userId }, select: { householdId: true } });

  // Dedup key: an alert is "the same" only if its title AND the set of records it points at match.
  // Keying on title alone would let an open alert swallow a genuinely new/worsening finding (e.g. a
  // second abnormal result for the same analyte, with a different observation id). Including the
  // related resource ids (sorted, stable) distinguishes those.
  const keyOf = (title: string, ids: string[] | undefined): string =>
    `${title}::${[...(ids ?? [])].sort().join(",")}`;

  // Persist, skipping (title+resources) that already have an unacknowledged alert (idempotent re-runs).
  const existing = await prisma.healthAlert.findMany({
    where: { userId, acknowledgedAt: null },
    select: { title: true, relatedResourceIds: true },
  });
  const seen = new Set(existing.map((a) => keyOf(a.title, fromJson<string[]>(a.relatedResourceIds, []))));
  let created = 0;
  for (const d of drafts) {
    const k = keyOf(d.title, d.relatedResourceIds);
    if (seen.has(k)) continue;
    seen.add(k);
    const alert = await prisma.healthAlert.create({
      data: {
        userId,
        severity: d.severity,
        rank: rankFor(d.severity),
        category: d.category,
        title: d.title,
        detail: d.detail,
        relatedResourceIds: toJson(d.relatedResourceIds),
        followUpType: d.followUpType,
        recommendedSpecialty: d.recommendedSpecialty,
        daysToAction: d.daysToAction,
        guideline: d.guideline,
        generatedByJobId,
      },
    });
    // Actionable insights (watch/urgent) become an approvable Task in Today. Info stays an insight.
    if (membership && d.severity !== "info") {
      const followUp = d.followUpType || d.recommendedSpecialty || d.daysToAction || d.guideline
        ? toJson({ followUpType: d.followUpType, recommendedSpecialty: d.recommendedSpecialty, daysToAction: d.daysToAction, guideline: d.guideline })
        : null;
      await prisma.task.create({
        data: {
          subjectUserId: userId,
          householdId: membership.householdId,
          title: d.title,
          detail: d.detail,
          state: "needs_you",
          kind: "review",
          sourceInsightId: alert.id,
          followUpJson: followUp,
        },
      });
    }
    created++;
  }
  return created;
}

async function llmAlerts(
  observations: { id: string; display: string; valueNum: number | null; unit: string | null; effectiveAt: Date | null }[],
  conditions: { id: string; display: string; clinicalStatus: string | null }[],
  medications: { id: string; display: string; dosage: string | null }[],
): Promise<DraftAlert[]> {
  const summary = [
    "Conditions:",
    ...conditions.map((c) => `- ${c.display} [${c.id}] (${c.clinicalStatus ?? "?"})`),
    "Medications:",
    ...medications.map((m) => `- ${m.display} [${m.id}] ${m.dosage ?? ""}`),
    "Observations (recent first):",
    ...observations.slice(0, 60).map((o) => `- ${o.display} [${o.id}] = ${o.valueNum ?? "?"} ${o.unit ?? ""} @ ${o.effectiveAt?.toISOString().slice(0, 10) ?? "?"}`),
  ].join("\n");

  const out = await runTool<{ alerts?: DraftAlert[] }>({
    system: "You analyze a patient's longitudinal records to surface things to be aware of. Be conservative.",
    content: `Here are the patient's records:\n\n${summary}\n\nEmit any well-supported alerts.`,
    tool: { name: ALERT_TOOL.name, description: ALERT_TOOL.description ?? "", input_schema: ALERT_TOOL.input_schema as Record<string, unknown> },
    maxTokens: 2000,
  });
  return (out?.alerts ?? []).map((a) => ({ ...a, relatedResourceIds: a.relatedResourceIds ?? [] }));
}
