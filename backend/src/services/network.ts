// Insurance-carrier normalization + in-network status. Kept in its own module (no other service deps)
// so both the physician search and the insurance scraper can use it without an import cycle.

export type NetworkStatus = "in_network" | "out_of_network" | "unconfirmed" | "unknown";

/** Collapse carrier names/aliases to a normalized key so "Anthem BCBS" and "Blue Cross" match. */
export function normalizeCarrier(name: string | null | undefined): string | null {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return null;
  if (/blue cross|blue shield|bcbs|anthem|carefirst|premera|regence|lifewise/.test(n)) return "bcbs";
  if (/unitedhealth|united health|\buhc\b|\bunited\b|optum/.test(n)) return "unitedhealth";
  if (/aetna/.test(n)) return "aetna";
  if (/cigna/.test(n)) return "cigna";
  if (/humana/.test(n)) return "humana";
  if (/kaiser/.test(n)) return "kaiser";
  if (/medicare/.test(n)) return "medicare";
  if (/medicaid|apple health/.test(n)) return "medicaid";
  // Unknown carrier: keep a compacted token so exact-string matches still work.
  return n.replace(/[^a-z0-9]+/g, "");
}

/** Decide in-network status from a provider's accepted carriers vs the member's carriers. */
export function networkStatus(accepted: string[], member: string[]): NetworkStatus {
  if (member.length === 0) return "unknown"; // no insurance on file to check against
  if (accepted.length === 0) return "unconfirmed"; // we don't know what this provider takes
  return accepted.some((a) => member.includes(a)) ? "in_network" : "out_of_network";
}
