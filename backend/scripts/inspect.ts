import { prisma } from "../src/db.js";

const sessions = await prisma.session.findMany({
  orderBy: { createdAt: "desc" },
  take: 4,
  include: { targets: { include: { results: { orderBy: { createdAt: "asc" } } } }, user: true },
});
for (const s of sessions) {
  console.log(`\nsession ${s.id} | status=${s.status} | email=${s.user.email} | ${s.createdAt.toISOString()}`);
  for (const t of s.targets) {
    const last = t.results.at(-1);
    console.log(
      `   target "${t.officeName}" | phone=${t.phoneNumber ?? "(none)"} | status=${t.status} | vapiCallId=${t.vapiCallId ?? "(none)"} | phases=[${t.results.map((r) => r.phase).join(",")}] | endedReason=${last?.endedReason ?? "-"}`,
    );
  }
}
process.exit(0);
