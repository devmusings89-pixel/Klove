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
  lat: number | null;
  lng: number | null;
}

/**
 * Look up an office's Google rating + review count + location (plus contact) by name/address — the
 * quality + distance signal for physician search. Returns null when Places is off (no fabricated data)
 * so ranking falls back to credentials alone. The mock physician seed carries no rating, keeping tests
 * deterministic. Review TEXT is fetched separately (lookupPlaceReviews) only for the few candidates we
 * hand to the recommender, to bound the higher-cost reviews field.
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
          "places.rating,places.userRatingCount,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress,places.location",
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
        location?: { latitude?: number; longitude?: number };
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
      lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
      lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
    };
  } catch (err) {
    console.error("lookupPlaceRating failed", err);
    return null;
  }
}

export interface SpecialistPlace {
  name: string;
  rating: number | null;
  userRatingCount: number | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Relevance-ranked specialist/clinic search via Google Places text search — the discovery source that
 * surfaces the actual experts for a condition (e.g. "headache medicine neurologist near Seattle"), which
 * the NPI registry's alphabetical, specialty-only listing cannot. Returns [] when Places is off.
 */
export async function searchSpecialists(query: string, limit = 8): Promise<SpecialistPlace[]> {
  if (!enabled.googlePlaces()) return [];
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.rating,places.userRatingCount,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: Math.min(limit, 20) }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        rating?: number;
        userRatingCount?: number;
        internationalPhoneNumber?: string;
        websiteUri?: string;
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      }[];
    };
    return (json.places ?? [])
      .filter((p) => p.displayName?.text)
      .slice(0, limit)
      .map((p) => ({
        name: p.displayName!.text!,
        rating: typeof p.rating === "number" ? p.rating : null,
        userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        phone: p.internationalPhoneNumber ? p.internationalPhoneNumber.replace(/[^\d+]/g, "") : null,
        website: p.websiteUri ?? null,
        address: p.formattedAddress ?? null,
        lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
        lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
      }));
  } catch (err) {
    console.error("searchSpecialists failed", err);
    return [];
  }
}

/** Geocode a free-text location ("Seattle, WA", "98101") to a center point, or null. */
export async function geocode(location: string): Promise<{ lat: number; lng: number } | null> {
  if (!enabled.googlePlaces()) return null;
  const q = location.trim();
  if (!q) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": "places.location",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 1 }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { places?: { location?: { latitude?: number; longitude?: number } }[] };
    const loc = json.places?.[0]?.location;
    if (typeof loc?.latitude !== "number" || typeof loc?.longitude !== "number") return null;
    return { lat: loc.latitude, lng: loc.longitude };
  } catch (err) {
    console.error("geocode failed", err);
    return null;
  }
}

/** Up to `limit` review snippets (text) for an office — fed to the recommender to match a stated need. */
export async function lookupPlaceReviews(officeName: string, address?: string | null, limit = 4): Promise<string[]> {
  if (!enabled.googlePlaces()) return [];
  const query = [officeName, address].filter(Boolean).join(" ").trim();
  if (!query) return [];
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": "places.reviews",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      places?: { reviews?: { text?: { text?: string }; originalText?: { text?: string }; rating?: number }[] }[];
    };
    const reviews = json.places?.[0]?.reviews ?? [];
    return reviews
      .map((r) => (r.text?.text ?? r.originalText?.text ?? "").trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch (err) {
    console.error("lookupPlaceReviews failed", err);
    return [];
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
