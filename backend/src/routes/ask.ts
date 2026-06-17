import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";
import { buildTimeline, buildSeries } from "../services/graph.js";
import { triageAsk } from "../services/triage.js";
import { runText, llmAvailable } from "../services/llm-tool.js";

/**
 * The persistent "Ask Klove" surface + on-demand "Show me" views. Ask routes ~70/30 between an AI
 * answer (grounded in the family graph) and the human concierge. Show-me returns a focused, cited
 * projection — data on pull, never a dashboard.
 */
export async function askRoutes(app: FastifyInstance) {
  app.post<{ Body: { text: string } }>("/ask", { preHandler: requireUser }, async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text required" });
    const members = await accessibleSubjects(req.user!.id);

    const result = await triageAsk(text, members);

    // Record the request.
    const householdId = (await prisma.household.findUnique({ where: { operatorUserId: req.user!.id } }))?.id;
    await prisma.request.create({
      data: { operatorUserId: req.user!.id, householdId, text, kind: "ask", responseJson: JSON.stringify(result), status: result.kind === "escalated" ? "escalated" : "resolved" },
    });

    // Escalation actually DOES something: open a concierge job + a waiting task so it shows in Actions.
    let taskId: string | undefined;
    if (result.kind === "escalated" && householdId) {
      const session = await prisma.session.create({
        data: { userId: req.user!.id, tier: "human", kind: "booking", status: "draft", patientInfo: JSON.stringify({ reason: text }) },
      });
      const task = await prisma.task.create({
        data: {
          subjectUserId: req.user!.id,
          householdId,
          title: `Klove is handling: ${text.slice(0, 60)}`,
          detail: result.answer,
          state: "waiting",
          kind: "book",
          conciergeJobId: session.id,
        },
      });
      taskId = task.id;
    }
    return reply.send({ ...result, taskId });
  });

  // "Show me X for <member>": a focused, grounded view (filtered timeline) — not a dashboard.
  app.post<{ Params: { id: string }; Body: { query: string } }>(
    "/members/:id/show-me",
    { preHandler: requireUser },
    async (req, reply) => {
      let userId: string;
      try {
        userId = (await resolveSubject(req, req.params.id, { need: "view", category: "records" })).userId;
      } catch (err) {
        return reply.code(isConsentError(err) ? 403 : 500).send({ error: "forbidden" });
      }
      const query = (req.body?.query ?? "").trim();
      const timeline = await buildTimeline(userId);
      const terms = expandQueryTerms(query);
      const entries = terms.length
        ? timeline.filter((e) => terms.some((t) => e.title.toLowerCase().includes(t) || (e.detail ?? "").toLowerCase().includes(t)))
        : timeline.slice(0, 20);
      const series = query ? await buildSeries(userId, query) : null;
      // Plain-language, grounded summary (the spec's J6 headline: "what changed and why it matters,
      // said simply"). Generated ONLY from the matched records — never invented, no medical advice.
      let summary: string | null = null;
      if (query && entries.length && llmAvailable()) {
        const lines = entries
          .slice(0, 25)
          .map((e) => {
            const date = e.date ? new Date(e.date).toISOString().slice(0, 10) : "undated";
            return `- ${e.title}: ${e.detail ?? ""} (${date}${e.abnormal ? ", abnormal" : ""})`;
          })
          .join("\n");
        summary = await runText({
          system:
            "You are Klove, a calm family-health chief of staff. Answer the user's 'show me' question in 2–3 plain sentences using ONLY the records below. " +
            "State the latest value(s), whether anything is out of range, and the direction of any trend over time. " +
            "Ground every statement in the records — never invent values, never diagnose, never give medical advice. If the records don't answer the question, say so plainly.",
          content: `Question: ${query}\n\nRecords:\n${lines}`,
          maxTokens: 300,
        }).catch(() => null);
      }
      return reply.send({ title: query || "Recent activity", count: entries.length, entries, series, summary });
    },
  );
}

// "Show me my cholesterol" should match LDL/HDL/ApoB records, not just the literal word. Expand the
// query into match terms: drop stop words, then add lab/vital synonyms so common phrasing finds the
// underlying analytes. Substring matching against record titles/details stays the mechanism.
const STOP_WORDS = new Set([
  "show", "me", "my", "the", "for", "and", "of", "this", "year", "last", "over", "time", "what", "is",
  "are", "his", "her", "their", "dad", "mom", "mum", "please", "can", "you", "give", "see", "all",
]);

const SYNONYMS: Record<string, string[]> = {
  cholesterol: ["cholesterol", "ldl", "hdl", "lipid", "lipoprotein", "apolipoprotein", "triglyceride"],
  apob: ["apolipoprotein"],
  lipids: ["lipid", "cholesterol", "ldl", "hdl", "triglyceride"],
  a1c: ["a1c", "hemoglobin a1c", "hba1c", "glycohemoglobin"],
  sugar: ["glucose", "a1c"],
  glucose: ["glucose"],
  diabetes: ["glucose", "a1c"],
  thyroid: ["tsh", "t4", "t3", "thyroid"],
  kidney: ["creatinine", "egfr", "bun", "urea"],
  liver: ["alt", "ast", "alkaline phosphatase", "bilirubin"],
  iron: ["iron", "ferritin", "tibc", "saturation"],
  "vitamin": ["vitamin", "25-oh"],
  bp: ["blood pressure", "systolic", "diastolic"],
  pressure: ["blood pressure", "systolic", "diastolic"],
  inflammation: ["crp", "c-reactive"],
  weight: ["weight", "bmi"],
  blood: ["blood pressure", "blood cell", "cbc"],
  cbc: ["white blood cell", "red blood cell", "hemoglobin", "hematocrit", "platelet"],
};

function expandQueryTerms(query: string): string[] {
  const raw = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9-]/g, "")).filter(Boolean);
  const out = new Set<string>();
  for (const t of raw) {
    if (t.length <= 2 || STOP_WORDS.has(t)) continue;
    out.add(t);
    for (const syn of SYNONYMS[t] ?? []) out.add(syn);
  }
  return [...out];
}
