import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { getSource } from "../sources/registry.js";
import { healthKitSource, healthKitArtifacts } from "../sources/healthkit.js";
import { ingestArtifact } from "../services/ingestion.js";
import type { SourceType } from "../sources/types.js";

const VALID: SourceType[] = ["gmail", "imap", "healthkit", "aggregator", "upload"];

export async function sourceRoutes(app: FastifyInstance) {
  // List the user's connections and their status.
  app.get("/sources", { preHandler: requireUser }, async (req) => {
    const connections = await prisma.dataSourceConnection.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "asc" },
    });
    return connections.map((c) => ({
      id: c.id,
      type: c.type,
      status: c.status,
      externalAccountId: c.externalAccountId,
      lastSyncedAt: c.lastSyncedAt,
      lastError: c.lastError,
    }));
  });

  // Start connecting a source. OAuth sources return { redirectUrl } for the client to open.
  app.post<{ Params: { type: string }; Body: Record<string, unknown> }>(
    "/sources/:type/connect",
    { preHandler: requireUser },
    async (req, reply) => {
      const type = req.params.type as SourceType;
      if (!VALID.includes(type)) return reply.code(400).send({ error: "invalid_source" });
      const source = getSource(type);
      if (!source) return reply.code(400).send({ error: "invalid_source" });
      try {
        const result = await source.connect(req.user!.id, req.body ?? {});
        return reply.send(result);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "connect_failed" });
      }
    },
  );

  // Disconnect (revoke) a source.
  app.post<{ Params: { type: string } }>("/sources/:type/disconnect", { preHandler: requireUser }, async (req, reply) => {
    await prisma.dataSourceConnection.updateMany({
      where: { userId: req.user!.id, type: req.params.type },
      data: { status: "revoked", accessTokenEnc: null, refreshTokenEnc: null },
    });
    return reply.send({ ok: true });
  });

  // iOS pushes HealthKit FHIR resources here (no server-side poll for HealthKit).
  app.post<{ Body: { resources?: unknown[] } }>("/sources/healthkit/sync", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.user!.id;
    const resources = req.body?.resources ?? [];
    if (!Array.isArray(resources)) return reply.code(400).send({ error: "resources_must_be_array" });

    const { connectionId } = await healthKitSource.connect(userId, {});
    const artifacts = healthKitArtifacts(resources);
    let queued = 0;
    for (const a of artifacts) {
      const r = await ingestArtifact(userId, "healthkit", a, connectionId);
      if (r.status === "queued") queued++;
    }
    await prisma.dataSourceConnection.update({ where: { id: connectionId }, data: { lastSyncedAt: new Date() } });
    return reply.send({ received: artifacts.length, queued });
  });
}
