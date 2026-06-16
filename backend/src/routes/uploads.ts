import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { ensureUploadConnection } from "../sources/upload.js";
import { ingestArtifact } from "../services/ingestion.js";

/**
 * Manual document upload. iOS sends a single multipart file (photo of a lab result, a PDF, etc.).
 * The bytes go through the standard ingestion pipeline (store → HealthDocument → vision_ocr job).
 * Client then polls GET /health-records/documents/:id for extraction status.
 */
export async function uploadRoutes(app: FastifyInstance) {
  app.post("/uploads", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.user!.id;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no_file" });

    const bytes = await file.toBuffer();
    if (bytes.byteLength === 0) return reply.code(400).send({ error: "empty_file" });

    const connectionId = await ensureUploadConnection(userId);
    const result = await ingestArtifact(
      userId,
      "upload",
      { bytes, mimeType: file.mimetype, originalName: file.filename, receivedAt: new Date().toISOString() },
      connectionId,
    );

    return reply.code(201).send({ documentId: result.documentId, status: result.status });
  });
}
