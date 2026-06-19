// NPI Registry data source — finds credentialed individual physicians for the "best expert for my
// condition" search. The NPI Registry (https://npiregistry.cms.hhs.gov/api/) is a free, keyless public
// US API listing every provider's credentials, taxonomy (specialty), and practice location.
//
// Mirrors the lookup.ts convention: try/catch fetch, typed result, and a deterministic mock fallback so
// dev/tests stay hermetic. Gated on PHYSICIAN_SEARCH_LIVE (enabled.npiRegistry()) rather than a key,
// since the registry needs none — off by default returns seeded specialists keyed off the request.

import { enabled } from "../config.js";

export interface NpiPhysician {
  npi: string;
  firstName: string;
  lastName: string;
  /** Display name with credential, e.g. "Jane Lee, MD". */
  name: string;
  credential: string | null; // MD | DO | NP | ...
  /** Primary taxonomy description, e.g. "Dermatology". */
  taxonomyDesc: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
}

export interface NpiSearchInput {
  /** NPI taxonomy description to match, e.g. "Dermatology", "Cardiovascular Disease". */
  taxonomy?: string;
  /** Human-readable specialty for the mock label, e.g. "dermatologist". */
  specialtyText?: string;
  /** Free-text location ("Seattle, WA", "98101") — split into city/state when possible. */
  location?: string;
  limit?: number;
}

/** Best-effort "City, ST" / "ST" / zip → { city, state } for the registry's city/state filters. */
function parseLocation(location?: string): { city?: string; state?: string } {
  const loc = location?.trim();
  if (!loc) return {};
  const stateMatch = loc.match(/\b([A-Z]{2})\b/);
  const state = stateMatch?.[1];
  const city = loc.split(",")[0]?.trim();
  return { city: city && city !== state ? city : undefined, state };
}

function displayName(first: string, last: string, credential: string | null): string {
  const base = `${first} ${last}`.trim();
  return credential ? `${base}, ${credential}` : base;
}

/**
 * Search the NPI Registry for individual physicians (enumeration_type=NPI-1) matching a taxonomy and
 * optional location. Returns [] on any failure so the caller degrades gracefully. In mock mode (live
 * off) returns 2–3 deterministic seeded specialists so the demo + tests are stable.
 */
export async function searchPhysicians(input: NpiSearchInput): Promise<NpiPhysician[]> {
  const limit = input.limit ?? 5;
  const label = input.specialtyText ?? input.taxonomy ?? "specialist";

  if (!enabled.npiRegistry()) return mockPhysicians(label, input.taxonomy, limit);

  const { city, state } = parseLocation(input.location);
  const params = new URLSearchParams({ version: "2.1", enumeration_type: "NPI-1", limit: String(Math.min(limit, 50)) });
  if (input.taxonomy) params.set("taxonomy_description", input.taxonomy);
  if (city) params.set("city", city);
  if (state) params.set("state", state);

  try {
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: NpiApiResult[] };
    return (json.results ?? []).slice(0, limit).map(fromApi).filter((p): p is NpiPhysician => p !== null);
  } catch (err) {
    console.error("npi.searchPhysicians failed", err);
    return [];
  }
}

interface NpiApiResult {
  number?: number | string;
  basic?: { first_name?: string; last_name?: string; credential?: string };
  taxonomies?: { desc?: string; primary?: boolean }[];
  addresses?: {
    address_purpose?: string;
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    telephone_number?: string;
  }[];
}

function fromApi(r: NpiApiResult): NpiPhysician | null {
  const first = r.basic?.first_name?.trim();
  const last = r.basic?.last_name?.trim();
  if (!first || !last) return null;
  const credential = r.basic?.credential?.replace(/\.$/, "").trim() || null;
  const primaryTax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
  const loc = r.addresses?.find((a) => a.address_purpose === "LOCATION") ?? r.addresses?.[0];
  const phone = loc?.telephone_number ? loc.telephone_number.replace(/[^\d+]/g, "") : null;
  return {
    npi: String(r.number ?? ""),
    firstName: first,
    lastName: last,
    name: displayName(first, last, credential),
    credential,
    taxonomyDesc: primaryTax?.desc ?? null,
    address: loc?.address_1 ?? null,
    city: loc?.city ?? null,
    state: loc?.state ?? null,
    postalCode: loc?.postal_code ?? null,
    phone,
  };
}

/** Deterministic seeded specialists for mock mode — stable names so demos and tests don't flake. */
function mockPhysicians(label: string, taxonomy: string | undefined, limit: number): NpiPhysician[] {
  const tax = taxonomy ?? label.replace(/^\w/, (c) => c.toUpperCase());
  const seeds = [
    { first: "Avery", last: "Chen", credential: "MD", npi: "1000000001" },
    { first: "Jordan", last: "Patel", credential: "DO", npi: "1000000002" },
    { first: "Riley", last: "Nguyen", credential: "MD", npi: "1000000003" },
  ];
  return seeds.slice(0, Math.max(1, Math.min(limit, seeds.length))).map((s) => ({
    npi: s.npi,
    firstName: s.first,
    lastName: s.last,
    name: displayName(s.first, s.last, s.credential),
    credential: s.credential,
    taxonomyDesc: tax,
    address: "123 Demo St (simulated)",
    city: "Demo City",
    state: "WA",
    postalCode: "98101",
    phone: "+15555550100",
  }));
}
