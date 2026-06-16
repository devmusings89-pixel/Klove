import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser, resolveSubject, isConsentError } from "../services/auth.js";
import { accessibleSubjects } from "../services/household.js";
import { buildTimeline } from "../services/graph.js";
import { triageAsk } from "../services/triage.js";

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

    // Record the request (and an outbound message so it shows in the inbox).
    const householdId = (await prisma.household.findUnique({ where: { operatorUserId: req.user!.id } }))?.id;
    await prisma.request.create({
      data: { operatorUserId: req.user!.id, householdId, text, kind: "ask", responseJson: JSON.stringify(result), status: result.kind === "escalated" ? "escalated" : "resolved" },
    });
    return reply.send(result);
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
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const entries = terms.length
        ? timeline.filter((e) => terms.some((t) => e.title.toLowerCase().includes(t) || (e.detail ?? "").toLowerCase().includes(t)))
        : timeline.slice(0, 20);
      return reply.send({ title: query || "Recent activity", count: entries.length, entries });
    },
  );
}
