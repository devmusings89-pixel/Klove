// Known-provider directory. Stores every provider the household has used (auto-captured after a
// successful booking, backfilled from past Appointments) plus ones the operator searches/adds, and
// resolves the right provider for a new booking — so the booking pipeline already has the contact
// details and never dead-ends on "couldn't reach an office".
//
// Selection reuses the same specialty-keyword classification the booking concierge uses (kept here so
// both sides agree on what a "dentist" or "dermatologist" is). Resolution order: directory (member →
// household, by specialty + name + recency) → Google Places → none (caller asks the user).

import type { Provider } from "@prisma/client";
import { prisma } from "../db.js";
import { searchOffices, type OfficeMatch } from "./lookup.js";

/** Free-text → normalized specialty key. Mirrors intake.ts so the directory and concierge agree. */
export const SPECIALTY_KEYWORDS: Record<string, RegExp> = {
  dentist: /dent|dds|dmd|orthodon|hygien|teeth|tooth/i,
  dermatologist: /derm|skin/i,
  "primary care": /primary|family medicine|internist|internal medicine|gp|pcp/i,
  cardiologist: /cardio|heart/i,
  "eye doctor": /optom|ophthal|eye|vision/i,
  "ob-gyn": /ob.?gyn|obstetric|gynec/i,
  pediatrician: /pediatr|child/i,
  endocrinologist: /endocrin|diabet|thyroid/i,
};

/** Classify a reason/specialty phrase into a normalized specialty key, or undefined. */
export function classifySpecialty(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (SPECIALTY_KEYWORDS[t]) return t; // already a normalized key
  for (const [key, re] of Object.entries(SPECIALTY_KEYWORDS)) if (re.test(t)) return key;
  return undefined;
}

export interface ResolveProviderInput {
  householdId: string;
  subjectUserId: string;
  reason?: string;
  specialty?: string;
  /** A specific office/doctor name the user named (e.g. "Dr. Lee", "ABC Dermatology"). */
  providerHint?: string;
  /** Bias the Places fallback search by area. */
  location?: string;
}

export interface ProviderResolution {
  /** Best directory match (has contact), or null when none/Places. */
  provider: Provider | null;
  /** Ranked directory matches (best first). */
  candidates: Provider[];
  /** A Google Places match when the directory missed — not yet saved to the directory. */
  fromPlaces?: OfficeMatch;
  source: "directory" | "places" | "none";
}

/**
 * Resolve the best provider for a booking. Directory first (member-scoped beats household-wide, scored
 * by specialty + name + recency), then Google Places, else "none" so the caller asks the user.
 */
export async function resolveProvider(input: ResolveProviderInput): Promise<ProviderResolution> {
  const specialty =
    input.specialty ?? classifySpecialty(input.providerHint) ?? classifySpecialty(input.reason);

  const directory = await prisma.provider.findMany({ where: { householdId: input.householdId } });
  const candidates = rankProviders(directory, {
    subjectUserId: input.subjectUserId,
    specialty,
    reason: input.reason,
    providerHint: input.providerHint,
  });
  if (candidates.length) return { provider: candidates[0], candidates, source: "directory" };

  // Directory miss → look the office up via Places ONLY when the user named a specific office/doctor.
  // A bare specialty/reason ("botox for migraines") must NOT auto-resolve to whatever Places ranks
  // first — that produces a random clinic the user never chose. In that case return "none" so the
  // caller asks the user to pick a provider (app: needs_provider recap; agent: "what's the office?").
  const base = (input.providerHint || "").trim();
  if (base) {
    const query = input.location ? `${base} near ${input.location}` : base;
    const matches = await searchOffices(query);
    if (matches.length) return { provider: null, candidates: [], fromPlaces: matches[0], source: "places" };
  }
  return { provider: null, candidates: [], source: "none" };
}

interface RankInput {
  subjectUserId: string;
  specialty?: string;
  reason?: string;
  providerHint?: string;
}

/** Score directory providers for a request; member-scoped + specialty + recency win. Deduped by name. */
export function rankProviders(providers: Provider[], opts: RankInput): Provider[] {
  const terms = [opts.specialty, opts.reason, opts.providerHint].filter(Boolean).join(" ").toLowerCase();
  if (!terms.trim() && !opts.providerHint) return [];
  const specialtyRe = opts.specialty ? SPECIALTY_KEYWORDS[opts.specialty.toLowerCase()] : undefined;
  const words = terms.split(/\s+/).filter((w) => w.length > 3);
  const hint = opts.providerHint?.toLowerCase();

  const scored = providers
    .map((p) => {
      const hay = `${p.name} ${p.specialty ?? ""} ${p.address ?? ""}`.toLowerCase();
      // Relevance must come from a real name/specialty match — being the member's provider is only a
      // TIE-BREAKER, never enough on its own (else a member's dentist would match a dermatologist ask).
      let relevance = 0;
      if (hint && hay.includes(hint)) relevance += 5; // a named office/doctor dominates
      if (opts.specialty && p.specialty && p.specialty.toLowerCase() === opts.specialty.toLowerCase()) relevance += 4;
      if (specialtyRe && specialtyRe.test(hay)) relevance += 3;
      for (const w of words) if (hay.includes(w)) relevance += 1;
      if (relevance === 0) return { p, score: 0 };
      let score = relevance;
      if (p.subjectUserId === opts.subjectUserId) score += 2; // this member's own provider
      else if (p.subjectUserId == null) score += 1; // household-wide shared provider
      return { p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || lastUsedDesc(a.p, b.p));

  const seen = new Set<string>();
  const out: Provider[] = [];
  for (const { p } of scored) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 5) break;
  }
  return out;
}

function lastUsedDesc(a: Provider, b: Provider): number {
  return (b.lastUsedAt?.getTime() ?? b.createdAt.getTime()) - (a.lastUsedAt?.getTime() ?? a.createdAt.getTime());
}

export interface UpsertProviderInput {
  householdId: string;
  subjectUserId?: string | null; // null = household-wide
  name: string;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  specialty?: string | null;
  source?: string; // booking | appointment | manual | places | search
  npi?: string | null;
  /** Normalized insurance carrier keys this provider accepts (drives in-network status). Replaces when set. */
  acceptedCarriers?: string[];
  /** The booking channel that succeeded (web | voice | messaging) — remembered + tried first next time. */
  preferredBookingMethod?: string | null;
  /** When set, bumps lastUsedAt to the max of the existing value and this. */
  usedAt?: Date | null;
}

/**
 * Upsert a provider into the directory, deduped by name within the household + member scope. Called
 * after a successful booking and from manual add; refreshes contact details and recency.
 */
export async function upsertProvider(input: UpsertProviderInput): Promise<Provider | null> {
  const name = input.name?.trim();
  if (!name) return null;
  const subjectUserId = input.subjectUserId ?? null;
  const existing = await prisma.provider.findFirst({
    where: { householdId: input.householdId, subjectUserId, name: { equals: name, mode: "insensitive" } },
  });

  const lastUsedAt = pickLatest(existing?.lastUsedAt ?? null, input.usedAt ?? null);
  const data = {
    phone: input.phone ?? existing?.phone ?? null,
    website: input.website ?? existing?.website ?? null,
    address: input.address ?? existing?.address ?? null,
    specialty: input.specialty ?? existing?.specialty ?? null,
    source: input.source ?? existing?.source ?? "manual",
    npi: input.npi ?? existing?.npi ?? null,
    acceptedCarriers: input.acceptedCarriers ?? existing?.acceptedCarriers ?? [],
    preferredBookingMethod: input.preferredBookingMethod ?? existing?.preferredBookingMethod ?? null,
    lastUsedAt,
  };
  if (existing) return prisma.provider.update({ where: { id: existing.id }, data });
  return prisma.provider.create({ data: { householdId: input.householdId, subjectUserId, name, ...data } });
}

function pickLatest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** List the directory for a household (optionally biased to a member: their providers + shared). */
export async function listProviders(householdId: string, opts?: { subjectUserId?: string }): Promise<Provider[]> {
  return prisma.provider.findMany({
    where: {
      householdId,
      ...(opts?.subjectUserId ? { OR: [{ subjectUserId: opts.subjectUserId }, { subjectUserId: null }] } : {}),
    },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
  });
}

/** Search the directory + Places for the add-provider UI. */
export async function searchProviders(
  householdId: string,
  query: string,
): Promise<{ directory: Provider[]; places: OfficeMatch[] }> {
  const q = query.trim();
  const directory = await prisma.provider.findMany({
    where: q
      ? {
          householdId,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { specialty: { contains: q, mode: "insensitive" } },
          ],
        }
      : { householdId },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    take: 10,
  });
  const places = q.length >= 3 ? await searchOffices(q) : [];
  return { directory, places };
}

/**
 * Seed a household's directory from its members' past Appointments. Idempotent (dedup upsert), so it's
 * safe to run repeatedly. Returns the number of providers captured.
 */
export async function backfillProviders(householdId: string): Promise<number> {
  const members = await prisma.householdMembership.findMany({ where: { householdId }, select: { userId: true } });
  const ids = members.map((m) => m.userId);
  if (ids.length === 0) return 0;
  const appts = await prisma.appointment.findMany({
    where: { userId: { in: ids }, provider: { not: null } },
    orderBy: { startsAt: "desc" },
  });
  let n = 0;
  for (const a of appts) {
    const r = await upsertProvider({
      householdId,
      subjectUserId: a.userId,
      name: a.provider!,
      phone: a.providerPhone,
      website: a.providerWebsite,
      address: a.providerAddress ?? a.location,
      specialty: classifySpecialty(a.title),
      source: "appointment",
      usedAt: a.startsAt ?? a.recordedAt,
    });
    if (r) n++;
  }
  return n;
}
