// Detail view data for a single physician/clinic: the review snippets behind the rating, and a best-effort
// "insurance accepted" read scraped from the provider's own website (homepage + an insurance/billing
// subpage when linked) and extracted by the LLM. The extracted carriers are matched against the member's
// insurance to upgrade the network badge from "unconfirmed" to a real in/out-of-network call.

import { runTool } from "./llm-tool.js";
import { lookupPlaceReviews, lookupPlaceRating } from "./lookup.js";
import { memberCarriers, memberCarrierNames, networkStatus, normalizeCarrier, type NetworkStatus } from "./physician-search.js";

export interface PhysicianDetail {
  reviews: string[];
  acceptedCarriers: string[]; // human-readable carrier names found on the site
  networkStatus: NetworkStatus;
  insuranceNote: string | null;
  insuranceSourceUrl: string | null;
  /** The member's own carriers on file (so the UI can always say "your plan: Aetna"). */
  memberInsurance: string[];
}

// Common URL paths where practices publish accepted insurance, tried in addition to scanning homepage links.
const INSURANCE_PATHS = [
  "/insurance",
  "/insurances",
  "/accepted-insurance",
  "/insurance-accepted",
  "/billing",
  "/billing-insurance",
  "/financial-information",
  "/patients",
  "/for-patients",
  "/new-patients",
  "/patient-information",
];

export interface PhysicianDetailInput {
  subjectUserId: string;
  name: string;
  address?: string;
  website?: string;
}

/** Strip a web page down to readable text for the LLM (no scripts/styles/markup), bounded in size. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

/** Fetch a URL's text content, or null on any failure/timeout. Retries http→https once. */
async function fetchText(url: string, allowHttpsRetry = true): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // A real browser UA — some sites block obvious bots.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return html.slice(0, 400_000); // cap raw HTML before stripping
  } catch {
    if (allowHttpsRetry && url.startsWith("http://")) return fetchText(url.replace(/^http:/, "https:"), false);
    return null;
  }
}

/** Find a likely "insurance / billing / payment" subpage link in the homepage HTML. */
function findInsuranceLink(html: string, baseUrl: string): string | null {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = `${href} ${m[2].replace(/<[^>]+>/g, " ")}`.toLowerCase();
    if (/insurance|billing|payment|coverage|accepted|patients|new-patient/.test(label)) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        /* skip bad href */
      }
    }
  }
  return null;
}

const INSURANCE_TOOL = {
  name: "report_accepted_insurance",
  description:
    "Report the health insurance carriers/plans a medical practice states it ACCEPTS, read from its " +
    "website text. Only include carriers explicitly described as accepted or in-network. If the page " +
    "doesn't list any, return an empty list — never guess.",
  input_schema: {
    type: "object",
    properties: {
      carriers: {
        type: "array",
        items: { type: "string" },
        description: "Insurance carrier/plan names stated as accepted, e.g. ['Aetna', 'Blue Cross Blue Shield', 'Medicare'].",
      },
      note: {
        type: "string",
        description: "A short note, e.g. 'Lists 12 carriers including most major PPOs' or 'No insurance info found on the page'.",
      },
    },
    required: ["carriers"],
  } as Record<string, unknown>,
};

/** Scrape a provider website for accepted insurance carriers (best-effort). */
async function scrapeInsurance(website: string): Promise<{ carriers: string[]; note: string | null; sourceUrl: string | null }> {
  const homeHtml = await fetchText(website);
  if (!homeHtml) return { carriers: [], note: "Couldn't reach the website.", sourceUrl: null };

  let origin = website;
  try {
    origin = new URL(website).origin;
  } catch {
    /* keep website as-is */
  }

  // Candidate insurance pages: the one linked from the homepage, plus a few common paths. Fetch up to 3.
  const candidates: string[] = [];
  const linked = findInsuranceLink(homeHtml, website);
  if (linked && linked !== website) candidates.push(linked);
  for (const path of INSURANCE_PATHS) {
    const u = `${origin}${path}`;
    if (!candidates.includes(u)) candidates.push(u);
  }
  const subPages = (await Promise.all(candidates.slice(0, 6).map((u) => fetchText(u).then((h) => (h ? { u, h } : null)))))
    .filter((x): x is { u: string; h: string } => x !== null)
    .slice(0, 3);

  const sourceUrl = subPages[0]?.u ?? website;
  const text = [stripHtml(homeHtml), ...subPages.map((s) => stripHtml(s.h))].filter(Boolean).join("\n\n").slice(0, 18000);
  if (!text) return { carriers: [], note: "No readable content on the website.", sourceUrl: website };

  const extracted = await runTool<{ carriers?: string[]; note?: string }>({
    system: "You read a medical practice's website text and report only the insurance it explicitly accepts.",
    content: `Website text:\n${text}`,
    tool: INSURANCE_TOOL,
    maxTokens: 500,
  });
  if (!extracted) return { carriers: [], note: "Insurance couldn't be read automatically.", sourceUrl };

  const carriers = Array.from(new Set((extracted.carriers ?? []).map((c) => c.trim()).filter(Boolean)));
  return { carriers, note: extracted.note?.trim() || null, sourceUrl };
}

/** Reviews + scraped-insurance network status for one provider's detail view. */
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
