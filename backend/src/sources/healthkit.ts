import type { DataSource, RawArtifact } from "./types.js";
import { prisma } from "../db.js";

/**
 * Apple HealthKit source. Extraction happens on-device only insofar as iOS reads the records;
 * the actual normalization runs on the backend. iOS pushes FHIR JSON (HKClinicalRecord.fhirResource)
 * and normalized vitals/labs to POST /sources/healthkit/sync, which calls ingestHealthKitPush().
 * There is nothing to poll server-side, so sync() is a no-op.
 */
export const healthKitSource: DataSource = {
  type: "healthkit",

  async connect(userId) {
    const existing = await prisma.dataSourceConnection.findFirst({ where: { userId, type: "healthkit" } });
    if (existing) return { connectionId: existing.id };
    const conn = await prisma.dataSourceConnection.create({
      data: { userId, type: "healthkit", status: "connected" },
    });
    return { connectionId: conn.id };
  },

  async sync() {
    return [];
  },
};

/** Convert a HealthKit sync payload (array of FHIR resources) into RawArtifacts for ingestion. */
export function healthKitArtifacts(fhirResources: unknown[]): RawArtifact[] {
  return fhirResources.map((res, i) => ({
    sourceRef: resourceId(res) ?? `healthkit-${i}`,
    mimeType: "application/fhir+json",
    fhirJson: res,
  }));
}

function resourceId(res: unknown): string | undefined {
  if (res && typeof res === "object") {
    const r = res as { resourceType?: string; id?: string };
    if (r.resourceType && r.id) return `${r.resourceType}/${r.id}`;
  }
  return undefined;
}
