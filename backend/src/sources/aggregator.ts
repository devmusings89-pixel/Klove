import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { DataSource, RawArtifact } from "./types.js";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";

/**
 * Health-records aggregator source — vendor: Metriport (HIPAA BAA, FHIR-native, broad network via
 * Carequality/CommonWell).
 *
 *  1. connect() → ensure a Metriport patient for this user, kick off a network document query, and
 *     return the Connect-Widget URL where the user verifies identity + links providers.
 *  2. Metriport pulls + converts records asynchronously and POSTs /webhooks/aggregator:
 *       - medical.document-download / medical.document-conversion (status=completed)
 *           → we trigger a consolidated-data query so the assembled FHIR flows back.
 *       - medical.consolidated-data → carries the FHIR bundle inline; we map it to RawArtifacts.
 *  3. handleWebhook() turns the consolidated FHIR bundle into RawArtifacts (fhirJson) → fhir_normalize.
 *
 * Delivery is webhook-based: Metriport's GET /consolidated/query returns query *status* only (it no
 * longer streams the bundle), so records arrive via the consolidated-data webhook, not a poll.
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

/**
 * Verify a Metriport webhook: HMAC-SHA256 of the exact raw request body, keyed by the webhook secret,
 * delivered in the `x-metriport-signature` header (hex). Constant-time compare.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: unknown): boolean {
  if (!config.aggregator.webhookSecret) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = createHmac("sha256", config.aggregator.webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Best-effort parse of a freeform US address into the structured fields Metriport matches on. */
function parseUsAddress(freeform: string): { addressLine1: string; city?: string; state?: string; zip?: string } {
  const trimmed = freeform.trim();
  const zip = trimmed.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
  // 2-letter state appearing right before the zip (e.g. "... , Austin, TX 78701").
  const state = zip ? trimmed.match(/\b([A-Z]{2})\b(?=[,\s]*\d{5}\b)/)?.[1] : undefined;
  const city = trimmed.match(/,\s*([^,]+?),?\s*[A-Z]{2}\b(?=[,\s]*\d{5})/)?.[1]?.trim();
  // Strip a trailing ", City, ST ZIP" tail from line 1 when we recognized it.
  let addressLine1 = trimmed;
  if (zip) {
    const idx = trimmed.search(new RegExp(`,?\\s*[^,]+,?\\s*[A-Z]{2}\\s*${zip}`));
    if (idx > 0) addressLine1 = trimmed.slice(0, idx).replace(/,\s*$/, "").trim();
  }
  return { addressLine1: addressLine1 || trimmed, city, state, zip };
}

/**
 * Build Metriport patient demographics from the user's primary profile (best-effort).
 * Match quality scales with how complete this is — a structured address with zip/state is what lets
 * the HIE network find records, so capturing those upstream (iOS profile form) matters most.
 */
async function demographics(userId: string): Promise<Record<string, unknown> | null> {
  const profile = await prisma.profile.findFirst({ where: { userId, isPrimary: true } });
  if (!profile?.fullName) return null;
  const parts = profile.fullName.trim().split(/\s+/);
  const addr = profile.address ? parseUsAddress(profile.address) : null;
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ") || parts[0],
    dob: profile.dob ?? undefined, // ISO yyyy-mm-dd
    genderAtBirth: "U", // Profile has no sex-at-birth field yet; "U" is accepted by Metriport.
    address: addr
      ? [{ addressLine1: addr.addressLine1, city: addr.city, state: addr.state, zip: addr.zip, country: "USA" }]
      : [],
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

/** Start a network document query (pulls + converts records from the HIE network). */
async function triggerDocumentQuery(patientId: string): Promise<void> {
  await metriport(`${MEDICAL}/document/query?patientId=${patientId}&facilityId=${config.aggregator.facilityId}`, {
    method: "POST",
  });
}

/**
 * Start a consolidated-data query. No conversionType → Metriport assembles the patient's consolidated
 * FHIR bundle and delivers it via the medical.consolidated-data webhook (this is cheap: it re-reads
 * already-fetched/converted data and does not hit the external network).
 */
async function triggerConsolidatedQuery(patientId: string): Promise<void> {
  await metriport(`${MEDICAL}/patient/${patientId}/consolidated/query`, { method: "POST", body: {} });
}

/** Fetch + decode a consolidated-export attachment (a JSON or gzip'd FHIR Bundle behind a signed URL). */
async function fetchExportBundle(url: string, contentType?: string): Promise<unknown | null> {
  const res = await fetch(url); // pre-signed URL — no API key needed (valid ~10 min)
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const text = /gzip/i.test(contentType ?? "") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface FhirAttachment {
  url?: string;
  contentType?: string;
}
interface FhirResource {
  resourceType?: string;
  id?: string;
  content?: { attachment?: FhirAttachment }[];
}

/**
 * Map a FHIR Bundle's resource entries into one artifact each (fhirJson → fhir_normalize).
 * A consolidated export may arrive as a DocumentReference pointing at a JSON/gzip bundle download
 * rather than inline resources — those we fetch and expand. Clinical-document references (PDF/HTML)
 * are kept as-is for the normalizer to record.
 */
async function bundleToArtifacts(bundle: unknown, patientId: string): Promise<RawArtifact[]> {
  const entries = (bundle as { entry?: { resource?: FhirResource }[] })?.entry ?? [];
  const out: RawArtifact[] = [];
  for (const e of entries) {
    const r = e.resource;
    if (!r?.resourceType) continue;

    if (r.resourceType === "DocumentReference") {
      const exportAtt = (r.content ?? [])
        .map((c) => c?.attachment)
        .find((a) => a?.url && /json|gzip/i.test(a.contentType ?? ""));
      if (exportAtt?.url) {
        const sub = await fetchExportBundle(exportAtt.url, exportAtt.contentType).catch(() => null);
        if (sub) out.push(...(await bundleToArtifacts(sub, patientId)));
        continue;
      }
    }

    out.push({
      sourceRef: `metriport:${patientId}:${r.resourceType}:${r.id ?? ""}`,
      mimeType: "application/fhir+json",
      fhirJson: r,
    });
  }
  return out;
}

/** Resolve our connection (and owning user) from a Metriport patient id. */
async function connectionForPatient(patientId: string) {
  return prisma.dataSourceConnection.findFirst({ where: { type: "aggregator", externalAccountId: patientId } });
}

interface WebhookPatient {
  patientId?: string;
  status?: string;
  bundle?: unknown;
}
interface WebhookPayload {
  ping?: string;
  meta?: { type?: string };
  patients?: WebhookPatient[];
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
    // Kick off a network document query so records start flowing; the conversion webhook then
    // triggers a consolidated query whose result we ingest.
    await triggerDocumentQuery(patientId).catch((e) => console.error("metriport doc query failed", e));
    // The Connect Widget handles identity verification (CLEAR/ID.me) + provider linking.
    return {
      connectionId: conn.id,
      redirectUrl: `${config.aggregator.connectUrl}/?patientId=${patientId}`,
    };
  },

  async sync(connection): Promise<RawArtifact[]> {
    if (!enabled.aggregator() || !connection.externalAccountId) return [];
    // Re-assemble the consolidated FHIR bundle (cheap, no network hit); it returns via the
    // consolidated-data webhook, so nothing is ingested inline here. A full network refresh is a
    // deliberate action (connect, or a future scheduled re-query), not every poll tick.
    try {
      await triggerConsolidatedQuery(connection.externalAccountId);
      await prisma.dataSourceConnection.update({
        where: { id: connection.id },
        data: { status: "connected", lastSyncedAt: new Date() },
      });
    } catch (err) {
      console.error("metriport consolidated query trigger failed", err);
    }
    return [];
  },

  async handleWebhook(payload): Promise<{ userId: string; artifacts: RawArtifact[] }> {
    const body = (payload ?? {}) as WebhookPayload;
    const type = body.meta?.type;
    const patients = body.patients ?? [];

    // Document fetch/convert finished → ask Metriport to assemble the consolidated bundle, which it
    // delivers back as a medical.consolidated-data webhook we ingest below. Fire-and-forget so we
    // still respond to Metriport within its 4s budget.
    if (type === "medical.document-download" || type === "medical.document-conversion") {
      for (const p of patients) {
        if (p.status !== "completed" || !p.patientId) continue;
        const conn = await connectionForPatient(p.patientId);
        if (conn) void triggerConsolidatedQuery(p.patientId).catch((e) => console.error("metriport consolidated trigger failed", e));
      }
      return { userId: "", artifacts: [] };
    }

    // Consolidated bundle delivery (the actual records). Treat an untyped payload that still carries
    // a bundle as consolidated data too, for resilience to minor shape changes.
    if (type === "medical.consolidated-data" || (!type && patients.some((p) => p.bundle))) {
      for (const p of patients) {
        if (!p.patientId || !p.bundle) continue;
        const conn = await connectionForPatient(p.patientId);
        if (!conn) continue;
        return { userId: conn.userId, artifacts: await bundleToArtifacts(p.bundle, p.patientId) };
      }
    }

    return { userId: "", artifacts: [] };
  },
};
