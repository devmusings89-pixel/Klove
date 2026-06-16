// Phase-0 migration backfill (Klove household model).
//
// The household/consent graph is additive over the existing single-user schema: clinical data is
// already correctly parented on User, so nothing is re-parented here. This script only ensures
// every existing User becomes the Operator of their own Household with a self-membership, so the
// new household-scoped routes have something to resolve. Idempotent — safe to re-run.
//
// Usage: npm run backfill-households
import { prisma } from "../src/db.js";

export async function backfillHouseholds(): Promise<{ created: number; skipped: number }> {
  const users = await prisma.user.findMany({
    // Managed members never operate a household; the operator who created them already has one.
    where: { managed: false },
    select: { id: true },
  });

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    const existing = await prisma.household.findUnique({ where: { operatorUserId: user.id } });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.household.create({
      data: {
        operatorUserId: user.id,
        memberships: {
          create: {
            userId: user.id,
            relationship: "self",
            memberType: "self",
            isOperator: true,
          },
        },
      },
    });
    created++;
  }

  return { created, skipped };
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillHouseholds()
    .then(({ created, skipped }) => {
      console.log(`Backfill complete: ${created} household(s) created, ${skipped} already present.`);
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
