// Source-agnostic ingestion entry point. Every source (upload, gmail, healthkit, aggregator, ...)
// funnels its RawArtifacts through ingestArtifact: dedupe → store raw bytes → create HealthDocument
// → enqueue the right ExtractionJob. The extraction worker (health-worker.ts) drains the queue.

import { createHash } from "node:crypto";
import type { RawArtifact, SourceType } from "../sources/types.js";
import { prisma } from "../db.js";
import { putObject } from "./storage.js";
import { toJson } from "./json.js";

export interface IngestResult {
  documentId: string;
  status: "queued" | "duplicate";
}

/** Hash whatever payload the artifact carries, for idempotent dedupe per user. */
function hashArtifact(a: RawArtifact): string {
  const h = createHash("sha256");
  if (a.bytes) h.update(a.bytes);
  else if (a.text) h.update(a.text);
  else h.update(toJson(a.fhirJson));
  h.update(a.sourceRef ?? "");
  return h.digest("hex");
}

/** Pick the extraction job kind for an artifact based on its payload type. */
function jobKind(a: RawArtifact): "vision_ocr" | "email_parse" | "fhir_normalize" {
  if (a.fhirJson !== undefined) return "fhir_normalize";
  if (a.bytes) return "vision_ocr";
  return "email_parse";
}

export async function ingestArtifact(
  userId: string,
  sourceType: SourceType,
  artifact: RawArtifact,
  connectionId?: string,
): Promise<IngestResult> {
  const sha256 = hashArtifact(artifact);

  // Idempotent: same content for the same user is ingested once.
  const existing = await prisma.healthDocument.findUnique({
    where: { userId_sha256: { userId, sha256 } },
  });
  if (existing) return { documentId: existing.id, status: "duplicate" };

  // Store raw bytes (vision/email payloads). FHIR is small JSON — keep it inline as the job input
  // by storing it too, so the worker has a single read path.
  const payload = artifact.bytes ?? Buffer.from(artifact.text ?? toJson(artifact.fhirJson), "utf8");
  const doc = await prisma.healthDocument.create({
    data: {
      userId,
      connectionId,
      sourceType,
      mimeType: artifact.mimeType,
      sizeBytes: payload.byteLength,
      originalName: artifact.originalName,
      sourceRef: artifact.sourceRef,
      sha256,
      status: "queued",
      receivedAt: artifact.receivedAt ? new Date(artifact.receivedAt) : undefined,
    },
  });

  const storagePath = await putObject(
    `user/${userId}/${doc.id}/${artifact.originalName ?? "artifact"}`,
    payload,
    artifact.mimeType,
  );
  await prisma.healthDocument.update({ where: { id: doc.id }, data: { storagePath } });

  await prisma.extractionJob.create({
    data: { documentId: doc.id, userId, kind: jobKind(artifact) },
  });

  return { documentId: doc.id, status: "queued" };
}
