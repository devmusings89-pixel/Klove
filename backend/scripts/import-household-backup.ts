// Imports the household backed up from the old snake_case schema (snakecase-backup.json) into the
// Prisma models, AND serves as a live-connection check for Supabase (it reads back what it wrote).
//
// Run AFTER putting the real DB password in .env (DATABASE_URL/DIRECT_URL):
//   npm run import-household
//
// Mapping (faithful where the backup has data; INFERRED parts are flagged below):
//   households            → Household (operator = the person whose relationship is "self")
//   persons               → User (managed=true for non-self members) + HouseholdMembership
//   [INFERRED] ConsentGrant: the operator gets "operate" access over each managed member. The backup
//     had no consent rows; this is implied by the household model. Comment out the CONSENT block if
//     you'd rather create grants explicitly later.
// Idempotent: upserts by the original UUIDs, so re-running is safe.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prisma } from "../src/db.js";

interface Person {
  id: string;
  household_id: string;
  name: string;
  relationship: string; // self | parent | child | spouse | adult
  created_at: string;
}
interface HouseholdRow { id: string; name: string; created_at: string }

const MEMBER_TYPE: Record<string, string> = {
  self: "self",
  child: "minor",
  parent: "aging_parent",
  spouse: "consenting_adult",
  adult: "consenting_adult",
};

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const backup = JSON.parse(readFileSync(join(here, "..", "snakecase-backup.json"), "utf8")) as {
    persons: Person[];
    households: HouseholdRow[];
  };

  const operator = backup.persons.find((p) => p.relationship === "self");
  if (!operator) throw new Error("no person with relationship 'self' — can't determine the operator");

  // 1) Users — operator first (managed members reference it via managedByUserId).
  const ordered = [operator, ...backup.persons.filter((p) => p.id !== operator.id)];
  for (const p of ordered) {
    const isOperator = p.id === operator.id;
    await prisma.user.upsert({
      where: { id: p.id },
      update: { displayName: p.name },
      create: {
        id: p.id,
        displayName: p.name,
        managed: !isOperator,
        managedByUserId: isOperator ? null : operator.id,
        createdAt: new Date(p.created_at),
      },
    });
  }

  // 2) Households (operator now exists).
  for (const h of backup.households) {
    await prisma.household.upsert({
      where: { id: h.id },
      update: { name: h.name },
      create: { id: h.id, name: h.name, operatorUserId: operator.id, createdAt: new Date(h.created_at) },
    });
  }

  // 3) Memberships.
  for (const p of backup.persons) {
    await prisma.householdMembership.upsert({
      where: { householdId_userId: { householdId: p.household_id, userId: p.id } },
      update: {},
      create: {
        householdId: p.household_id,
        userId: p.id,
        relationship: p.relationship,
        memberType: MEMBER_TYPE[p.relationship] ?? "consenting_adult",
        isOperator: p.id === operator.id,
        createdAt: new Date(p.created_at),
      },
    });
  }

  // 4) [INFERRED] Consent grants: operator → each managed member. Remove this block to skip.
  for (const p of backup.persons) {
    if (p.id === operator.id) continue;
    await prisma.consentGrant.upsert({
      where: { granteeUserId_subjectUserId: { granteeUserId: operator.id, subjectUserId: p.id } },
      update: {},
      create: {
        granteeUserId: operator.id,
        subjectUserId: p.id,
        householdId: p.household_id,
        accessLevel: "operate",
        categories: JSON.stringify(["all"]),
        status: "active",
        createdAt: new Date(p.created_at),
      },
    });
  }

  // 5) Verification read-back (also confirms the live Supabase connection works).
  const [users, households, memberships, grants] = await Promise.all([
    prisma.user.count(),
    prisma.household.count(),
    prisma.householdMembership.count(),
    prisma.consentGrant.count(),
  ]);
  const members = await prisma.householdMembership.findMany({
    include: { user: { select: { displayName: true } } },
    orderBy: { isOperator: "desc" },
  });
  console.log("✅ live Supabase connection OK — imported & read back:");
  console.log(`   users=${users} households=${households} memberships=${memberships} consentGrants=${grants}`);
  for (const m of members) {
    console.log(`   • ${m.user.displayName} — ${m.relationship}/${m.memberType}${m.isOperator ? " (operator)" : ""}`);
  }
}

main()
  .catch((err) => {
    console.error("import failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
