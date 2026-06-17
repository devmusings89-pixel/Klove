// Household helpers (Klove). The operator's household is the container every member-scoped route
// resolves against. Members are Users (see schema header); managed members are login-less Users the
// operator owns on their behalf, with an auto active ConsentGrant.

import { prisma } from "../db.js";
import { fromJson } from "./json.js";

/** Ensure the user operates a household (with a self-membership). Returns its id. Idempotent. */
export async function ensureHousehold(operatorUserId: string, name?: string): Promise<string> {
  const existing = await prisma.household.findUnique({ where: { operatorUserId } });
  if (existing) {
    if (name && name !== existing.name) {
      await prisma.household.update({ where: { id: existing.id }, data: { name } });
    }
    return existing.id;
  }
  const hh = await prisma.household.create({
    data: {
      operatorUserId,
      name,
      memberships: {
        create: { userId: operatorUserId, relationship: "self", memberType: "self", isOperator: true },
      },
    },
  });
  return hh.id;
}

export interface MemberView {
  userId: string;
  displayName: string | null;
  relationship: string;
  memberType: string;
  isOperator: boolean;
  managed: boolean;
  /** Consent state of the operator over this member: self | active | pending | revoked. */
  consent: string;
  /** Count of open "Needs You" tasks for this member (drives the Family overview status dot). */
  needsYou: number;
}

/** All members of the operator's household, shaped for the Family tab. */
export async function listMembers(operatorUserId: string): Promise<MemberView[]> {
  const householdId = await ensureHousehold(operatorUserId);
  // Fetch the roster, every grant, and per-member task counts in 3 queries (not N+1 per member) —
  // remote-Postgres round-trips dominate latency, so query count matters more than row count.
  const [memberships, grants, taskGroups, selfProfile] = await Promise.all([
    prisma.householdMembership.findMany({ where: { householdId }, include: { user: true }, orderBy: { createdAt: "asc" } }),
    prisma.consentGrant.findMany({ where: { granteeUserId: operatorUserId }, orderBy: { createdAt: "desc" } }),
    prisma.task.groupBy({ by: ["subjectUserId"], where: { householdId, state: "needs_you" }, _count: { _all: true } }),
    // The operator's own name comes from their profile when they never set a User.displayName — so
    // the self row reads as their name, not the bare placeholder "Me".
    prisma.profile.findFirst({ where: { userId: operatorUserId }, orderBy: { isPrimary: "desc" }, select: { fullName: true } }),
  ]);
  const selfName = selfProfile?.fullName?.trim() || null;

  // Map subject → latest grant status (grants are newest-first, so the first wins).
  const consentBySubject = new Map<string, string>();
  for (const g of grants) if (!consentBySubject.has(g.subjectUserId)) consentBySubject.set(g.subjectUserId, g.status);
  const needsYouBySubject = new Map<string, number>();
  for (const t of taskGroups) needsYouBySubject.set(t.subjectUserId, t._count._all);

  return memberships.map((m) => {
    const self = m.userId === operatorUserId;
    return {
      userId: m.userId,
      displayName: m.user.displayName ?? (self ? selfName ?? "Me" : null),
      relationship: m.relationship,
      memberType: m.memberType,
      isOperator: m.isOperator,
      managed: m.user.managed,
      consent: self ? "self" : consentBySubject.get(m.userId) ?? "none",
      needsYou: needsYouBySubject.get(m.userId) ?? 0,
    };
  });
}

/** Parse a stored consent categories JSON array (defensive). */
export function parseCategories(json: string): string[] {
  return fromJson<string[]>(json, ["all"]);
}

/**
 * The members the operator can act on (self + active consent), with display names — the scope for
 * household-wide aggregations like the Today briefing and the Actions log.
 */
export async function accessibleSubjects(operatorUserId: string): Promise<{ id: string; name: string }[]> {
  const members = await listMembers(operatorUserId);
  return members
    .filter((m) => m.consent === "self" || m.consent === "active")
    .map((m) => ({ id: m.userId, name: m.displayName ?? "Member" }));
}
