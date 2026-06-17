// Background workers for the health pipeline, run on the same interval cadence as the scheduler:
//  - runExtractionTick: drains ExtractionJob (vision_ocr | email_parse | fhir_normalize | analysis)
//  - runIngestionTick:  polls pollable sources (gmail/imap/aggregator) for new artifacts
// MVP uses the DB table as the queue; swap for a real queue later without changing callers.

import type { DataSourceConnection, ExtractionJob } from "@prisma/client";
import { prisma } from "../db.js";
import { getObject } from "./storage.js";
import { extractDocument } from "./extraction.js";
import { runAnalysis } from "./analysis.js";
import { persistBundle, fhirToBundle, type ExtractedBundle } from "./fhir-map.js";
import { fromJson } from "./json.js";
import type { SourceType } from "../sources/types.js";
import { pollableSources } from "../sources/registry.js";
import { ingestArtifact } from "./ingestion.js";

const MAX_ATTEMPTS = 4;
const BATCH = 5; // jobs per tick (bounded concurrency)

/** Drain a batch of due extraction jobs. */
export async function runExtractionTick(): Promise<void> {
  const due = await prisma.extractionJob.findMany({
    where: { status: "pending", runAfter: { lte: new Date() } },
    orderBy: { runAfter: "asc" },
    take: BATCH,
  });
  await Promise.all(due.map(runJob));
}

async function runJob(job: ExtractionJob): Promise<void> {
  // Claim the job (best-effort; single worker process in MVP).
  const claimed = await prisma.extractionJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { status: "running", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return;

  try {
    if (job.kind === "analysis") {
      const created = await runAnalysis(job.userId, job.id);
      await done(job.id, `analysis: ${created} alert(s)`);
      return;
    }

    const doc = job.documentId ? await prisma.healthDocument.findUnique({ where: { id: job.documentId } }) : null;
    if (!doc) {
      await done(job.id, "document missing — skipped");
      return;
    }
    await prisma.healthDocument.update({ where: { id: doc.id }, data: { status: "extracting" } });

    let bundle: ExtractedBundle;
    if (job.kind === "fhir_normalize") {
      const raw = doc.storagePath ? await getObject(doc.storagePath) : Buffer.from("null");
      bundle = fhirToBundle(fromJson<unknown>(raw.toString("utf8"), null));
    } else {
      bundle = await extractDocument(doc); // vision_ocr | email_parse
    }

    if (bundle.isHealthRelated === false) {
      await prisma.healthDocument.update({ where: { id: doc.id }, data: { status: "skipped_non_health" } });
      await done(job.id, "skipped: not health-related");
      return;
    }

    const counts = await persistBundle(doc.userId, doc.id, doc.sourceType as SourceType, bundle);
    await prisma.healthDocument.update({ where: { id: doc.id }, data: { status: "extracted" } });
    // Chain an analysis pass over the user's updated record set.
    await prisma.extractionJob.create({ data: { userId: doc.userId, kind: "analysis" } });
    await done(job.id, `extracted ${JSON.stringify(counts)}`);
  } catch (err) {
    await fail(job, err);
  }
}

async function done(jobId: string, resultSummary: string): Promise<void> {
  await prisma.extractionJob.update({ where: { id: jobId }, data: { status: "done", resultSummary } });
}

async function fail(job: ExtractionJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.extractionJob.update({ where: { id: job.id }, data: { status: "failed", lastError: message } });
    if (job.documentId) await prisma.healthDocument.update({ where: { id: job.documentId }, data: { status: "failed" } });
    return;
  }
  const backoffMs = 2 ** attempts * 30_000; // 1m, 2m, 4m, ...
  await prisma.extractionJob.update({
    where: { id: job.id },
    data: { status: "pending", lastError: message, runAfter: new Date(Date.now() + backoffMs) },
  });
}

export interface SyncResult {
  scanned: number; // artifacts pulled from the source
  queued: number; // new (non-duplicate) documents queued for extraction
  error?: string; // auth/connection failure (e.g. wrong app password), if any
}

/**
 * Sync one connection: pull artifacts, ingest them, and record status. Returns counts (and any
 * error) so it can drive both the background tick and an on-demand "scan now" from the client.
 * `conn` must be a full DataSourceConnection row (sources read tokens/config/cursor off it).
 */
export async function syncConnection(conn: DataSourceConnection): Promise<SyncResult> {
  const source = pollableSources().find((s) => s.type === conn.type);
  if (!source) return { scanned: 0, queued: 0, error: "source_not_pollable" };
  try {
    const artifacts = await source.sync(conn);
    let queued = 0;
    for (const a of artifacts) {
      const r = await ingestArtifact(conn.userId, conn.type as SourceType, a, conn.id);
      if (r.status === "queued") queued++;
    }
    await prisma.dataSourceConnection.update({
      where: { id: conn.id },
      data: { lastSyncedAt: new Date(), lastError: null },
    });
    return { scanned: artifacts.length, queued };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.dataSourceConnection.update({ where: { id: conn.id }, data: { lastError: message } });
    return { scanned: 0, queued: 0, error: message };
  }
}

/** Poll connected pollable sources (gmail/imap/aggregator) and ingest any new artifacts. */
export async function runIngestionTick(): Promise<void> {
  const types = pollableSources().map((s) => s.type);
  const connections = await prisma.dataSourceConnection.findMany({
    where: { type: { in: types }, status: "connected" },
  });
  for (const conn of connections) await syncConnection(conn);
}
