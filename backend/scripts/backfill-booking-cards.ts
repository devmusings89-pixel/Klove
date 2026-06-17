// One-time backfill: convert existing booking tasks' free-text detail into structured bookingJson
// so they render the new structured confirmation card. Run: npx tsx --env-file=.env scripts/backfill-booking-cards.ts
import { prisma } from "../src/db.js";

const CONFIRMED = /^Confirmed for (.+?) with (.+?) · (.+)$/;
const HOLD = /^Provisional hold for (.+?)(?: with (.+?))? — not yet confirmed/;

const tasks = await prisma.task.findMany({ where: { kind: "book", bookingJson: null, detail: { not: null } } });
let updated = 0;
for (const t of tasks) {
  const d = t.detail ?? "";
  let booking: Record<string, unknown> | null = null;
  let detail = t.detail;
  let m = d.match(CONFIRMED);
  if (m) {
    booking = { when: null, whenText: m[1].trim(), provider: m[2].trim(), confirmation: m[3].trim(), verified: true };
    detail = `Confirmed with ${m[2].trim()}.`;
  } else if ((m = d.match(HOLD))) {
    booking = { when: null, whenText: m[1].trim(), provider: m[2]?.trim() ?? null, confirmation: null, verified: false };
    detail = "Provisional hold — not yet confirmed with the office.";
  }
  if (booking) {
    await prisma.task.update({ where: { id: t.id }, data: { bookingJson: JSON.stringify(booking), detail } });
    updated++;
    console.log(`  ${t.title} → ${JSON.stringify(booking)}`);
  }
}
console.log(`\n✅ backfilled ${updated}/${tasks.length} booking task(s)`);
process.exit(0);
