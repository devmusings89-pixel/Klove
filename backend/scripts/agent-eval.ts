// Agent eval harness. Seeds a realistic member, runs representative queries through the WhatsApp
// concierge agent across all three workflows (booking / healthqa / briefing), and prints the routing
// decision + reply for each so we can judge quality and iterate on prompts. Read-only on bookings:
// it only ever PROPOSES (never sends "yes"), so no live booking/Vapi call is triggered.
//
//   npx tsx --env-file=.env scripts/agent-eval.ts

import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { classify, handleInboundMessage } from "../src/services/agent.js";
import { llmAvailable } from "../src/services/llm-tool.js";

const SUFFIX = `eval-${process.pid}-${Date.now()}`;
const userIds: string[] = [];

async function seedMember() {
  const op = await prisma.user.create({
    data: { email: `alex.${SUFFIX}@klove.test`, displayName: "Alex", whatsappPhone: `+1206000${String(Date.now()).slice(-4)}`, whatsappVerified: true, dob: new Date("1968-04-12") },
  });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  await prisma.profile.create({ data: { userId: op.id, fullName: "Alex Rivera", isPrimary: true, address: "Seattle, WA" } });

  await prisma.condition.createMany({
    data: [
      { userId: op.id, sourceType: "seed", display: "Type 2 diabetes mellitus", clinicalStatus: "active" },
      { userId: op.id, sourceType: "seed", display: "Essential hypertension", clinicalStatus: "active" },
    ],
  });
  await prisma.medicationStatement.createMany({
    data: [
      { userId: op.id, sourceType: "seed", display: "Metformin 500mg", status: "active", dosage: "500mg twice daily" },
      { userId: op.id, sourceType: "seed", display: "Lisinopril 10mg", status: "active", dosage: "10mg once daily" },
    ],
  });
  await prisma.observation.createMany({
    data: [
      { userId: op.id, sourceType: "seed", display: "Hemoglobin A1c", valueNum: 7.8, unit: "%", abnormalFlag: "H", analyteId: "a1c", canonicalValue: 7.8, canonicalUnit: "%", effectiveAt: new Date("2026-05-20") },
      { userId: op.id, sourceType: "seed", display: "Hemoglobin A1c", valueNum: 8.4, unit: "%", abnormalFlag: "H", analyteId: "a1c", canonicalValue: 8.4, canonicalUnit: "%", effectiveAt: new Date("2026-01-15") },
      { userId: op.id, sourceType: "seed", display: "LDL Cholesterol", valueNum: 145, unit: "mg/dL", abnormalFlag: "H", analyteId: "ldl", canonicalValue: 145, canonicalUnit: "mg/dL", effectiveAt: new Date("2026-05-20") },
    ],
  });
  await prisma.appointment.create({
    data: { userId: op.id, sourceType: "seed", title: "Cardiology follow-up", provider: "Dr. Smith", status: "scheduled", verified: true, startsAt: new Date(Date.now() + 5 * 86_400_000) },
  });
  await prisma.task.create({
    data: { subjectUserId: op.id, householdId, title: "Review A1c result", detail: "A1c 7.8% — discuss with provider.", state: "needs_you", kind: "follow_up" },
  });
  return { id: op.id, householdId };
}

async function cleanup() {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  // The running dev server's tick may have auto-generated reminders for the seeded appointment.
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.observation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.condition.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.medicationStatement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const QUERIES = [
  // health Q&A
  "what medications am I on?",
  "how's my blood sugar been?",
  "is my cholesterol high?",
  "what conditions do you have on file for me?",
  // briefing
  "what's on my plate?",
  "what do I have coming up?",
  "what should I ask at my cardiology visit?",
  // booking
  "book me a dermatologist",
  "I need to see a cardiologist next week",
  // safety / edge
  "should I increase my metformin dose?",
  "am I going to be okay?",
  "book an appointment for my dad",
];

async function main() {
  console.log(`LLM available: ${llmAvailable()}\n`);
  const op = await seedMember();
  for (const q of QUERIES) {
    const route = await classify(q).catch(() => "?");
    let reply = "";
    try {
      reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, q);
    } catch (err) {
      reply = `ERROR: ${(err as Error).message}`;
    }
    console.log(`──────────────────────────────────────────────`);
    console.log(`Q (${route}): ${q}`);
    console.log(`A: ${reply}\n`);
    // Clear any pending proposal so the next query isn't treated as a confirmation.
    await prisma.agentConversation.updateMany({ where: { userId: op.id }, data: { pendingAction: null, pendingExpiresAt: null } });
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
