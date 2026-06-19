// Detail-view data for a single physician/clinic: the review snippets behind the rating, and a best-effort
// "insurance accepted" read scraped from the provider's website (see insurance.ts). The extracted carriers
// are matched against the member's insurance for a real in/out-of-network call.

import { lookupPlaceReviews, lookupPlaceRating } from "./lookup.js";
import { memberCarriers, memberCarrierNames } from "./physician-search.js";
import { normalizeCarrier, networkStatus, type NetworkStatus } from "./network.js";
import { scrapeInsurance } from "./insurance.js";

export interface PhysicianDetail {
  reviews: string[];
  acceptedCarriers: string[]; // human-readable carrier names found on the site
  networkStatus: NetworkStatus;
  insuranceNote: string | null;
  insuranceSourceUrl: string | null;
  /** The member's own carriers on file (so the UI can always say "your plan: Aetna"). */
  memberInsurance: string[];
}

export interface PhysicianDetailInput {
  subjectUserId: string;
  name: string;
  address?: string;
  website?: string;
}

/** Reviews + scraped-insurance network status for one provider's detail view (full scrape). */
export async function physicianDetails(input: PhysicianDetailInput): Promise<PhysicianDetail> {
  // NPI individuals carry no website — try to resolve one from their Google listing so we can still scrape.
  let website = input.website?.trim() || null;
  if (!website) {
    const place = await lookupPlaceRating(input.name, input.address ?? null);
    website = place?.website ?? null;
  }

  const [reviews, insurance, member, memberNames] = await Promise.all([
    lookupPlaceReviews(input.name, input.address ?? null, 5),
    website ? scrapeInsurance(website) : Promise.resolve({ carriers: [] as string[], note: "No website on file to check.", sourceUrl: null }),
    memberCarriers(input.subjectUserId),
    memberCarrierNames(input.subjectUserId),
  ]);

  const normalized = Array.from(new Set(insurance.carriers.map(normalizeCarrier).filter((c): c is string => Boolean(c))));
  return {
    reviews,
    acceptedCarriers: insurance.carriers,
    networkStatus: networkStatus(normalized, member),
    insuranceNote: insurance.note,
    insuranceSourceUrl: insurance.sourceUrl,
    memberInsurance: memberNames,
  };
}
