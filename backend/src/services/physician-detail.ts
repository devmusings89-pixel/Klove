// Detail view data for a single physician/clinic: the review snippets behind the rating, and a best-effort
// "insurance accepted" read scraped from the provider's own website (homepage + an insurance/billing
// subpage when linked) and extracted by the LLM. The extracted carriers are matched against the member's
// insurance to upgrade the network badge from "unconfirmed" to a real in/out-of-network call.

import { runTool } from "./llm-tool.js";
import { lookupPlaceReviews } from "./lookup.js";
import { memberCarriers, networkStatus, normalizeCarrier, type NetworkStatus } from "./physician-search.js";

export interface PhysicianDetail {
  reviews: string[];
  acceptedCarriers: string[]; // human-readable carrier names found on the site
  networkStatus: NetworkStatus;
  insuranceNote: string | null;
  insuranceSourceUrl: string | null;
}

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

/** Fetch a URL's text content, or null on any failure/timeout. */
async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KloveBot/1.0; +https://klove.app)" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return html.slice(0, 400_000); // cap raw HTML before stripping
  } catch {
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

  // Prefer a dedicated insurance/billing page when the homepage links to one.
  const subUrl = findInsuranceLink(homeHtml, website);
  const subHtml = subUrl && subUrl !== website ? await fetchText(subUrl) : null;
  const text = [stripHtml(homeHtml), subHtml ? stripHtml(subHtml) : ""].filter(Boolean).join("\n\n").slice(0, 16000);
  if (!text) return { carriers: [], note: "No readable content on the website.", sourceUrl: website };

  const extracted = await runTool<{ carriers?: string[]; note?: string }>({
    system: "You read a medical practice's website text and report only the insurance it explicitly accepts.",
    content: `Website text:\n${text}`,
    tool: INSURANCE_TOOL,
    maxTokens: 400,
  });
  if (!extracted) return { carriers: [], note: "Insurance couldn't be read automatically.", sourceUrl: subUrl ?? website };

  const carriers = Array.from(new Set((extracted.carriers ?? []).map((c) => c.trim()).filter(Boolean)));
  return { carriers, note: extracted.note?.trim() || null, sourceUrl: subUrl ?? website };
}

/** Reviews + scraped-insurance network status for one provider's detail view. */
export async function physicianDetails(input: PhysicianDetailInput): Promise<PhysicianDetail> {
  const [reviews, insurance, member] = await Promise.all([
    lookupPlaceReviews(input.name, input.address ?? null, 5),
    input.website ? scrapeInsurance(input.website) : Promise.resolve({ carriers: [] as string[], note: null, sourceUrl: null }),
    memberCarriers(input.subjectUserId),
  ]);

  const normalized = Array.from(new Set(insurance.carriers.map(normalizeCarrier).filter((c): c is string => Boolean(c))));
  return {
    reviews,
    acceptedCarriers: insurance.carriers,
    networkStatus: networkStatus(normalized, member),
    insuranceNote: insurance.note,
    insuranceSourceUrl: insurance.sourceUrl,
  };
}
