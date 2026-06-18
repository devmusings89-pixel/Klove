import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { buildTodayBriefing } from "../services/today-brief.js";

/**
 * The chief-of-staff briefing. Aggregates across every member the operator can act on into three
 * buckets — Needs You · Waiting · Handled — plus upcoming appointments. Action over information:
 * this is the home surface, not a data dump. The aggregation lives in services/today-brief.ts so the
 * WhatsApp concierge agent can reuse it.
 */
export async function todayRoutes(app: FastifyInstance) {
  app.get("/today", { preHandler: requireUser }, async (req) => buildTodayBriefing(req.user!.id));
}
