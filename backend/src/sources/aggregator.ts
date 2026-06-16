import type { DataSource, RawArtifact } from "./types.js";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";

/**
 * Health-records aggregator source — vendor: Metriport (HIPAA BAA, FHIR-native, broad network via
 * Carequality/CommonWell).
 *
 *  1. connect() → ensure a Metriport patient for this user, kick off a document query, and return
 *     the Connect-Widget URL where the user verifies identity + links providers.
 *  2. The aggregator pulls records asynchronously and POSTs /webhooks/aggregator when ready.
 *  3. handleWebhook() turns the consolidated FHIR bundle into RawArtifacts (fhirJson) → fhir_normalize.
 *
 * Without AGGREGATOR_* keys it stays in mock mode (a placeholder verify URL) so the flow is demoable.
 * Live verification needs the Metriport BAA + API key + facility id.
 */

const MEDICAL = "/medical/v1";

async function metriport(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(`${config.aggregator.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { "x-api-key": config.aggregator.apiKey, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`metriport ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Build Metriport patient demographics from the user's primary profile (best-effort). */
async function demographics(userId: string): Promise<Record<string, unknown> | null> {
  const profile = await prisma.profile.findFirst({ where: { userId, isPrimary: true } });
  if (!profile?.fullName) return null;
  const parts = profile.fullName.trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ") || parts[0],
    dob: profile.dob ?? undefined, // ISO yyyy-mm-dd
    genderAtBirth: "U",
    address: profile.address ? [{ addressLine1: profile.address, country: "USA" }] : [],
  };
}

/** Ensure a Metriport patient exists for this connection; returns its id (stored in externalAccountId). */
async function ensurePatient(userId: string, connectionId: string, existingPatientId: string | null): Promise<string | null> {
  if (existingPatientId) return existingPatientId;
  const demo = await demographics(userId);
  if (!demo || !config.aggregator.facilityId) return null; // need demographics + facility to create
  const created = (await metriport(`${MEDICAL}/patient?facilityId=${config.aggregator.facilityId}`, {
    method: "POST",
    body: demo,
  })) as { id?: string };
  const patientId = created.id ?? null;
  if (patientId) {
    await prisma.dataSourceConnection.update({ where: { id: connectionId }, data: { externalAccountId: patientId } });
  }
  return patientId;
}

/** Map a FHIR Bundle's resource entries into one artifact each (fhirJson → fhir_normalize). */
function bundleToArtifacts(bundle: unknown, patientId: string): RawArtifact[] {
  const entries = (bundle as { entry?: { resource?: { resourceType?: string; id?: string } }[] })?.entry ?? [];
  const artifacts: RawArtifact[] = [];
  for (const e of entries) {
    const r = e.resource;
    if (!r?.resourceType) continue;
    artifacts.push({
      sourceRef: `metriport:${patientId}:${r.resourceType}:${r.id ?? ""}`,
      mimeType: "application/fhir+json",
      fhirJson: r,
    });
  }
  return artifacts;
}

export const aggregatorSource: DataSource = {
  type: "aggregator",

  async connect(userId) {
    const existing = await prisma.dataSourceConnection.findFirst({ where: { userId, type: "aggregator" } });
    const conn =
      existing ??
      (await prisma.dataSourceConnection.create({ data: { userId, type: "aggregator", status: "pending" } }));

    if (!enabled.aggregator()) {
      return { connectionId: conn.id, redirectUrl: `${config.publicBaseUrl}/mock/healthx-verify?conn=${conn.id}` };
    }

    const patientId = await ensurePatient(userId, conn.id, conn.externalAccountId);
    if (!patientId) {
      // Can't create the patient yet (missing demographics/facility) — surface mock URL + a note.
      return { connectionId: conn.id, redirectUrl: `${config.publicBaseUrl}/mock/healthx-verify?conn=${conn.id}&needs=profile` };
    }
    // Kick off a network document query so records start flowing.
    await metriport(`${MEDICAL}/document/query?patientId=${patientId}&facilityId=${config.aggregator.facilityId}`, {
      method: "POST",
    }).catch((e) => console.error("metriport doc query failed", e));
    // The Connect Widget handles identity verification (CLEAR/ID.me) + provider linking.
    return {
      connectionId: conn.id,
      redirectUrl: `${config.aggregator.connectUrl}/?patientId=${patientId}`,
    };
  },

  async sync(connection): Promise<RawArtifact[]> {
    if (!enabled.aggregator() || !connection.externalAccountId) return [];
    const patientId = connection.externalAccountId;
    // Fetch the consolidated FHIR bundle (records gathered so far) and map to artifacts.
    let bundle: unknown;
    try {
      bundle = await metriport(`${MEDICAL}/patient/${patientId}/consolidated`);
    } catch (err) {
      console.error("metriport consolidated fetch failed", err);
      return [];
    }
    await prisma.dataSourceConnection.update({
      where: { id: connection.id },
      data: { status: "connected", lastSyncedAt: new Date() },
    });
    return bundleToArtifacts(bundle, patientId);
  },

  async handleWebhook(payload): Promise<{ userId: string; artifacts: RawArtifact[] }> {
    // Ping handshake — Metriport sends { ping } to validate the endpoint.
    if ((payload as { ping?: string })?.ping) return { userId: "", artifacts: [] };

    // Consolidated-data webhook: { meta, patients: [{ patientId, bundle? }] }.
    const patients = (payload as { patients?: { patientId?: string; bundle?: unknown }[] })?.patients ?? [];
    const first = patients.find((p) => p.patientId);
    if (!first?.patientId) return { userId: "", artifacts: [] };

    const conn = await prisma.dataSourceConnection.findFirst({
      where: { type: "aggregator", externalAccountId: first.patientId },
    });
    if (!conn) return { userId: "", artifacts: [] };

    // Use the inlined bundle if present, otherwise pull the consolidated data.
    let bundle = first.bundle;
    if (!bundle && enabled.aggregator()) {
      bundle = await metriport(`${MEDICAL}/patient/${first.patientId}/consolidated`).catch(() => undefined);
    }
    return { userId: conn.userId, artifacts: bundle ? bundleToArtifacts(bundle, first.patientId) : [] };
  },
};
