// Auth for health (PHI) routes. When Supabase Auth is configured, verifies the Supabase JWT
// (HS256, signed with the project JWT secret) and resolves the local User by authUserId/email.
// In mock mode it falls back to an `x-user-email` header so the pipeline is exercisable in dev.
// Every health query must still scope by req.user.id — this guard establishes who that is.

import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config, enabled, isProduction } from "../config.js";
import { prisma } from "../db.js";

interface JwtClaims {
  sub?: string; // Supabase auth uid
  email?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

/** Validate the registered claims (expiry, issuer, audience) and return them, or null. */
function validateClaims(payloadB64: string): JwtClaims | null {
  try {
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as JwtClaims;
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    const expectedIss = config.supabase.jwtIssuer;
    if (expectedIss && claims.iss !== expectedIss) return null;
    const expectedAud = config.supabase.jwtAudience;
    if (expectedAud) {
      const audOk = Array.isArray(claims.aud) ? claims.aud.includes(expectedAud) : claims.aud === expectedAud;
      if (!audOk) return null;
    }
    return claims;
  } catch {
    return null;
  }
}

// JWKS cache for Supabase's asymmetric (ES256/RS256) signing keys.
interface Jwk {
  kid?: string;
  [k: string]: unknown;
}
let jwksCache: { keys: Jwk[]; at: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  if (!config.supabase.url) return [];
  const res = await fetch(`${config.supabase.url}/auth/v1/.well-known/jwks.json`, {
    headers: config.supabase.publishableKey ? { apikey: config.supabase.publishableKey } : {},
  });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const json = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: json.keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

/** Verify an asymmetric (ES256/RS256) JWT against the project JWKS, then validate its claims. */
async function verifyAsymmetric(headerB64: string, payloadB64: string, sigB64: string, header: JwtHeader): Promise<JwtClaims | null> {
  let keys = await getJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getJwks(true); // signing key may have rotated — refresh once
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  let ok = false;
  try {
    const pub = createPublicKey({ key: jwk as Record<string, unknown>, format: "jwk" });
    const data = Buffer.from(`${headerB64}.${payloadB64}`);
    const sig = Buffer.from(sigB64, "base64url");
    // ES256 signatures are JOSE-encoded (r||s); RS256 are PKCS#1 v1.5.
    ok = header.alg === "ES256"
      ? cryptoVerify("sha256", data, { key: pub, dsaEncoding: "ieee-p1363" }, sig)
      : cryptoVerify("sha256", data, pub, sig);
  } catch {
    return null;
  }
  return ok ? validateClaims(payloadB64) : null;
}

/**
 * Verify a Supabase JWT and return its claims, or null if invalid. Supports the current asymmetric
 * signing keys (ES256/RS256, verified via the project JWKS) and the legacy symmetric HS256 secret.
 * Pins the algorithm to defend against alg-confusion / "none".
 */
async function verifySupabaseJwt(token: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: JwtHeader;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as JwtHeader;
  } catch {
    return null;
  }

  if (header.alg === "ES256" || header.alg === "RS256") {
    try {
      return await verifyAsymmetric(headerB64, payloadB64, sigB64, header);
    } catch (err) {
      console.error("jwks verify failed:", (err as Error).message);
      return null;
    }
  }
  if (header.alg === "HS256") {
    if (!config.supabase.jwtSecret) return null;
    const expected = createHmac("sha256", config.supabase.jwtSecret).update(`${headerB64}.${payloadB64}`).digest();
    const actual = Buffer.from(sigB64, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return validateClaims(payloadB64);
  }
  return null;
}

/** Resolve (and upsert) the local User for an authenticated request. Throws on failure. */
async function resolveUser(req: FastifyRequest): Promise<{ id: string; email: string }> {
  if (enabled.supabaseAuth()) {
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = token ? await verifySupabaseJwt(token) : null;
    if (!claims?.sub || !claims.email) throw new Error("unauthorized");
    const user = await prisma.user.upsert({
      where: { authUserId: claims.sub },
      create: { authUserId: claims.sub, email: claims.email },
      update: { email: claims.email },
    });
    return { id: user.id, email: claims.email };
  }

  // Header-trust path is DEV ONLY. In production we never accept x-user-email — a deployment
  // without SUPABASE_JWT_SECRET must refuse requests rather than impersonate dev@klove.app.
  if (isProduction) throw new Error("auth_not_configured");

  // Mock mode: identify by header (mirrors the email-based upsert used by the sessions route).
  const email = (req.headers["x-user-email"] as string) || "dev@klove.app";
  const user = await prisma.user.upsert({ where: { email }, create: { email }, update: {} });
  return { id: user.id, email };
}

/** Fastify preHandler: attach req.user or 401. Register on all health routes. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    req.user = await resolveUser(req);
  } catch {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

// ---- Per-member consent enforcement (Klove household model) ----
//
// Clinical data is parented on User. A logged-in user always has full access to their OWN data;
// to act on ANOTHER household member they must hold an active ConsentGrant whose accessLevel and
// categories permit the operation. resolveSubject is the single chokepoint every household-scoped
// route runs after requireUser.

export type AccessLevel = "view" | "manage" | "operate";
const LEVEL_RANK: Record<AccessLevel, number> = { view: 1, manage: 2, operate: 3 };

/** A thrown ConsentError maps to a 403 (vs requireUser's 401). */
export class ConsentError extends Error {
  statusCode = 403;
  constructor(message = "forbidden") {
    super(message);
  }
}

export interface SubjectContext {
  /** The member whose data the request operates on. */
  userId: string;
  /** Effective access level the caller has over the subject. */
  accessLevel: AccessLevel;
  /** True when the subject is the caller themselves (full access, no grant needed). */
  self: boolean;
}

function categoriesCover(categoriesJson: string, category?: string): boolean {
  if (!category) return true;
  let cats: string[];
  try {
    cats = JSON.parse(categoriesJson) as string[];
  } catch {
    cats = [];
  }
  return cats.includes("all") || cats.includes(category);
}

/**
 * Resolve the subject member for a caller (no FastifyRequest) and assert the caller may act on them.
 * This is the single consent implementation; resolveSubject() is a thin request-wrapper over it. Use
 * this from non-HTTP callers (e.g. the WhatsApp concierge agent) so they enforce the SAME consent
 * rules as the REST routes and can never become a consent bypass.
 *
 * @param callerUserId   the authenticated actor (operator)
 * @param subjectUserId  target member; defaults to the caller themselves (self)
 * @param opts.need      minimum access level required (default "view")
 * @param opts.category  consent category the operation touches (e.g. "records" | "appointments")
 */
export async function resolveSubjectFor(
  callerUserId: string,
  subjectUserId?: string,
  opts: { need?: AccessLevel; category?: string } = {},
): Promise<SubjectContext> {
  if (!callerUserId) throw new ConsentError("unauthenticated");
  const target = subjectUserId ?? callerUserId;
  const need = opts.need ?? "view";

  // Self-access is always full; no grant required.
  if (target === callerUserId) {
    return { userId: target, accessLevel: "operate", self: true };
  }

  const grant = await prisma.consentGrant.findFirst({
    where: { granteeUserId: callerUserId, subjectUserId: target, status: "active" },
  });
  if (!grant) throw new ConsentError("no active consent for this member");

  const level = grant.accessLevel as AccessLevel;
  if (LEVEL_RANK[level] < LEVEL_RANK[need]) throw new ConsentError("insufficient access level");
  if (!categoriesCover(grant.categories, opts.category)) throw new ConsentError("category not consented");

  return { userId: target, accessLevel: level, self: false };
}

/**
 * Resolve the subject member for a household-scoped request and assert the caller may act on them.
 * Defaults the subject to the caller themselves. Throws ConsentError (403) when not permitted.
 *
 * @param subjectUserId  target member; defaults to req.user.id (self)
 * @param opts.need      minimum access level required (default "view")
 * @param opts.category  consent category the operation touches (e.g. "records" | "appointments")
 */
export async function resolveSubject(
  req: FastifyRequest,
  subjectUserId?: string,
  opts: { need?: AccessLevel; category?: string } = {},
): Promise<SubjectContext> {
  if (!req.user) throw new ConsentError("unauthenticated");
  return resolveSubjectFor(req.user.id, subjectUserId, opts);
}

/** Type guard so routes can map a thrown ConsentError to a 403 reply. */
export function isConsentError(err: unknown): err is ConsentError {
  return err instanceof ConsentError;
}
