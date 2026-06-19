// Best-effort "accepted insurance" reader: scrape a provider's website (homepage + an insurance/billing
// subpage, and — in full mode — common insurance URL paths) and LLM-extract the carriers it accepts.
// `fast` mode (used in the search list, many providers at once) skips the common-path probing to stay quick.

import { runTool } from "./llm-tool.js";
import { normalizeCarrier, networkStatus, type NetworkStatus } from "./network.js";

// Common URL paths where practices publish accepted insurance (full mode only).
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
async function fetchText(url: string, timeoutMs: number, allowHttpsRetry = true): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.text()).slice(0, 400_000);
  } catch {
    if (allowHttpsRetry && url.startsWith("http://")) return fetchText(url.replace(/^http:/, "https:"), timeoutMs, false);
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
      note: { type: "string", description: "A short note, e.g. 'Lists 8 carriers' or 'No insurance info found on the page'." },
    },
    required: ["carriers"],
  } as Record<string, unknown>,
};

export interface ScrapedInsurance {
  carriers: string[];
  note: string | null;
  sourceUrl: string | null;
}

/** Scrape a provider website for accepted insurance carriers. `fast` skips common-path probing. */
export async function scrapeInsurance(website: string, opts: { fast?: boolean } = {}): Promise<ScrapedInsurance> {
  const timeout = opts.fast ? 3500 : 6000;
  const homeHtml = await fetchText(website, timeout);
  if (!homeHtml) return { carriers: [], note: "Couldn't reach the website.", sourceUrl: null };

  let origin = website;
  try {
    origin = new URL(website).origin;
  } catch {
    /* keep as-is */
  }

  const candidates: string[] = [];
  const linked = findInsuranceLink(homeHtml, website);
  if (linked && linked !== website) candidates.push(linked);
  if (!opts.fast) {
    for (const path of INSURANCE_PATHS) {
      const u = `${origin}${path}`;
      if (!candidates.includes(u)) candidates.push(u);
    }
  }
  const maxPages = opts.fast ? 1 : 3;
  const subPages = (
    await Promise.all(candidates.slice(0, opts.fast ? 1 : 6).map((u) => fetchText(u, timeout).then((h) => (h ? { u, h } : null))))
  )
    .filter((x): x is { u: string; h: string } => x !== null)
    .slice(0, maxPages);

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

/** Scrape + decide network status against a member's normalized carrier keys (full, LLM-backed). */
export async function confirmNetwork(
  website: string,
  memberKeys: string[],
  opts: { fast?: boolean } = {},
): Promise<{ status: NetworkStatus; carriers: string[] }> {
  const scraped = await scrapeInsurance(website, opts);
  const normalized = Array.from(new Set(scraped.carriers.map(normalizeCarrier).filter((c): c is string => Boolean(c))));
  return { status: networkStatus(normalized, memberKeys), carriers: scraped.carriers };
}

// Text patterns to match a normalized carrier key in raw page text (for the fast, LLM-free list check).
const CARRIER_PATTERNS: Record<string, RegExp> = {
  bcbs: /blue cross|blue shield|bcbs|anthem|premera|regence|lifewise|carefirst/i,
  unitedhealth: /unitedhealth|united health|\buhc\b|optum/i,
  aetna: /aetna/i,
  cigna: /cigna/i,
  humana: /humana/i,
  kaiser: /kaiser/i,
  medicare: /medicare/i,
  medicaid: /medicaid|apple health/i,
};

/**
 * FAST, LLM-free network check for the search list: fetch the homepage + a linked insurance page and
 * string-match the member's carrier on an insurance-context page. Returns "in_network" when the carrier
 * is mentioned, otherwise "unconfirmed" — never "out_of_network" (a page not mentioning a carrier isn't
 * proof it's excluded). Cheap enough to run across many results in parallel.
 */
export async function confirmNetworkByText(website: string, memberKeys: string[]): Promise<NetworkStatus> {
  if (memberKeys.length === 0) return "unknown";
  const homeHtml = await fetchText(website, 3000);
  if (!homeHtml) return "unconfirmed";
  const linked = findInsuranceLink(homeHtml, website);
  const linkedHtml = linked && linked !== website ? await fetchText(linked, 3000) : null;
  const text = `${stripHtml(homeHtml)} ${linkedHtml ? stripHtml(linkedHtml) : ""}`.toLowerCase();
  // Only trust the match on a page that actually talks about insurance/coverage.
  if (!/insurance|in-network|in network|accepted plans|carriers|coverage/.test(text)) return "unconfirmed";
  for (const key of memberKeys) {
    const pattern = CARRIER_PATTERNS[key] ?? new RegExp(key.replace(/[^a-z0-9]+/g, ".?"), "i");
    if (pattern.test(text)) return "in_network";
  }
  return "unconfirmed";
}
