import type { DataSource, RawArtifact } from "./types.js";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";

/**
 * Health-records aggregator source (scaffold) — recommended vendor: Metriport (HIPAA BAA,
 * FHIR-native, broad network via Carequality/CommonWell). Flow once AGGREGATOR_* keys land:
 *  1. connect() → create/link an aggregator patient for this user, return a consent/link URL.
 *  2. The user authorizes providers; the aggregator pulls records asynchronously.
 *  3. /webhooks/aggregator → handleWebhook() fetches the ready FHIR bundle → RawArtifacts (fhirJson).
 * FHIR resources skip the LLM and go straight through fhir_normalize.
 */
export const aggregatorSource: DataSource = {
  type: "aggregator",

  async connect(userId) {
    const existing = await prisma.dataSourceConnection.findFirst({ where: { userId, type: "aggregator" } });
    const conn =
      existing ??
      (await prisma.dataSourceConnection.create({ data: { userId, type: "aggregator", status: "pending" } }));

    // Mock mode: hand back a placeholder identity-verification URL so the HealthX connect flow is
    // demoable offline. Live mode (Phase 5) creates the aggregator patient and returns the real
    // CLEAR/ID.me-style verify URL; records arrive later via /webhooks/aggregator.
    if (!enabled.aggregator()) {
      return { connectionId: conn.id, redirectUrl: `${config.publicBaseUrl}/mock/healthx-verify?conn=${conn.id}` };
    }
    // TODO (live): create aggregator patient, return its consent/link URL.
    return { connectionId: conn.id };
  },

  async sync(): Promise<RawArtifact[]> {
    if (!enabled.aggregator()) throw new Error("aggregator_not_configured");
    // TODO: list documents since cursor (sync token) and fetch FHIR bundles.
    return [];
  },

  async handleWebhook() {
    // TODO: verify signature, fetch the ready FHIR bundle, map to artifacts.
    return { userId: "", artifacts: [] };
  },
};
