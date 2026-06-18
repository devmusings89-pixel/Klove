// Purge leftover eval/convo test users (email like "*.eval-*" / "*.convo-*" @klove.test) and all
// their data in FK-safe order. The call* deletions retry to survive a race with the running dev
// server's reconcile tick (which can write a new CallResult mid-cleanup).
//
//   npx tsx --env-file=.env scripts/cleanup-eval.ts

import { prisma } from "../src/db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function purgeSessions(ids: string[]) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: ids } } } } });
      await prisma.callTarget.deleteMany({ where: { session: { userId: { in: ids } } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500); // a reconcile tick may have written a fresh CallResult — retry
    }
  }
}

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@klove.test" }, OR: [{ email: { contains: ".eval-" } }, { email: { contains: ".convo-" } }, { email: { contains: ".mem-" } }, { email: { contains: ".e2e-" } }] },
    select: { id: true, email: true },
  });
  const ids = users.map((u) => u.id);
  console.log(`found ${ids.length} test users to purge`);
  if (!ids.length) return;

  await purgeSessions(ids);
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.agentConversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: ids } } });
  await prisma.observation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.condition.deleteMany({ where: { userId: { in: ids } } });
  await prisma.medicationStatement.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: ids } } });
  await prisma.profile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: ids } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log("purged.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
