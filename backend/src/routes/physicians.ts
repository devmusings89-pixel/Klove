import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { ensureHousehold } from "../services/household.js";
import { searchPhysicians } from "../services/physician-search.js";

/**
 * Physician search — "find the best expert for my condition." Resolves the condition to a specialty,
 * finds credentialed specialists (NPI registry) ranked by credentials + public ratings, and labels each
 * in-network / out-of-network / unconfirmed against the member's insurance. Read-only; saving a result
 * goes through POST /providers (which carries the in-network tags).
 */
export async function physicianRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { condition?: string; memberId?: string; location?: string; limit?: string; offset?: string; radiusMiles?: string };
  }>("/physicians/search", { preHandler: requireUser }, async (req, reply) => {
    const condition = (req.query?.condition ?? "").trim();
    if (!condition) return reply.code(400).send({ error: "condition required" });
    const householdId = await ensureHousehold(req.user!.id);
    // Default the subject to the operator when no member is named (search for myself).
    const subjectUserId = req.query?.memberId?.trim() || req.user!.id;
    const limit = Number(req.query?.limit) || 20;
    const offset = Number(req.query?.offset) || 0;
    const radius = Number(req.query?.radiusMiles);
    return searchPhysicians({
      householdId,
      subjectUserId,
      condition,
      location: req.query?.location?.trim() || undefined,
      limit: Math.min(Math.max(limit, 1), 50),
      offset: Math.min(Math.max(offset, 0), 1000),
      radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : undefined,
    });
  });
}
