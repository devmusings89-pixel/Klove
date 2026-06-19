// "Best expert for my condition" search. Turns a free-text condition into the right specialty (LLM with
// a keyword fallback), finds credentialed specialists in the NPI registry, enriches them with Google
// ratings as a quality proxy, ranks them, and labels each in-network / out-of-network / unconfirmed
// against the member's saved insurance carriers.
//
// Honest by design: NPI + Places carry no payer data, so a fresh hit is "unconfirmed" unless we already
// have it saved + tagged with accepted carriers (see Provider.acceptedCarriers). Ratings are a proxy for
// quality, not clinical-outcomes data — surfaced in matchReasons and the disclaimer.

import { prisma } from "../db.js";
import { runTool } from "./llm-tool.js";
import { classifySpecialty } from "./providers.js";
import { searchPhysicians as npiSearch, type NpiPhysician } from "./npi.js";
import { lookupPlaceRating, type PlaceRating } from "./lookup.js";
import { enabled } from "../config.js";

export type NetworkStatus = "in_network" | "out_of_network" | "unconfirmed" | "unknown";

export interface PhysicianResult {
  npi: string | null;
  name: string;
  credential: string | null;
  specialty: string;
  subspecialty: string | null;
  taxonomyDesc: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  matchReasons: string[];
  networkStatus: NetworkStatus;
  source: "npi" | "mock";
}

export interface PhysicianSearchOutput {
  resolvedSpecialty: string | null;
  resolvedSubspecialty: string | null;
  disclaimer: string;
  results: PhysicianResult[];
}

const DISCLAIMER =
  "Rankings use credentials and public ratings as a quality guide, not clinical-outcomes data. " +
  "Network status is a best-effort match on your insurance carrier — always confirm coverage with the office before booking.";

// ---- Specialty → NPI taxonomy ----
// Maps our normalized specialty keys (SPECIALTY_KEYWORDS in providers.ts) to NPI taxonomy descriptions.
const SPECIALTY_TAXONOMY: Record<string, string> = {
  dentist: "Dentist",
  dermatologist: "Dermatology",
  "primary care": "Family Medicine",
  cardiologist: "Cardiovascular Disease",
  "eye doctor": "Ophthalmology",
  "ob-gyn": "Obstetrics & Gynecology",
  pediatrician: "Pediatrics",
  endocrinologist: "Endocrinology, Diabetes & Metabolism",
};

interface ResolvedCondition {
  specialty: string | null;
  subspecialty: string | null;
  npiTaxonomy: string | null;
}

const RESOLVE_CONDITION_TOOL = {
  name: "route_condition",
  description:
    "Route a patient's described condition or symptom to the medical specialty best suited to treat it, " +
    "so we can search a physician directory. Map to the most specific appropriate specialty.",
  input_schema: {
    type: "object",
    properties: {
      specialty: {
        type: "string",
        description:
          "The specialty as a short noun phrase, e.g. 'dermatologist', 'cardiologist', 'rheumatologist', 'orthopedic surgeon'.",
      },
      subspecialty: {
        type: "string",
        description:
          "A more specific subspecialty when the condition warrants it, e.g. 'electrophysiology' for arrhythmias, 'sports medicine' for a torn ACL; omit if none.",
      },
      npi_taxonomy: {
        type: "string",
        description:
          "The matching NPI Registry taxonomy DESCRIPTION used to filter the directory, e.g. 'Dermatology', " +
          "'Cardiovascular Disease', 'Rheumatology', 'Orthopaedic Surgery'. Use official NPI taxonomy wording.",
      },
    },
    required: ["specialty", "npi_taxonomy"],
  } as Record<string, unknown>,
};

/** Resolve a free-text condition to a specialty + NPI taxonomy. LLM first, keyword fallback otherwise. */
export async function resolveCondition(condition: string): Promise<ResolvedCondition> {
  const text = condition.trim();
  if (!text) return { specialty: null, subspecialty: null, npiTaxonomy: null };

  const llm = await runTool<{ specialty?: string; subspecialty?: string; npi_taxonomy?: string }>({
    system:
      "You are a medical-specialty router for a care-navigation app. Given a patient's described condition " +
      "or symptom, identify the specialty best suited to treat it. Always call the tool.",
    content: `Condition: ${text}`,
    tool: RESOLVE_CONDITION_TOOL,
    maxTokens: 256,
  });
  if (llm?.specialty && llm.npi_taxonomy) {
    return {
      specialty: llm.specialty.trim(),
      subspecialty: llm.subspecialty?.trim() || null,
      npiTaxonomy: llm.npi_taxonomy.trim(),
    };
  }

  // Fallback: keyword classification → taxonomy map (covers the common specialties offline / no LLM).
  const key = classifySpecialty(text);
  if (key) return { specialty: key, subspecialty: null, npiTaxonomy: SPECIALTY_TAXONOMY[key] ?? null };
  return { specialty: null, subspecialty: null, npiTaxonomy: null };
}

// ---- In-network carrier heuristic ----

/** Collapse carrier names/aliases to a normalized key so "Anthem BCBS" and "Blue Cross" match. */
export function normalizeCarrier(name: string | null | undefined): string | null {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return null;
  if (/blue cross|blue shield|bcbs|anthem|carefirst|premera|regence/.test(n)) return "bcbs";
  if (/unitedhealth|united health|\buhc\b|\bunited\b|optum/.test(n)) return "unitedhealth";
  if (/aetna/.test(n)) return "aetna";
  if (/cigna/.test(n)) return "cigna";
  if (/humana/.test(n)) return "humana";
  if (/kaiser/.test(n)) return "kaiser";
  if (/medicare/.test(n)) return "medicare";
  if (/medicaid/.test(n)) return "medicaid";
  // Unknown carrier: keep a compacted token so exact-string matches still work.
  return n.replace(/[^a-z0-9]+/g, "");
}

/** Normalized insurance carriers on file for a member (from their InsurancePlan cards). */
export async function memberCarriers(subjectUserId: string): Promise<string[]> {
  const plans = await prisma.insurancePlan.findMany({
    where: { profile: { userId: subjectUserId } },
    select: { carrier: true },
  });
  const keys = plans.map((p) => normalizeCarrier(p.carrier)).filter((k): k is string => Boolean(k));
  return Array.from(new Set(keys));
}

/** Decide in-network status from a provider's accepted carriers vs the member's carriers. */
export function networkStatus(accepted: string[], member: string[]): NetworkStatus {
  if (member.length === 0) return "unknown"; // no insurance on file to check against
  if (accepted.length === 0) return "unconfirmed"; // we don't know what this provider takes
  return accepted.some((a) => member.includes(a)) ? "in_network" : "out_of_network";
}

// ---- Ranking ----

interface Scored {
  result: Omit<PhysicianResult, "matchReasons" | "networkStatus">;
  score: number;
  reasons: string[];
}

function scorePhysician(
  npi: NpiPhysician,
  rating: PlaceRating | null,
  resolved: ResolvedCondition,
): Scored {
  const reasons: string[] = [];
  let score = 0;

  // Credential match: a real MD/DO in the requested taxonomy is the baseline of "expert".
  if (npi.taxonomyDesc) {
    const taxMatch = resolved.npiTaxonomy && npi.taxonomyDesc.toLowerCase().includes(resolved.npiTaxonomy.toLowerCase());
    score += taxMatch ? 6 : 3;
    const cred = npi.credential ? `${npi.credential} · ` : "";
    reasons.push(`${cred}${npi.taxonomyDesc}`.trim());
  }
  if (npi.credential && /^(md|do)$/i.test(npi.credential)) score += 1;

  // Ratings as a quality proxy: weight the average by how many reviews back it (log-damped).
  if (rating?.rating != null) {
    const count = rating.userRatingCount ?? 0;
    score += rating.rating * (1 + Math.log10(1 + count));
    reasons.push(count > 0 ? `${rating.rating.toFixed(1)}★ · ${count} reviews` : `${rating.rating.toFixed(1)}★`);
  }

  const phone = rating?.phone ?? npi.phone;
  const website = rating?.website ?? null;
  const address =
    rating?.address ?? ([npi.address, npi.city, npi.state].filter(Boolean).join(", ") || null);

  return {
    result: {
      npi: npi.npi || null,
      name: npi.name,
      credential: npi.credential,
      specialty: resolved.specialty ?? "",
      subspecialty: resolved.subspecialty,
      taxonomyDesc: npi.taxonomyDesc,
      address,
      phone,
      website,
      rating: rating?.rating ?? null,
      reviewCount: rating?.userRatingCount ?? null,
      source: enabled.npiRegistry() ? "npi" : "mock",
    },
    score,
    reasons,
  };
}

export interface PhysicianSearchInput {
  householdId: string;
  subjectUserId: string;
  condition: string;
  location?: string;
  limit?: number;
}

/**
 * Search for the best specialists for a condition, ranked, with in-network status. Resolves the
 * specialty, queries the NPI registry, enriches with Google ratings, ranks, and labels each against the
 * member's insurance + any matching saved directory provider's accepted carriers.
 */
export async function searchPhysicians(input: PhysicianSearchInput): Promise<PhysicianSearchOutput> {
  const resolved = await resolveCondition(input.condition);
  if (!resolved.npiTaxonomy && !resolved.specialty) {
    return { resolvedSpecialty: null, resolvedSubspecialty: null, disclaimer: DISCLAIMER, results: [] };
  }

  const limit = input.limit ?? 5;
  const candidates = await npiSearch({
    taxonomy: resolved.npiTaxonomy ?? undefined,
    specialtyText: resolved.specialty ?? undefined,
    location: input.location,
    limit,
  });

  // Enrich with Google ratings in parallel (null in mock / when Places is off).
  const ratings = await Promise.all(candidates.map((c) => lookupPlaceRating(c.name, c.address)));
  const scored = candidates
    .map((c, i) => scorePhysician(c, ratings[i], resolved))
    .sort((a, b) => b.score - a.score);

  // In-network: member carriers + any saved directory provider's tagged accepted carriers.
  const member = await memberCarriers(input.subjectUserId);
  const saved = await prisma.provider.findMany({
    where: { householdId: input.householdId },
    select: { npi: true, name: true, acceptedCarriers: true },
  });
  const byNpi = new Map(saved.filter((s) => s.npi).map((s) => [s.npi!, s.acceptedCarriers]));
  const byName = new Map(saved.map((s) => [s.name.toLowerCase(), s.acceptedCarriers]));

  const results: PhysicianResult[] = scored.map(({ result, reasons }) => {
    const accepted = (result.npi && byNpi.get(result.npi)) || byName.get(result.name.toLowerCase()) || [];
    return { ...result, matchReasons: reasons, networkStatus: networkStatus(accepted, member) };
  });

  return {
    resolvedSpecialty: resolved.specialty,
    resolvedSubspecialty: resolved.subspecialty,
    disclaimer: DISCLAIMER,
    results,
  };
}
