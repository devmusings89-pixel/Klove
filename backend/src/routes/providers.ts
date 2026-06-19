import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { ensureHousehold } from "../services/household.js";
import { listProviders, searchProviders, upsertProvider } from "../services/providers.js";

/**
 * The household's known-provider directory — list past providers, search (directory + Google Places),
 * and add new ones. The booking pipeline resolves providers from here so it always has the contact
 * details and never dead-ends on "couldn't reach an office".
 */
export async function providerRoutes(app: FastifyInstance) {
  // List the directory, optionally biased to a member (their providers + household-wide shared ones).
  app.get<{ Querystring: { memberId?: string } }>("/providers", { preHandler: requireUser }, async (req) => {
    const householdId = await ensureHousehold(req.user!.id);
    const memberId = req.query?.memberId?.trim();
    return listProviders(householdId, memberId ? { subjectUserId: memberId } : undefined);
  });

  // Search the directory + Google Places (the add-provider picker; debounced by the client).
  app.get<{ Querystring: { q?: string } }>("/providers/search", { preHandler: requireUser }, async (req) => {
    const householdId = await ensureHousehold(req.user!.id);
    return searchProviders(householdId, (req.query?.q ?? "").trim());
  });

  // Add (or refresh) a provider in the directory. memberId scopes it to one member; omit for shared.
  app.post<{ Body: { name?: string; phone?: string; website?: string; address?: string; specialty?: string; memberId?: string } }>(
    "/providers",
    { preHandler: requireUser },
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "name required" });
      const householdId = await ensureHousehold(req.user!.id);
      const provider = await upsertProvider({
        householdId,
        subjectUserId: req.body?.memberId?.trim() || null,
        name,
        phone: req.body?.phone?.trim() || null,
        website: req.body?.website?.trim() || null,
        address: req.body?.address?.trim() || null,
        specialty: req.body?.specialty?.trim() || null,
        source: "manual",
      });
      return reply.code(201).send(provider);
    },
  );
}
