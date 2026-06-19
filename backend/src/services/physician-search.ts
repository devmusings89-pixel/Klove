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

// ---- Patient audience (adult vs child) ----
// The NPI taxonomy is broad ("Neurology"), so an adult migraine search otherwise surfaces pediatric
// neurologists. We use the member's DOB to drop pediatric-only specialists for adults and prefer them
// for minors. Pediatric taxonomies say "Pediatric ..." or "... Child Neurology".
const PEDIATRIC_RE = /\bchild\b|pediatr/i;

export interface PatientAudience {
  /** true = minor, false = adult, null = unknown (no DOB on file). */
  isMinor: boolean | null;
}

/** Age in whole years from an ISO yyyy-mm-dd string, or null if unparseable. */
function ageFromDob(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob.trim());
  if (!m) return null;
  const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const before = now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (before) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** Is the patient a minor? Reads the member's profile DOB; null when none on file. */
export async function patientAudience(subjectUserId: string): Promise<PatientAudience> {
  const profile = await prisma.profile.findFirst({
    where: { userId: subjectUserId, dob: { not: null } },
    select: { dob: true },
  });
  if (!profile?.dob) return { isMinor: null };
  const age = ageFromDob(profile.dob);
  return { isMinor: age == null ? null : age < 18 };
}

// ---- Ranking ----

// Bayesian prior for rating shrinkage: an assumed average clinic rating and how many reviews a place
// needs before its own average outweighs that prior.
const RATING_PRIOR_MEAN = 4.0;
const RATING_PRIOR_WEIGHT = 20;

interface Scored {
  result: Omit<PhysicianResult, "matchReasons" | "networkStatus">;
  score: number;
  reasons: string[];
}

function scorePhysician(
  npi: NpiPhysician,
  rating: PlaceRating | null,
  resolved: ResolvedCondition,
  audience: PatientAudience,
): Scored {
  const reasons: string[] = [];
  let score = 0;
  const isPediatric = PEDIATRIC_RE.test(npi.taxonomyDesc ?? "");

  // Credential match: a real MD/DO in the requested taxonomy is the baseline of "expert".
  if (npi.taxonomyDesc) {
    const taxMatch = resolved.npiTaxonomy && npi.taxonomyDesc.toLowerCase().includes(resolved.npiTaxonomy.toLowerCase());
    score += taxMatch ? 6 : 3;
    const cred = npi.credential ? `${npi.credential} · ` : "";
    reasons.push(`${cred}${npi.taxonomyDesc}`.trim());
  }
  if (npi.credential && /^(md|do)$/i.test(npi.credential)) score += 1;

  // Age fit: a minor's search should prefer pediatric specialists (adults are filtered upstream).
  if (audience.isMinor === true && isPediatric) {
    score += 3;
    reasons.push("Pediatric specialist");
  }

  // Ratings as a quality proxy, rating-led with review count as CONFIDENCE (Bayesian shrinkage): a few
  // glowing reviews are pulled toward the prior mean so a 5★ (1 review) doesn't beat a solid 4.5★ (200),
  // and a high-volume mediocre score doesn't beat a high rating. Unrated providers sit neutral (the
  // prior) rather than dead last, so a doctor with no Google listing isn't punished below a 2-star one.
  let quality = RATING_PRIOR_MEAN;
  if (rating?.rating != null) {
    const v = rating.userRatingCount ?? 0;
    quality = (v / (v + RATING_PRIOR_WEIGHT)) * rating.rating + (RATING_PRIOR_WEIGHT / (v + RATING_PRIOR_WEIGHT)) * RATING_PRIOR_MEAN;
    reasons.push(v > 0 ? `${rating.rating.toFixed(1)}★ · ${v} reviews` : `${rating.rating.toFixed(1)}★`);
  }
  score += quality * 3; // dominant differentiator among same-specialty candidates (range ~7.5–15)

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
  // Pull a wider pool than we return so ranking (ratings + age fit) has candidates to sort, not just
  // the registry's default alphabetical order.
  const pool = Math.max(limit * 4, 20);
  const audience = await patientAudience(input.subjectUserId);
  const candidates = await npiSearch({
    taxonomy: resolved.npiTaxonomy ?? undefined,
    specialtyText: resolved.specialty ?? undefined,
    location: input.location,
    limit: pool,
  });

  // Drop pediatric-only specialists for adult patients (NPI's taxonomy is too broad to do this server-side).
  const filtered = audience.isMinor === false ? candidates.filter((c) => !PEDIATRIC_RE.test(c.taxonomyDesc ?? "")) : candidates;

  // Enrich with Google ratings (the quality signal), capped to bound Places calls per search.
  const ENRICH_CAP = Math.min(filtered.length, Math.max(limit * 2, 12));
  const ratings = await Promise.all(
    filtered.map((c, i) => (i < ENRICH_CAP ? lookupPlaceRating(c.name, c.address) : Promise.resolve(null))),
  );
  const scored = filtered
    .map((c, i) => scorePhysician(c, ratings[i], resolved, audience))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

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
