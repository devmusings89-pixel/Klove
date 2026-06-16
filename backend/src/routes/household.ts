import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { ensureHousehold, listMembers } from "../services/household.js";

/**
 * The operator's household: who's in it and a per-member status summary. The household is
 * auto-ensured (created with a self-membership) the first time the operator hits these routes,
 * so onboarding never lands on an empty shell.
 */
export async function householdRoutes(app: FastifyInstance) {
  // The household + members, shaped for the Family tab / Today switcher.
  app.get("/household", { preHandler: requireUser }, async (req) => {
    const operatorUserId = req.user!.id;
    const householdId = await ensureHousehold(operatorUserId);
    const household = await prisma.household.findUnique({ where: { id: householdId } });
    const members = await listMembers(operatorUserId);
    return { id: householdId, name: household?.name ?? null, operatorUserId, members };
  });

  // Set the household name (onboarding / settings).
  app.post<{ Body: { name?: string } }>("/household", { preHandler: requireUser }, async (req) => {
    const householdId = await ensureHousehold(req.user!.id, req.body?.name);
    const household = await prisma.household.findUnique({ where: { id: householdId } });
    return { id: householdId, name: household?.name ?? null };
  });

  app.patch<{ Body: { name?: string } }>("/household", { preHandler: requireUser }, async (req) => {
    const householdId = await ensureHousehold(req.user!.id);
    const household = await prisma.household.update({
      where: { id: householdId },
      data: { name: req.body?.name ?? undefined },
    });
    return { id: household.id, name: household.name };
  });
}
