import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { getSource } from "../sources/registry.js";
import { healthKitSource, healthKitArtifacts } from "../sources/healthkit.js";
import { ingestArtifact } from "../services/ingestion.js";
import { syncConnection } from "../services/health-worker.js";
import type { SourceType } from "../sources/types.js";

const VALID: SourceType[] = ["gmail", "imap", "healthkit", "aggregator", "upload"];

/** IMAP/auth failures from the server are terse ("Command failed") — explain the usual cause. */
function friendlyImapError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("command failed") || m.includes("auth") || m.includes("login") || m.includes("invalid credentials")) {
    return "Mailbox sign-in failed. Use an app-specific password (not your main password). For iCloud, create one at appleid.apple.com → Sign-In & Security → App-Specific Passwords.";
  }
  return raw;
}

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
        // Credential sources (IMAP) connect synchronously — scan immediately so the user gets
        // instant feedback (records flowing) and a bad app password surfaces right here, not 15s
        // later in the background tick. OAuth sources return a redirectUrl and scan after callback.
        if ("connectionId" in result && (type === "imap" || type === "aggregator")) {
          const conn = await prisma.dataSourceConnection.findUnique({ where: { id: result.connectionId } });
          if (conn) {
            const scan = await syncConnection(conn);
            // A connection error (e.g. wrong app password) means the mailbox isn't usable: don't leave
            // a phantom "connected" row — mark it errored — and report a friendly reason.
            if (scan.error) {
              await prisma.dataSourceConnection.update({
                where: { id: conn.id },
                data: { status: "error", accessTokenEnc: null },
              });
              return reply.code(400).send({ error: friendlyImapError(scan.error) });
            }
            return reply.send({ ...result, ...scan });
          }
        }
        return reply.send(result);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "connect_failed" });
      }
    },
  );

  // On-demand "scan now" for a connected pollable source. Returns how much it pulled/queued.
  app.post<{ Params: { type: string } }>("/sources/:type/sync", { preHandler: requireUser }, async (req, reply) => {
    const conn = await prisma.dataSourceConnection.findFirst({
      where: { userId: req.user!.id, type: req.params.type, status: "connected" },
      orderBy: { createdAt: "desc" },
    });
    if (!conn) return reply.code(404).send({ error: "not_connected" });
    const scan = await syncConnection(conn);
    if (scan.error) return reply.code(400).send({ error: scan.error });
    return reply.send(scan);
  });

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
