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
  const memberships = await prisma.householdMembership.findMany({
    where: { householdId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });

  const out: MemberView[] = [];
  for (const m of memberships) {
    const self = m.userId === operatorUserId;
    let consent = "self";
    if (!self) {
      const grant = await prisma.consentGrant.findFirst({
        where: { granteeUserId: operatorUserId, subjectUserId: m.userId },
        orderBy: { createdAt: "desc" },
      });
      consent = grant?.status ?? "none";
    }
    const needsYou = await prisma.task.count({
      where: { householdId, subjectUserId: m.userId, state: "needs_you" },
    });
    out.push({
      userId: m.userId,
      displayName: m.user.displayName ?? (self ? "Me" : null),
      relationship: m.relationship,
      memberType: m.memberType,
      isOperator: m.isOperator,
      managed: m.user.managed,
      consent,
      needsYou,
    });
  }
  return out;
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
