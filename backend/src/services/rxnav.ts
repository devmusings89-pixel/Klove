// Drug-name autocomplete backed by the NIH RxNav "display names" list — the same curated set
// RxNav's own type-ahead uses (~28k ingredient/brand/clinical-drug names). We cache the list in
// memory (refreshed daily) so each keystroke is matched locally and instantly, then resolve the
// RxNorm code lazily only when the user actually picks a suggestion.

const DISPLAY_NAMES_URL = "https://rxnav.nlm.nih.gov/REST/displaynames.json";
const RXCUI_URL = "https://rxnav.nlm.nih.gov/REST/rxcui.json";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 15;

export type DrugSuggestion = { name: string; term: string };

let cache: string[] | null = null;
let cachedAt = 0;
let inFlight: Promise<string[]> | null = null;

/** The curated display-name list, cached in memory and refreshed at most once a day. */
async function getDrugNames(): Promise<string[]> {
  if (cache && Date.now() - cachedAt < REFRESH_MS) return cache;
  if (inFlight) return inFlight; // coalesce concurrent first-load requests
  inFlight = (async () => {
    try {
      const res = await fetch(DISPLAY_NAMES_URL);
      if (!res.ok) throw new Error(`rxnav displaynames ${res.status}`);
      const data = (await res.json()) as { displayTermsList?: { term?: string[] } };
      const terms = data.displayTermsList?.term ?? [];
      if (terms.length) {
        cache = terms;
        cachedAt = Date.now();
      }
      return cache ?? [];
    } catch {
      return cache ?? []; // serve a stale list rather than nothing on a transient failure
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Clean RxNorm's clinical "tall man" casing (e.g. "metFORMIN", "SITagliptin") into consumer-
 * friendly Title Case, leaving strength/unit tokens (anything with a digit) untouched.
 */
export function cleanDrugName(term: string): string {
  return term
    .split(/(\s+|\/)/)
    .map((tok) => {
      if (/\d/.test(tok)) return tok;
      if (/^[A-Za-z][A-Za-z'-]*$/.test(tok)) return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      return tok;
    })
    .join("");
}

/** Rank: exact (0) > prefix (1) > word-boundary prefix (2) > substring (3); lower is better. */
function score(termLower: string, qLower: string, boundary: RegExp): number {
  if (termLower === qLower) return 0;
  if (termLower.startsWith(qLower)) return 1;
  if (boundary.test(termLower)) return 2;
  if (termLower.includes(qLower)) return 3;
  return Number.POSITIVE_INFINITY;
}

/** Ranked drug-name suggestions for a partial query (prefix matches first, then shortest). */
export async function searchDrugNames(q: string): Promise<DrugSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const names = await getDrugNames();
  const qLower = query.toLowerCase();
  const boundary = new RegExp(`(^|[\\s/])${escapeRegExp(qLower)}`);

  const ranked: Array<{ term: string; s: number }> = [];
  for (const term of names) {
    const s = score(term.toLowerCase(), qLower, boundary);
    if (Number.isFinite(s)) ranked.push({ term, s });
  }
  ranked.sort((a, b) => a.s - b.s || a.term.length - b.term.length || a.term.localeCompare(b.term));

  const seen = new Set<string>();
  const results: DrugSuggestion[] = [];
  for (const { term } of ranked) {
    const name = cleanDrugName(term);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ name, term });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** Resolve a display name to its RxNorm concept id (rxcui), or null if RxNav has no exact match. */
export async function resolveRxcui(name: string): Promise<string | null> {
  const term = name.trim();
  if (!term) return null;
  try {
    const res = await fetch(`${RXCUI_URL}?name=${encodeURIComponent(term)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { idGroup?: { rxnormId?: string[] } };
    return data.idGroup?.rxnormId?.[0] ?? null;
  } catch {
    return null;
  }
}
