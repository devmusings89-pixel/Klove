import { config, enabled } from "../config.js";

/**
 * Find a phone number for an office by name via Google Places.
 * Returns null when not configured or not found (caller skips the target).
 */
export async function lookupPhoneNumber(officeName: string): Promise<string | null> {
  if (!enabled.googlePlaces()) {
    // Never fabricate a number when real calls are enabled — Vapi can't dial a fake one.
    // Only return a placeholder in full-mock mode (Vapi also off) so the demo flow works.
    return enabled.vapi() ? null : "+15555550100";
  }

  try {
    // Places API (New) Text Search with a field mask for the phone number.
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": "places.internationalPhoneNumber,places.displayName",
      },
      body: JSON.stringify({ textQuery: officeName }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: { internationalPhoneNumber?: string }[];
    };
    const phone = json.places?.[0]?.internationalPhoneNumber;
    if (!phone) return null;
    return phone.replace(/[^\d+]/g, ""); // normalize to E.164-ish
  } catch (err) {
    console.error("lookupPhoneNumber failed", err);
    return null;
  }
}

export interface OfficeMatch {
  displayName: string;
  phone: string | null;
  website: string | null;
  address: string | null;
}

/**
 * Resolve an office by name in a single Places call — used by the booking form to give the user
 * immediate "found it / couldn't find it" feedback before they commit to booking.
 *
 * In full-mock mode (no Places key, Vapi off) we echo the typed name back as a match so the demo
 * flow shows a resolved office. When Vapi is live we never fabricate a match (a fake office would
 * send a real call nowhere), so an unconfigured Places key yields null → "couldn't find it".
 */
export async function resolveOffice(officeName: string): Promise<OfficeMatch | null> {
  const query = officeName.trim();
  if (!query) return null;
  if (!enabled.googlePlaces()) {
    if (enabled.vapi()) return null;
    return { displayName: query, phone: "+15555550100", website: null, address: null };
  }
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: query }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        internationalPhoneNumber?: string;
        websiteUri?: string;
        formattedAddress?: string;
      }[];
    };
    const p = json.places?.[0];
    if (!p) return null;
    return {
      displayName: p.displayName?.text ?? query,
      phone: p.internationalPhoneNumber ? p.internationalPhoneNumber.replace(/[^\d+]/g, "") : null,
      website: p.websiteUri ?? null,
      address: p.formattedAddress ?? null,
    };
  } catch (err) {
    console.error("resolveOffice failed", err);
    return null;
  }
}

/**
 * Search for candidate offices/providers (by name, or by specialty + location) via Google Places
 * Text Search. Returns up to `limit` matches with contact info — the concierge agent shows the top
 * one to confirm before booking it live.
 *
 * Mock behavior mirrors resolveOffice: in full-mock (no Places key, Vapi off) we return a single
 * placeholder so the demo flow proceeds; when Vapi is live but Places is unconfigured we return []
 * (no fabricated office — a fake match would send a real call nowhere) so the agent stays honest.
 */
export async function searchOffices(query: string, limit = 3): Promise<OfficeMatch[]> {
  const q = query.trim();
  if (!q) return [];
  if (!enabled.googlePlaces()) {
    if (enabled.vapi()) return [];
    return [{ displayName: q, phone: "+15555550100", website: null, address: "123 Demo St (simulated)" }];
  }
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: limit }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        internationalPhoneNumber?: string;
        websiteUri?: string;
        formattedAddress?: string;
      }[];
    };
    return (json.places ?? []).slice(0, limit).map((p) => ({
      displayName: p.displayName?.text ?? q,
      phone: p.internationalPhoneNumber ? p.internationalPhoneNumber.replace(/[^\d+]/g, "") : null,
      website: p.websiteUri ?? null,
      address: p.formattedAddress ?? null,
    }));
  } catch (err) {
    console.error("searchOffices failed", err);
    return [];
  }
}

export interface PlaceRating {
  rating: number | null; // 1.0–5.0
  userRatingCount: number | null;
  phone: string | null;
  website: string | null;
  address: string | null;
}

/**
 * Look up an office's Google rating + review count (plus contact) by name/address — the quality proxy
 * for physician search ranking. Returns null when Places is off (no fabricated ratings) so ranking
 * falls back to credentials alone. The mock physician seed carries no rating, keeping tests deterministic.
 */
export async function lookupPlaceRating(officeName: string, address?: string | null): Promise<PlaceRating | null> {
  if (!enabled.googlePlaces()) return null;
  const query = [officeName, address].filter(Boolean).join(" ").trim();
  if (!query) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask":
          "places.rating,places.userRatingCount,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: {
        rating?: number;
        userRatingCount?: number;
        internationalPhoneNumber?: string;
        websiteUri?: string;
        formattedAddress?: string;
      }[];
    };
    const p = json.places?.[0];
    if (!p) return null;
    return {
      rating: typeof p.rating === "number" ? p.rating : null,
      userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      phone: p.internationalPhoneNumber ? p.internationalPhoneNumber.replace(/[^\d+]/g, "") : null,
      website: p.websiteUri ?? null,
      address: p.formattedAddress ?? null,
    };
  } catch (err) {
    console.error("lookupPlaceRating failed", err);
    return null;
  }
}

/**
 * Find an office's website (for the web channel) by name via Google Places.
 * Returns null when not configured or not found.
 */
export async function lookupWebsite(officeName: string): Promise<string | null> {
  if (!enabled.googlePlaces()) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": "places.websiteUri,places.displayName",
      },
      body: JSON.stringify({ textQuery: officeName }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { places?: { websiteUri?: string }[] };
    return json.places?.[0]?.websiteUri ?? null;
  } catch (err) {
    console.error("lookupWebsite failed", err);
    return null;
  }
}
