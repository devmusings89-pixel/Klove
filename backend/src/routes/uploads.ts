import type { FastifyInstance } from "fastify";
import { requireUser } from "../services/auth.js";
import { ensureUploadConnection } from "../sources/upload.js";
import { ingestArtifact } from "../services/ingestion.js";

// Vision/OCR extraction only handles images and PDFs. Guard size + type at the edge so we don't
// store or queue junk. Kept in sync with the same limits in member-data.ts.
export const ALLOWED_UPLOAD_MIMES = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf",
]);
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

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
    // Reject unsupported types before reading bytes (vision/OCR only handles images + PDF).
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) return reply.code(415).send({ error: "unsupported_media_type" });

    const bytes = await file.toBuffer();
    if (bytes.byteLength === 0) return reply.code(400).send({ error: "empty_file" });
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: "file_too_large" });

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
