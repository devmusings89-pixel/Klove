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
import { lookupPlaceRating, lookupPlaceReviews, geocode, searchSpecialists, type PlaceRating } from "./lookup.js";
import { enabled } from "../config.js";
import { normalizeCarrier, networkStatus, type NetworkStatus } from "./network.js";

// Re-export so existing importers (routes, physician-detail) keep working after the network.ts extraction.
export { normalizeCarrier, networkStatus, type NetworkStatus };

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
  distanceMiles: number | null;
  matchReasons: string[];
  networkStatus: NetworkStatus;
  source: "npi" | "places" | "mock";
}

/** One ranked pick in Klove's recommendation. */
export interface RecommendationPick {
  name: string;
  /** 1–2 sentences on why this provider fits the need. */
  why: string;
  /** A short supporting quote/fact from a review, when there is one. */
  evidence: string | null;
  /** A short caveat to set expectations, when warranted. */
  caution: string | null;
}

/** Klove's structured recommendation, rendered natively (no raw markdown). */
export interface Recommendation {
  summary: string;
  picks: RecommendationPick[];
}

export interface PhysicianSearchOutput {
  resolvedSpecialty: string | null;
  resolvedSubspecialty: string | null;
  disclaimer: string;
  /** Klove's recommendation reading ratings + reviews against the stated need (first page only). */
  recommendation: Recommendation | null;
  radiusMiles: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  /** The member's own carriers on file, so the UI can label badges "Accepts Aetna" / "Check Aetna". */
  memberInsurance: string[];
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

/** Normalized insurance carriers on file for a member (from their InsurancePlan cards). */
export async function memberCarriers(subjectUserId: string): Promise<string[]> {
  const plans = await prisma.insurancePlan.findMany({
    where: { profile: { userId: subjectUserId } },
    select: { carrier: true },
  });
  const keys = plans.map((p) => normalizeCarrier(p.carrier)).filter((k): k is string => Boolean(k));
  return Array.from(new Set(keys));
}

/** Human-readable carrier names on file for a member (for display, e.g. "Aetna"). */
export async function memberCarrierNames(subjectUserId: string): Promise<string[]> {
  const plans = await prisma.insurancePlan.findMany({
    where: { profile: { userId: subjectUserId } },
    select: { carrier: true },
  });
  return Array.from(new Set(plans.map((p) => p.carrier?.trim()).filter((c): c is string => Boolean(c))));
}

// Allied-health credentials that aren't physicians — excluded from a "doctors" search. Blank credentials
// are kept (some physicians omit it). MD/DO/NP/PA/DPM/DDS/DMD/OD remain.
const ALLIED_HEALTH = new Set(["pt", "dpt", "pta", "ot", "otr", "ota", "cota", "rn", "lpn", "cna", "rd", "ldn", "lcsw", "msw", "slp", "ccc", "at", "atc", "ma"]);
function isAlliedHealth(credential: string | null): boolean {
  if (!credential) return false;
  const c = credential.replace(/[.\s]/g, "").toLowerCase();
  return ALLIED_HEALTH.has(c);
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

export interface Coordinates {
  lat: number;
  lng: number;
}

/** Great-circle distance in miles between two points (haversine). */
function milesBetween(a: Coordinates, b: Coordinates): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
  center: Coordinates | null,
  source: "npi" | "places" | "mock",
): Scored {
  const reasons: string[] = [];
  let score = 0;
  const isPediatric = PEDIATRIC_RE.test(npi.taxonomyDesc ?? "");

  // Distance from the searched location (when both the center and the provider geocoded).
  let distanceMiles: number | null = null;
  if (center && rating?.lat != null && rating?.lng != null) {
    distanceMiles = Math.round(milesBetween(center, { lat: rating.lat, lng: rating.lng }) * 10) / 10;
    reasons.push(`${distanceMiles} mi away`);
    score += Math.max(0, 3 - distanceMiles / 10); // mild nearer-is-better nudge, never dominates quality
  }

  // Credential match: a real MD/DO in the requested taxonomy is the baseline of "expert".
  if (npi.taxonomyDesc) {
    const taxMatch = resolved.npiTaxonomy && npi.taxonomyDesc.toLowerCase().includes(resolved.npiTaxonomy.toLowerCase());
    score += taxMatch ? 6 : 3;
    const cred = npi.credential ? `${npi.credential} · ` : "";
    reasons.push(`${cred}${npi.taxonomyDesc}`.trim());
  }
  // Credential may arrive as "MD", "M.D", "M.D." etc. — strip dots/spaces before matching.
  if (npi.credential && /^(md|do)$/i.test(npi.credential.replace(/[.\s]/g, ""))) score += 1;

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
      distanceMiles,
      source,
    },
    score,
    reasons,
  };
}

/** Treat a Places relevance hit (clinic or named doctor) as a scored candidate, reusing scorePhysician. */
function scoreSpecialistPlace(
  place: { name: string } & PlaceRating,
  resolved: ResolvedCondition,
  audience: PatientAudience,
  center: Coordinates | null,
): Scored {
  const synthetic: NpiPhysician = {
    npi: "",
    firstName: "",
    lastName: "",
    name: place.name,
    credential: null,
    taxonomyDesc: [resolved.npiTaxonomy ?? titleCase(resolved.specialty), resolved.subspecialty ? titleCase(resolved.subspecialty) : null]
      .filter(Boolean)
      .join(" · "),
    address: place.address,
    city: null,
    state: null,
    postalCode: null,
    phone: place.phone,
  };
  // A relevance hit already matched the condition in Google's index, so credit the taxonomy match.
  const scored = scorePhysician(synthetic, place, { ...resolved, npiTaxonomy: resolved.npiTaxonomy }, audience, center, "places");
  return scored;
}

function titleCase(s: string | null): string {
  if (!s) return "";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface PhysicianSearchInput {
  householdId: string;
  subjectUserId: string;
  condition: string;
  location?: string;
  /** Page size (default 20). */
  limit?: number;
  /** Pagination offset into the registry (for "load more"). */
  offset?: number;
  /** Only keep providers within this many miles of `location` (when both geocode). */
  radiusMiles?: number;
}

export const RECOMMEND_CAP = 8; // how many top candidates we read reviews for + hand the recommender

/**
 * Search for the best specialists for a condition: resolves the specialty, pages the NPI registry,
 * enriches with Google ratings + location, filters by radius + age, ranks (rating-led), labels in-network,
 * and — on the first page — reads review snippets to write a plain-language recommendation for the need.
 */
export async function searchPhysicians(input: PhysicianSearchInput): Promise<PhysicianSearchOutput> {
  const limit = input.limit ?? 20;
  const offset = Math.max(0, input.offset ?? 0);
  const radiusMiles = input.location ? input.radiusMiles ?? 20 : null;

  const resolved = await resolveCondition(input.condition);
  if (!resolved.npiTaxonomy && !resolved.specialty) {
    return empty(radiusMiles);
  }

  const audience = await patientAudience(input.subjectUserId);
  // Geocode the search location once so we can compute per-provider distance + apply the radius.
  const center = input.location ? await geocode(input.location) : null;

  // One registry page at this offset. hasMore = the page came back full (more likely exist).
  const candidates = await npiSearch({
    taxonomy: resolved.npiTaxonomy ?? undefined,
    specialtyText: resolved.specialty ?? undefined,
    location: input.location,
    limit,
    skip: offset,
  });
  const hasMore = candidates.length === limit;

  // NPI's taxonomy_description match is loose: "Neurology" also returns allied-health roles like
  // "Physical Therapist, Neurology". For a doctor search, drop clearly non-physician credentials, and
  // drop pediatric-only specialists for adult patients.
  const filtered = candidates.filter(
    (c) => !isAlliedHealth(c.credential) && !(audience.isMinor === false && PEDIATRIC_RE.test(c.taxonomyDesc ?? "")),
  );

  // Enrich the NPI page with Google ratings + location (quality + distance signal).
  const npiSource: "npi" | "mock" = enabled.npiRegistry() ? "npi" : "mock";
  const ratings = await Promise.all(filtered.map((c) => lookupPlaceRating(c.name, c.address)));
  const npiScored = filtered.map((c, i) => scorePhysician(c, ratings[i], resolved, audience, center, npiSource));

  // Discovery: on the first page, add Google's relevance-ranked specialists/clinics for the resolved
  // specialty. NPI lists every neurologist alphabetically with no "headache" signal, so the actual
  // experts (e.g. a headache center) are buried hundreds deep — this surfaces them by relevance + rating.
  let placesScored: Scored[] = [];
  if (offset === 0) {
    const terms = [resolved.subspecialty, resolved.specialty].filter(Boolean).join(" ").trim() || resolved.npiTaxonomy || "";
    const query = input.location ? `${terms} near ${input.location}` : terms;
    const places = query ? await searchSpecialists(query, 8) : [];
    placesScored = places.map((p) => scoreSpecialistPlace(p, resolved, audience, center));
  }

  // Merge NPI + discovery, dedupe by normalized name (keep the higher-scored — discovery usually wins on rating).
  const byKey = new Map<string, Scored>();
  for (const s of [...placesScored, ...npiScored]) {
    const key = s.result.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = byKey.get(key);
    if (!existing || s.score > existing.score) byKey.set(key, s);
  }
  let scored = Array.from(byKey.values());

  // Radius filter: drop providers we KNOW are beyond the radius; keep those we couldn't geocode.
  if (radiusMiles != null) {
    scored = scored.filter((s) => s.result.distanceMiles == null || s.result.distanceMiles <= radiusMiles);
  }
  scored.sort((a, b) => b.score - a.score);
  scored = scored.slice(0, limit);

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

  // Neither insurance nor the recommendation is computed here — the search returns immediately. The
  // client loads both progressively after the list renders: each card verifies its insurance as it
  // appears (GET /physicians/network), and the recommendation loads once (POST /physicians/recommendation).
  // Results already tagged in the directory keep their status from above.
  const memberInsurance = await memberCarrierNames(input.subjectUserId);

  return {
    resolvedSpecialty: resolved.specialty,
    resolvedSubspecialty: resolved.subspecialty,
    disclaimer: DISCLAIMER,
    recommendation: null,
    radiusMiles,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    memberInsurance,
    results,
  };
}

function empty(radiusMiles: number | null): PhysicianSearchOutput {
  return {
    resolvedSpecialty: null,
    resolvedSubspecialty: null,
    disclaimer: DISCLAIMER,
    recommendation: null,
    radiusMiles,
    hasMore: false,
    nextOffset: null,
    memberInsurance: [],
    results: [],
  };
}

const RECOMMEND_TOOL = {
  name: "recommend_specialists",
  description:
    "Recommend the best 2–3 specialists for the patient's specific need, reading the ratings and review " +
    "snippets provided. Be concise and professional. Cite concrete evidence; be honest when evidence is " +
    "thin or absent — never invent experience that isn't in the data.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One plain, professional sentence framing the overall recommendation." },
      picks: {
        type: "array",
        description: "2–3 recommended providers, best first.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The provider/clinic name exactly as given." },
            why: { type: "string", description: "1–2 concise sentences on why they fit the need (mention rating/expertise)." },
            evidence: { type: "string", description: "A short supporting quote or fact from a review, lightly trimmed; omit if none." },
            caution: { type: "string", description: "A brief caveat to set expectations (e.g. 'no Botox evidence in reviews'); omit if none." },
          },
          required: ["name", "why"],
        },
      },
    },
    required: ["summary", "picks"],
  } as Record<string, unknown>,
};

interface RawPick {
  name?: string;
  why?: string;
  evidence?: string;
  caution?: string;
}

/** The minimal candidate shape the recommender needs (so it can run from a client-supplied list). */
export interface RecommendCandidate {
  name: string;
  address?: string | null;
  taxonomyDesc?: string | null;
  specialty?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  distanceMiles?: number | null;
}

/**
 * Read each top candidate's Google reviews and produce a STRUCTURED recommendation matching the stated
 * need (e.g. "Botox experience for migraine" → who has review evidence of it). Returns null when no LLM
 * is configured or there's nothing to read, so the UI omits the section. Exported so it can run async as
 * its own endpoint after the (fast) search returns.
 */
export async function recommend(condition: string, top: RecommendCandidate[]): Promise<Recommendation | null> {
  if (top.length === 0) return null;
  // Pull review snippets for the candidates with a Google listing (bounded by RECOMMEND_CAP upstream).
  const withReviews = await Promise.all(
    top.map(async (r) => ({ r, reviews: r.rating != null ? await lookupPlaceReviews(r.name, r.address) : [] })),
  );

  const dossier = withReviews
    .map(({ r, reviews }, i) => {
      const lines = [
        `${i + 1}. ${r.name} — ${r.taxonomyDesc ?? r.specialty}`,
        `   rating: ${r.rating != null ? `${r.rating}★ (${r.reviewCount ?? 0} reviews)` : "none"}` +
          (r.distanceMiles != null ? `, ${r.distanceMiles} mi` : ""),
      ];
      if (reviews.length) lines.push(`   reviews: ${reviews.map((t) => `"${t.replace(/\s+/g, " ").slice(0, 240)}"`).join(" | ")}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const out = await runTool<{ summary?: string; picks?: RawPick[] }>({
    system:
      "You are Klove, a careful care navigator. Recommend the best matches for the patient's need from the " +
      "given specialists, reading their ratings and reviews. Professional, concrete, and honest about gaps.",
    content: `Patient need: "${condition}"\n\nCandidates:\n${dossier}`,
    tool: RECOMMEND_TOOL,
    maxTokens: 700,
  });
  if (!out?.summary || !out.picks?.length) return null;
  return {
    summary: out.summary.trim(),
    picks: out.picks
      .filter((p) => p.name && p.why)
      .map((p) => ({ name: p.name!.trim(), why: p.why!.trim(), evidence: p.evidence?.trim() || null, caution: p.caution?.trim() || null })),
  };
}
