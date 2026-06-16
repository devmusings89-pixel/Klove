// Aggregate analysis pass: looks across a user's normalized records and emits HealthAlerts.
// Deterministic range-checks run first (cheap, never hallucinate); when Claude is configured an
// additional "connect the dots across diagnoses" pass adds higher-order alerts. Alerts are framed
// as things to discuss with a provider — never as diagnosis.

import Anthropic from "@anthropic-ai/sdk";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";
import { toJson } from "./json.js";

interface DraftAlert {
  severity: "info" | "watch" | "urgent";
  title: string;
  detail: string;
  relatedResourceIds: string[];
  category?: string;
}

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
  const [observations, conditions, medications] = await Promise.all([
    prisma.observation.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 200 }),
    prisma.condition.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.medicationStatement.findMany({ where: { userId }, orderBy: { recordedAt: "desc" }, take: 100 }),
  ]);

  const drafts: DraftAlert[] = [];

  // 1) Deterministic: flag abnormal observations.
  for (const o of observations) {
    if (o.abnormalFlag && o.abnormalFlag !== "N") {
      drafts.push({
        severity: o.abnormalFlag === "H" || o.abnormalFlag === "L" ? "watch" : "info",
        title: `${o.display} out of range`,
        detail: `${o.display} was ${o.valueNum ?? o.valueString ?? "?"}${o.unit ? " " + o.unit : ""}` +
          `${o.referenceRange ? ` (reference ${o.referenceRange})` : ""}. Consider discussing with your provider.`,
        relatedResourceIds: [o.id],
        category: "trend",
      });
    }
  }

  // 2) LLM cross-diagnosis pass (only when configured).
  if (enabled.healthExtraction() && (conditions.length || observations.length)) {
    try {
      drafts.push(...(await llmAlerts(observations, conditions, medications)));
    } catch (err) {
      console.error("analysis llm pass failed:", err);
    }
  }

  // The member's household (for spawning Tasks into the Today briefing). Skip task creation if the
  // user somehow isn't in a household yet (pre-backfill).
  const membership = await prisma.householdMembership.findFirst({ where: { userId }, select: { householdId: true } });

  // Persist, skipping titles that already have an unacknowledged alert (idempotent re-runs).
  const existing = await prisma.healthAlert.findMany({ where: { userId, acknowledgedAt: null }, select: { title: true } });
  const seen = new Set(existing.map((a) => a.title));
  let created = 0;
  for (const d of drafts) {
    if (seen.has(d.title)) continue;
    seen.add(d.title);
    const alert = await prisma.healthAlert.create({
      data: {
        userId,
        severity: d.severity,
        rank: rankFor(d.severity),
        category: d.category,
        title: d.title,
        detail: d.detail,
        relatedResourceIds: toJson(d.relatedResourceIds),
        generatedByJobId,
      },
    });
    // Actionable insights (watch/urgent) become an approvable Task in Today. Info stays an insight.
    if (membership && d.severity !== "info") {
      await prisma.task.create({
        data: {
          subjectUserId: userId,
          householdId: membership.householdId,
          title: d.title,
          detail: d.detail,
          state: "needs_you",
          kind: "review",
          sourceInsightId: alert.id,
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

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const resp = await client.messages.create({
    model: config.webAgent.model || "claude-opus-4-8",
    max_tokens: 2000,
    system: "You analyze a patient's longitudinal records to surface things to be aware of. Be conservative.",
    tools: [ALERT_TOOL],
    tool_choice: { type: "tool", name: "emit_alerts" },
    messages: [{ role: "user", content: `Here are the patient's records:\n\n${summary}\n\nEmit any well-supported alerts.` }],
  });
  for (const block of resp.content) {
    if (block.type === "tool_use" && block.name === "emit_alerts") {
      const out = block.input as { alerts?: DraftAlert[] };
      return (out.alerts ?? []).map((a) => ({ ...a, relatedResourceIds: a.relatedResourceIds ?? [] }));
    }
  }
  return [];
}
