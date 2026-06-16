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
