// Auth for health (PHI) routes. When Supabase Auth is configured, verifies the Supabase JWT
// (HS256, signed with the project JWT secret) and resolves the local User by authUserId/email.
// In mock mode it falls back to an `x-user-email` header so the pipeline is exercisable in dev.
// Every health query must still scope by req.user.id — this guard establishes who that is.

import { createHmac, timingSafeEqual } from "node:crypto";
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
}

/**
 * Verify an HS256 Supabase JWT and return its claims, or null if invalid.
 * Validates: signature (HMAC-SHA256), header alg == HS256, expiry, and — when configured —
 * the issuer and audience claims against the Supabase project.
 */
function verifySupabaseJwt(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  // Pin the algorithm: reject anything but HS256 (defends against alg-confusion / "none").
  let header: JwtHeader;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as JwtHeader;
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expected = createHmac("sha256", config.supabase.jwtSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = Buffer.from(sigB64, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as JwtClaims;
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;

    // Issuer/audience binding to the Supabase project (skip only when not configured).
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

/** Resolve (and upsert) the local User for an authenticated request. Throws on failure. */
async function resolveUser(req: FastifyRequest): Promise<{ id: string; email: string }> {
  if (enabled.supabaseAuth()) {
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = token ? verifySupabaseJwt(token) : null;
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
  const caller = req.user;
  if (!caller) throw new ConsentError("unauthenticated");
  const target = subjectUserId ?? caller.id;
  const need = opts.need ?? "view";

  // Self-access is always full; no grant required.
  if (target === caller.id) {
    return { userId: target, accessLevel: "operate", self: true };
  }

  const grant = await prisma.consentGrant.findFirst({
    where: { granteeUserId: caller.id, subjectUserId: target, status: "active" },
  });
  if (!grant) throw new ConsentError("no active consent for this member");

  const level = grant.accessLevel as AccessLevel;
  if (LEVEL_RANK[level] < LEVEL_RANK[need]) throw new ConsentError("insufficient access level");
  if (!categoriesCover(grant.categories, opts.category)) throw new ConsentError("category not consented");

  return { userId: target, accessLevel: level, self: false };
}

/** Type guard so routes can map a thrown ConsentError to a 403 reply. */
export function isConsentError(err: unknown): err is ConsentError {
  return err instanceof ConsentError;
}
