import type { DataSourceConnection } from "@prisma/client";

export type SourceType = "gmail" | "imap" | "healthkit" | "aggregator" | "upload";

/**
 * A single raw item pulled from a source, normalized to a common shape before ingestion.
 * Exactly one of `bytes` / `text` / `fhirJson` carries the payload:
 *  - bytes:   binary attachment / photo / PDF      → vision_ocr extraction
 *  - text:    plain email body / note              → email_parse extraction
 *  - fhirJson: FHIR resource (HealthKit/aggregator) → fhir_normalize (no LLM)
 */
export interface RawArtifact {
  sourceRef?: string; // provider id for dedupe/provenance (message id, doc id, ...)
  mimeType: string;
  originalName?: string;
  receivedAt?: string; // ISO; when the artifact was produced/received
  bytes?: Buffer;
  text?: string;
  fhirJson?: unknown;
}

/** Result of starting a connection — either tokens stored, or an OAuth redirect to complete it. */
export interface ConnectResult {
  connectionId?: string;
  redirectUrl?: string; // present for OAuth sources; client opens it to finish
}

/**
 * A pluggable health-data source. Mirrors the channels/ BookingChannel pattern:
 * connectors are registered in registry.ts and feed a shared ingestion pipeline.
 */
export interface DataSource {
  type: SourceType;
  /** Begin a connection: store tokens, or return an OAuth URL the client must open. */
  connect(userId: string, params: Record<string, unknown>): Promise<ConnectResult>;
  /** Pull new artifacts since the connection's cursor (poll-based sources). */
  sync(connection: DataSourceConnection): Promise<RawArtifact[]>;
  /** Handle a provider push/webhook payload (push-based sources). */
  handleWebhook?(payload: unknown): Promise<{ userId: string; artifacts: RawArtifact[] }>;
}
